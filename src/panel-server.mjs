import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { identifyDebug, usableDebug } from './cdp.mjs';
import { UserError } from './errors.mjs';
import { parsePanelMessage } from './panel.mjs';
import { HOST, PORTS } from './ports.mjs';
import { loadApplicableThemes } from './custom.mjs';

const MAX_BODY_BYTES = 4096;
// What GET /api/hello answers. The CLI asks for it before it treats a taken panel port as its own watch, or tells it to quit.
export const PANEL_SERVICE = 'grokbot-wallpaper-panel';
const THUMB_ROUTE = /^\/thumb\/([a-z0-9-]+)$/;
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const PAGE_CSP =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(response, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  response.writeHead(status, { ...BASE_HEADERS, 'content-type': type, 'content-length': payload.length, ...extra });
  response.end(payload);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      reject(new HttpError(413, `请求体不能超过 ${MAX_BODY_BYTES} 字节`));
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) reject(new HttpError(413, `请求体不能超过 ${MAX_BODY_BYTES} 字节`));
      else chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
  });
}

async function themeList(store) {
  const { themes } = await loadApplicableThemes(store.dir);
  return themes;
}

const ROUTES = {
  'GET /': async () => ({ type: 'text/html; charset=utf-8', body: PAGE, headers: { 'content-security-policy': PAGE_CSP } }),
  'GET /api/state': async ({ store }) => {
    const [themes, lastApplied, identity] = await Promise.all([themeList(store), store.readLastApplied(), identifyDebug(PORTS.debug)]);
    const view = themes.map((t) => ({
      id: t.id,
      name: t.name,
      appearance: t.appearance,
      accent: t.accent ?? null,
      thumb: t.thumbPath === null ? null : `/thumb/${t.id}`,
    }));
    return { body: { themes: view, lastApplied, debug: usableDebug(identity), debugState: identity.state } };
  },
  'GET /api/hello': async () => ({ body: { service: PANEL_SERVICE } }),
  'POST /api/apply': async ({ dispatch }, request) => {
    const body = await readJsonBody(request);
    const message = parsePanelMessage({ ...body, type: 'apply' });
    if (message === null) throw new HttpError(400, '需要 {"themeId": "<主题 id>"}');
    return { body: await dispatch(message) };
  },
  'POST /api/restore': async ({ dispatch }, request) => {
    await readJsonBody(request);
    return { body: await dispatch({ type: 'restore' }) };
  },
  'POST /api/quit': async ({ quit }, request) => {
    await readJsonBody(request);
    return { body: { ok: true }, after: quit };
  },
};

async function thumb(store, id) {
  const theme = (await themeList(store)).find((t) => t.id === id);
  if (!theme || theme.thumbPath === null) throw new HttpError(404, '没有这张预览图');
  return { type: theme.thumbMime, body: await readFile(theme.thumbPath) };
}

// Exactly this loopback origin or nothing: a page served from any other host name (DNS rebinding) or origin is refused.
function refusal(request, self) {
  if (request.headers.host !== self) return 'Host 必须是 ' + self;
  const origin = request.headers.origin;
  if (request.method === 'POST' && origin !== undefined && origin !== `http://${self}`) return '不接受其他网页发来的请求';
  return null;
}

async function handle(request, response, context, self) {
  const refused = refusal(request, self);
  if (refused) return send(response, 403, { ok: false, error: refused });
  const path = new URL(request.url, `http://${self}`).pathname;
  const thumbId = request.method === 'GET' ? THUMB_ROUTE.exec(path)?.[1] : undefined;
  const route = thumbId ? () => thumb(context.store, thumbId) : ROUTES[`${request.method} ${path}`];
  if (!route) return send(response, 404, { ok: false, error: '没有这个地址' });
  try {
    const { type, body, headers, after } = await route(context, request);
    send(response, 200, body, type, headers);
    if (after) response.once('finish', after);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    send(response, status, { ok: false, error: error.message }, undefined, status === 413 ? { connection: 'close' } : {});
  }
}

