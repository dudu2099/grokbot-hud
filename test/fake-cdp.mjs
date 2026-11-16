// A pretend debug port for tests: /json/version, /json/list and just enough WebSocket to answer Runtime.evaluate.
// It records every request, so a test can prove that nothing was opened.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const GROK_BOT_VERSION = {
  Browser: 'Chrome/140.0.0.0',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) GrokBot/1.1.0 Chrome/140.0.0.0 Electron/43.8.9 Safari/537.36',
};
export const EDGE_VERSION = {
  Browser: 'Edg/142.0.3595.53',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.53',
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const payload = Buffer.from(text);
  const head =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x81;
            b[1] = 127;
            b.writeBigUInt64BE(BigInt(payload.length), 2);
            return b;
          })();
  return Buffer.concat([head, payload]);
}

// Reads complete client frames off the buffer; returns [frames, rest].
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 15;
    let length = buffer[offset + 1] & 127;
    let at = offset + 2;
    if (length === 126) {
      if (buffer.length - at < 2) break;
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      if (buffer.length - at < 8) break;
      length = Number(buffer.readBigUInt64BE(at));
      at += 8;
    }
    if (buffer.length - at < 4 + length) break;
    const mask = buffer.subarray(at, at + 4);
    const data = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ opcode, text: data.toString('utf8') });
    offset = at + 4 + length;
  }
  return [frames, buffer.subarray(offset)];
}

// version: what /json/version says. evaluate(expression) -> the value Runtime.evaluate returns.
export async function startFakeDebug({ version = GROK_BOT_VERSION, targets = 1, evaluate = () => null } = {}) {
  const log = { http: [], sockets: 0, methods: [] };
  const server = createServer((request, response) => {
    log.http.push(request.url);
    const { port } = server.address();
    const body =
      request.url === '/json/version'
        ? version
        : request.url === '/json/list'
          ? Array.from({ length: targets }, (_, i) => ({
              id: `T${i}`,
              type: 'page',
              url: 'file:///C:/fake/resources/app.asar/dist/renderer/index.html',
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T${i}`,
            }))
          : null;
    response.setHeader('content-type', 'application/json');
    response.statusCode = body === null ? 404 : 200;
    response.end(JSON.stringify(body ?? {}));
  });
  const open = new Set();
  server.on('upgrade', (request, socket) => {
    log.sockets++;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const [frames, rest] = readFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const { opcode, text } of frames) {
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode !== 1) continue;
        const message = JSON.parse(text);
        log.methods.push(message.method);
        const result = message.method === 'Runtime.evaluate' ? { result: { type: 'object', value: evaluate(message.params.expression) } } : {};
        socket.write(frame(JSON.stringify({ id: message.id, result })));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    log,
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// What overlayApply reports back when it has thinned `panels` panels.
export const overlayReport = (panels) => ({
  token: 'fake',
  deferred: false,
  panels,
  appAppearance: 'dark',
  imageTone: 'dark',
  flipped: false,
  strength: 72,
  strengthSet: false,
});
