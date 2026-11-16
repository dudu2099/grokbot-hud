import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { assertLoopbackWs, evaluateInEveryWindow, LoopbackError, openSession } from '../src/cdp.mjs';

// What the real Grok Bot answered on /json/version, as measured.
const GROK_VERSION = {
  Browser: 'Chrome/140.0.0.0',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) GrokBot/1.1.0 Chrome/140.0.0.0 Electron/43.8.9 Safari/537.36',
};

test('only ws://127.0.0.1:<debug port> passes the loopback guard', () => {
  assert.equal(assertLoopbackWs('ws://127.0.0.1:19222/devtools/page/AB', 19222), 'ws://127.0.0.1:19222/devtools/page/AB');
  const refused = [
    'ws://localhost:19222/devtools/page/AB',
    'ws://127.0.0.1:19223/devtools/page/AB',
    'ws://192.168.1.5:19222/devtools/page/AB',
    'ws://0.0.0.0:19222/devtools/page/AB',
    'ws://[::1]:19222/devtools/page/AB',
    'wss://127.0.0.1:19222/devtools/page/AB',
    'ws://127.0.0.1.evil.example:19222/devtools/page/AB',
    'ws://user:pw@127.0.0.1:19222/devtools/page/AB',
    'http://127.0.0.1:19222/devtools/page/AB',
    undefined,
  ];
  for (const url of refused) assert.throws(() => assertLoopbackWs(url, 19222), LoopbackError, String(url));
});

test('openSession refuses a non-loopback socket before connecting', async () => {
  await assert.rejects(openSession('ws://10.0.0.8:19222/devtools/page/AB', 19222), LoopbackError);
});

test('targets advertising a foreign socket are refused, and non-page targets are skipped', async (t) => {
  const server = createServer((request, response) => {
    const { port } = server.address();
    const targets = [
      { id: 'A', type: 'page', url: 'https://example.test/', webSocketDebuggerUrl: `ws://10.0.0.8:${port}/devtools/page/A` },
      { id: 'B', type: 'webview', url: 'https://example.test/', webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/B` },
      { id: 'C', type: 'service_worker', url: 'https://example.test/sw.js', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/C` },
      { id: 'D', type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/D` },
      { id: 'E', type: 'page', url: 'edge://sync-confirmation-dialog/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/E` },
      { id: 'F', type: 'page', url: 'chrome://settings/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/F` },
    ];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/json/list' ? targets : GROK_VERSION));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const results = await evaluateInEveryWindow(server.address().port, '1');
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['A', false], ['B', false]]);
  assert.ok(results.every((r) => /拒绝连接/.test(r.error)));
});
