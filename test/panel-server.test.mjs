import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLOSED_PANEL_PORT, CLOSED_PORT, PACKS_DIR, tempDir } from './helpers.mjs';

// Ports and the themes folder are read once at import time, so the env has to be set before the server module loads.
process.env.GROKBOT_DEBUG_PORT = CLOSED_PORT;
process.env.GROKBOT_PANEL_PORT = CLOSED_PANEL_PORT;
process.env.GROKBOT_THEMES_DIR = PACKS_DIR;
const { startPanelServer } = await import('../src/panel-server.mjs');
const { openStore } = await import('../src/store.mjs');

async function serve(t) {
  const dispatched = [];
  let quits = 0;
  const server = await startPanelServer({
    port: 0,
    store: openStore(await tempDir('server')),
    dispatch: async (message) => {
      dispatched.push(message);
      return { ok: true };
    },
    quit: () => quits++,
  });
  t.after(() => server.close());
  const self = `127.0.0.1:${server.port}`;
  const call = (method, path, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, method, path, headers: { host: self, ...headers } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  return { self, call, dispatched, quits: () => quits };
}

test('a request addressed to any other Host is refused with 403 before it reaches a handler', async (t) => {
  const { self, call, dispatched } = await serve(t);
  const port = self.split(':')[1];
  for (const host of [`localhost:${port}`, 'evil.example', `evil.example:${port}`, `127.0.0.1:${port}.evil.example`, '127.0.0.1', `[::1]:${port}`]) {
    assert.equal((await call('GET', '/api/state', { headers: { host } })).status, 403, host);
    assert.equal((await call('POST', '/api/apply', { headers: { host }, body: '{"themeId":"paper-light"}' })).status, 403, host);
  }
  assert.deepEqual(dispatched, []);
});

test('a POST from a foreign Origin is refused; same-origin and Origin-less POSTs go through', async (t) => {
  const { self, call, dispatched, quits } = await serve(t);
  const body = '{"themeId":"paper-light"}';
  for (const origin of ['http://evil.example', `http://localhost:${self.split(':')[1]}`, 'null', `https://${self}`]) {
    assert.equal((await call('POST', '/api/apply', { headers: { origin }, body })).status, 403, origin);
    assert.equal((await call('POST', '/api/quit', { headers: { origin } })).status, 403, origin);
  }
  assert.deepEqual(dispatched, []);
  assert.equal(quits(), 0);

  assert.equal((await call('POST', '/api/apply', { headers: { origin: `http://${self}` }, body })).status, 200);
  assert.equal((await call('POST', '/api/restore', {})).status, 200);
  assert.deepEqual(dispatched, [{ type: 'apply', themeId: 'paper-light' }, { type: 'restore' }]);
});

test('bodies over 4 KB and malformed apply bodies are refused without dispatching', async (t) => {
  const { call, dispatched } = await serve(t);
  const big = JSON.stringify({ themeId: 'paper-light', pad: 'x'.repeat(4200) });
  assert.equal((await call('POST', '/api/apply', { body: big })).status, 413);
  assert.equal((await call('POST', '/api/apply', { body: '{"themeId": "../x"}' })).status, 400);
  assert.equal((await call('POST', '/api/apply', { body: 'not json' })).status, 400);
  assert.equal((await call('POST', '/api/apply', { body: '{"type":"restore"}' })).status, 400);
  assert.deepEqual(dispatched, []);
});

test('state lists the themes with thumb links, and a thumb route serves the pack file', async (t) => {
  const { call } = await serve(t);
  const state = JSON.parse((await call('GET', '/api/state')).body);
  assert.deepEqual(state, {
    themes: [
      { id: 'night-harbor', name: '夜港（占位）', appearance: 'dark', accent: '#8ab4ff', thumb: '/thumb/night-harbor' },
      { id: 'paper-light', name: '素笺（占位）', appearance: 'light', accent: '#b5651d', thumb: null },
    ],
    lastApplied: null,
    debug: false,
    debugState: 'closed',
  });
  assert.deepEqual(JSON.parse((await call('GET', '/api/hello')).body), { service: 'grokbot-wallpaper-panel' });
  const thumb = await call('GET', '/thumb/night-harbor');
  assert.equal(thumb.type, 'image/png');
  assert.deepEqual(thumb.body, await readFile(join(PACKS_DIR, 'night-harbor', 'thumb.png')));
  assert.equal((await call('GET', '/thumb/paper-light')).status, 404);
  assert.equal((await call('GET', '/')).status, 200);
});

test('quit answers first, then asks the owner to stop', async (t) => {
  const { call, quits } = await serve(t);
  const response = await call('POST', '/api/quit');
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quits(), 1);
});