export function startPanelServer({ port = PORTS.panel, store, dispatch, quit }) {
  return new Promise((resolve, reject) => {
    let self = `${HOST}:${port}`;
    const server = createServer((request, response) => {
      handle(request, response, { store, dispatch, quit }, self).catch(() => response.destroy());
    });
    server.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') return reject(error);
      reject(
        new UserError(
          `面板端口 ${HOST}:${port} 已被占用，可能已经有一个 watch 或 panel 在跑（status 里 panel 为 true）。没有换用别的端口。`,
        ),
      );
    });
    server.listen(port, HOST, () => {
      self = `${HOST}:${server.address().port}`;
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// Runs the panel server in the foreground until POST /api/quit, Ctrl+C or SIGTERM. The taken port is the single-instance guard.
export async function servePanel({ store, dispatch, onStart = () => {}, onStop = async () => {}, log }) {
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  let stopping = null;
  let server = null;
  const stop = () =>
    (stopping ??= (async () => {
      await onStop();
      await server?.close();
      finish();
    })());
  server = await startPanelServer({ store, dispatch, quit: stop });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log(`面板：http://${HOST}:${server.port}/`);
  // The caller gets the same stop that /api/quit and Ctrl+C use.
  onStart(stop);
  await finished;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grok Bot 换壁纸</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --card: #fff; --fg: #1d1f24; --muted: #6b6f78; --line: rgba(0,0,0,.09); }
  @media (prefers-color-scheme: dark) { :root { --bg: #15171c; --card: #1e2128; --fg: #eceef2; --muted: #9aa0ab; --line: rgba(255,255,255,.1); } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: start center; padding: 40px 16px;
    background: var(--bg); color: var(--fg); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { width: min(100%, 320px); background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  .item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 9px; text-align: left; }
  .item:hover { background: var(--line); }
  .item[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 16%, transparent); box-shadow: inset 0 0 0 1.5px var(--accent); }
  .thumb { width: 52px; height: 34px; border-radius: 6px; flex: none; background: center / cover no-repeat var(--accent); }
  .name { flex: 1; }
  .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 9px; padding: 0 6px; }
  footer { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
  #msg { font-size: 12px; color: var(--muted); }
  #restore { font-size: 12px; color: var(--muted); padding: 4px 6px; border-radius: 6px; }
  #restore:hover { color: var(--fg); background: var(--line); }
</style>
</head>
<body>
<main>
  <h1>换壁纸</h1>
  <p id="debug">正在读取状态</p>
  <ul id="list"></ul>
  <footer><span id="msg"></span><button id="restore" type="button">恢复原样</button></footer>
</main>
<script>
  const TAG = { dark: '深', light: '浅' };
  const $ = (id) => document.getElementById(id);
  async function post(path, body) {
    $('msg').textContent = '处理中';
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const result = await response.json();
    $('msg').textContent = result.ok ? '好了' : (result.error || '没成功');
    await load();
  }
  async function load() {
    const state = await (await fetch('/api/state')).json();
    const current = state.lastApplied && !state.lastApplied.restored ? state.lastApplied.themeId : null;
    $('debug').textContent = state.debug
      ? 'Grok Bot 的调试口开着，点一下就换。'
      : state.debugState === 'other'
        ? '调试口上应答的不是 Grok Bot，是别的程序，点了不会生效。'
        : 'Grok Bot 的调试口没开，现在点了不会生效。';
    $('list').replaceChildren(...state.themes.map((theme) => {
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'item';
      item.setAttribute('aria-pressed', String(theme.id === current));
      item.style.setProperty('--accent', theme.accent || '#7c8cff');
      const thumb = document.createElement('span');
      thumb.className = 'thumb';
      if (theme.thumb) thumb.style.backgroundImage = 'url("' + theme.thumb + '")';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = theme.name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = TAG[theme.appearance];
      item.append(thumb, name, tag);
      item.addEventListener('click', () => post('/api/apply', { themeId: theme.id }));
      li.append(item);
      return li;
    }));
  }
  $('restore').addEventListener('click', () => post('/api/restore'));
  load();
</script>
</body>
</html>
`;
