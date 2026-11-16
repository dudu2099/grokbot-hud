import { DEFAULT_DEBUG_PORT, HOST } from './ports.mjs';

const HTTP_TIMEOUT_MS = 1500;
const WS_OPEN_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 15000;
const INJECTABLE_TYPES = new Set(['page', 'webview']);
// Browser-internal pages (DevTools, settings dialogs, extensions) are never app windows and never get a theme.
const INTERNAL_URL = /^(devtools|chrome|edge|chrome-extension|chrome-untrusted):/i;

export class LoopbackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoopbackError';
  }
}

export function assertLoopbackWs(wsUrl, port) {
  let url;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new LoopbackError('拒绝连接：调试口给出的窗口地址无效（可能已被别的调试工具占用）');
  }
  const exact = url.protocol === 'ws:' && url.hostname === HOST && url.port === String(port);
  if (!exact || url.username || url.password) {
    throw new LoopbackError(`拒绝连接 ${url.protocol}//${url.host}：只允许 ws://${HOST}:${port}`);
  }
  return url.href;
}

async function getJson(port, path) {
  const response = await fetch(`http://${HOST}:${port}${path}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
  return response.json();
}

// Measured on the real app: /json/version's User-Agent carries both "GrokBot/1.1.0" and "Electron/43.8.9".
const GROK_BOT_UA = [/\bGrokBot\//, /\bElectron\//];
// GROKBOT_ALLOW_STANDIN exists for tests only, so the self-tests can drive a headless Edge on a test port.
// It is never honored on the real app's default port.
const standinAllowed = (port) => process.env.GROKBOT_ALLOW_STANDIN === '1' && port !== DEFAULT_DEBUG_PORT;

// Who answers on the debug port: { state: 'closed' | 'grokbot' | 'other' | 'standin', reportedAs }.
// 'standin' is an 'other' that the test switch lets through; only 'grokbot' and 'standin' may be touched.
export async function identifyDebug(port) {
  let version;
  try {
    version = await getJson(port, '/json/version');
  } catch {
    return { state: 'closed', reportedAs: null };
  }
  const userAgent = typeof version?.['User-Agent'] === 'string' ? version['User-Agent'] : '';
  const reportedAs = (typeof version?.Browser === 'string' && version.Browser) || userAgent || '（它没有报名字）';
  if (GROK_BOT_UA.every((pattern) => pattern.test(userAgent))) return { state: 'grokbot', reportedAs };
  return { state: standinAllowed(port) ? 'standin' : 'other', reportedAs };
}

export const usableDebug = (identity) => identity.state === 'grokbot' || identity.state === 'standin';

export class NotGrokBotError extends Error {
  constructor(port, reportedAs) {
    super(notGrokBotMessage(port, reportedAs));
    this.name = 'NotGrokBotError';
    this.reportedAs = reportedAs;
  }
}

export const notGrokBotMessage = (port, reportedAs) =>
  `${HOST}:${port} 上应答的不是 Grok Bot，是别的程序（它自报「${reportedAs}」），所以什么都没有改。`;

export async function probeDebug(port) {
  return (await identifyDebug(port)).state !== 'closed';
}

export async function listTargets(port) {
  const raw = await getJson(port, '/json/list');
  return raw
    .filter((target) => INJECTABLE_TYPES.has(target.type) && !INTERNAL_URL.test(String(target.url)))
    .map((target) => ({ id: target.id, type: target.type, wsUrl: target.webSocketDebuggerUrl }));
}

export async function openSession(wsUrl, port) {
  const url = assertLoopbackWs(wsUrl, port);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    const closeHandlers = [];
    let nextId = 0;

    const openTimer = setTimeout(() => {
      reject(new Error('连接调试口超时'));
      ws.close();
    }, WS_OPEN_TIMEOUT_MS);

    const settle = (id, settleWith) => {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      clearTimeout(call.timer);
      settleWith(call);
    };

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        for (const handler of listeners.get(message.method) ?? []) handler(message.params ?? {});
        return;
      }
      settle(message.id, (call) =>
        message.error ? call.reject(new Error(`${call.method}: ${message.error.message}`)) : call.resolve(message.result),
      );
    });
    ws.addEventListener('close', () => {
      for (const id of [...pending.keys()]) settle(id, (call) => call.reject(new Error('调试连接已断开')));
      for (const handler of closeHandlers.splice(0)) handler();
    });
    ws.addEventListener('error', () => {
      clearTimeout(openTimer);
      reject(new Error('连不上调试口的 WebSocket'));
    });
    ws.addEventListener('open', () => {
      clearTimeout(openTimer);
      resolve({
        send(method, params = {}) {
          return new Promise((resolveCall, rejectCall) => {
            const id = ++nextId;
            const timer = setTimeout(() => settle(id, (call) => call.reject(new Error(`${method} 超时`))), CALL_TIMEOUT_MS);
            pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, handler) {
          listeners.set(method, [...(listeners.get(method) ?? []), handler]);
        },
        onClose(handler) {
          if (ws.readyState === WebSocket.CLOSED) handler();
          else closeHandlers.push(handler);
        },
        close() {
          if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
          return new Promise((done) => {
            ws.addEventListener('close', () => done(), { once: true });
            ws.close();
          });
        },
      });
    });
  });
}

export async function evaluate(session, expression) {
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(`页面里执行出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
  return result.value;
}

// The only way into the app's windows for the one-shot commands: nothing is listed or opened unless Grok Bot answered.
export async function grokBotTargets(port) {
  const identity = await identifyDebug(port);
  if (identity.state === 'closed') return [];
  if (!usableDebug(identity)) throw new NotGrokBotError(port, identity.reportedAs);
  return listTargets(port);
}

export async function evaluateInEveryWindow(port, expression) {
  const targets = await grokBotTargets(port);
  return Promise.all(
    targets.map(async ({ id, type, wsUrl }) => {
      try {
        const session = await openSession(wsUrl, port);
        try {
          return { id, type, ok: true, value: await evaluate(session, expression) };
        } finally {
          await session.close();
        }
      } catch (error) {
        return { id, type, ok: false, error: error.message };
      }
    }),
  );
}
