#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { evaluate, openSession } from '../src/cdp.mjs';
import { MARK } from '../src/overlay.mjs';
import { PANEL_BINDING } from '../src/panel.mjs';
import { loadThemes, wallpaperDataUrl } from '../src/themes.mjs';
import { cli, ENTRY, FIXTURE, killTree, PACKS_DIR, SHOTS, startStandin, e2ePort } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const SELF = `127.0.0.1:${PANEL_PORT}`;
const ACCENT_RGB = { 'night-harbor': 'rgb(138, 180, 255)', 'paper-light': 'rgb(181, 101, 29)' };

const results = [];
function check(ok, label, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ''}`);
}

const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

async function waitFor(read, ok, timeoutMs) {
  const started = Date.now();
  let value = await read();
  while (!ok(value) && Date.now() - started < timeoutMs) {
    await sleep(100);
    value = await read();
  }
  return { value, ok: ok(value), ms: Date.now() - started };
}

function rawHttp(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PANEL_PORT, method, path, headers: { host: SELF, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function inspectOverlay(slices, mark) {
  const image = document.querySelector(`[${mark.attr}="image"]`);
  const background = image ? image.style.backgroundImage : '';
  return {
    layers: document.querySelectorAll(`[${mark.attr}="layer"]`).length,
    wallpaper: Object.keys(slices).find((id) => background.includes(slices[id])) ?? null,
    token: window[mark.key]?.token ?? null,
    hosts: document.querySelectorAll(`[${mark.attr}="panel"]`).length,
    layerAdds: window.__e2eLayerAdds ?? null,
  };
}

function panelShadowReport() {
  const rect = (part) => {
    const node = this.querySelector(`[data-part="${part}"]`);
    if (!node || node.hidden) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  };
  const pressed = this.querySelector('[data-part="item"][aria-pressed="true"]');
  return {
    collapsed: this.querySelector('[data-part="card"]').hidden && !this.querySelector('[data-part="fab"]').hidden,
    selected: [...this.querySelectorAll('[data-part="item"][aria-pressed="true"]')].map((node) => node.dataset.id),
    mode: this.querySelector('[data-part="shell"]').dataset.mode,
    ring: pressed ? getComputedStyle(pressed).boxShadow : null,
    card: rect('card'),
    header: rect('header'),
    collapse: rect('collapse'),
    fab: rect('fab'),
  };
}

// The panel lives in a closed shadow root, so the page itself cannot look inside; DevTools' DOM domain can.
async function panelOf(session) {
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const hosts = [];
  const walk = (node) => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === MARK.attr && attrs[i + 1] === 'panel') hosts.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  if (hosts.length !== 1) return { count: hosts.length };
  const shadow = hosts[0].shadowRoots?.[0];
  const { object } = await session.send('DOM.resolveNode', { nodeId: shadow.nodeId });
  const { result } = await session.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: panelShadowReport.toString(),
    returnByValue: true,
  });
  return { count: 1, shadowType: shadow.shadowRootType, ...result.value };
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-e2e-watch-'));
  const dataDir = join(scratch, 'data');
  const env = {
    GROKBOT_DEBUG_PORT: String(PORT),
    GROKBOT_PANEL_PORT: String(PANEL_PORT),
    GROKBOT_DATA_DIR: dataDir,
    GROKBOT_THEMES_DIR: PACKS_DIR,
    // The stand-in is a headless Edge, not Grok Bot; this test-only switch lets it through on the test port.
    GROKBOT_ALLOW_STANDIN: '1',
    GROKBOT_STARTUP_DIR: join(scratch, 'startup'),
  };
  if (await listening(PANEL_PORT)) throw new Error(`面板端口 ${PANEL_PORT} 已被占用，换个空闲端口再跑`);
  let standin;
  let daemon;
  const daemonLog = [];
  try {
    standin = await startStandin(PORT, join(scratch, 'profile'));
    console.log(`stand-in: ${standin.browser} (pid ${standin.pid}) on 127.0.0.1:${PORT}`);
    daemon = spawn(process.execPath, [ENTRY, 'watch'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    daemon.exited = new Promise((resolve) => daemon.once('exit', (code) => resolve(code)));
    for (const stream of [daemon.stdout, daemon.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (text) => daemonLog.push(...text.split('\n').filter(Boolean)));
    }
    console.log(`daemon: watch (pid ${daemon.pid}) on ${SELF}`);
    await run({ env, dataDir, target: standin.target, daemon, daemonLog });
  } finally {
    if (daemon && daemon.exitCode === null) killTree(daemon.pid);
    if (standin) killTree(standin.pid);
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(`daemon log:\n${daemonLog.map((line) => `      ${line}`).join('\n')}`);
    console.log(`cleanup: daemon exit code ${daemon?.exitCode}, killed stand-in tree ${standin?.pid}, removed ${scratch} (exists now: ${existsSync(scratch)})`);
  }
}

async function run({ env, dataDir, target, daemon, daemonLog }) {
  const up = await waitFor(() => listening(PANEL_PORT), Boolean, 8000);
  check(up.ok, `watch is listening on ${SELF}`, up);
  const attached = await waitFor(() => daemonLog.some((line) => line.includes(`已接上窗口 ${target.id}`)), Boolean, 5000);
  check(attached.ok, 'watch attached to the stand-in window on its own', daemonLog);

  const seenTargets = new Map();
  const poller = setInterval(async () => {
    const raw = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
    for (const t of raw) if (!seenTargets.has(t.id)) seenTargets.set(t.id, `${t.type} ${String(t.url).slice(0, 48)}`);
  }, 300);

  const { themes } = await loadThemes(PACKS_DIR);
  const slices = Object.fromEntries(await Promise.all(themes.map(async (t) => [t.id, (await wallpaperDataUrl(t)).slice(1000, 1064)])));
  const probe = await openSession(target.wsUrl, PORT);
  const overlayOf = (session) => evaluate(session, `(${inspectOverlay})(${JSON.stringify(slices)}, ${JSON.stringify(MARK)})`);
  const stateOf = async (session) => ({ ...(await overlayOf(session)), panel: await panelOf(session) });
  const readStore = async (name) => JSON.parse(await readFile(join(dataDir, name), 'utf8').catch(() => 'null'));
  async function reload(session) {
    await session.send('Page.reload');
    await sleep(300);
    while ((await evaluate(session, 'document.readyState').catch(() => 'loading')) !== 'complete') await sleep(100);
  }
  async function screenshot(session, name) {
    await session.send('Page.bringToFront');
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log(`      screenshot: docs/verify/${name}`);
  }
  const mouse = (type, x, y, extra = {}) => probe.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  async function click(x, y) {
    await mouse('mousePressed', x, y, { buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', x, y, { buttons: 0, clickCount: 1 });
  }
  const themed = (id) => (s) => s.layers === 1 && s.wallpaper === id && s.panel.count === 1 && s.panel.selected?.[0] === id;
  const clean = (s) => s.layers === 0 && s.hosts === 0 && s.token === null;

  let state = await stateOf(probe);
  check(clean(state), 'baseline: no wallpaper layer and no panel', state);

  await evaluate(
    probe,
    `window.__e2eLayerAdds = 0; new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.getAttribute?.('${MARK.attr}') === 'layer') window.__e2eLayerAdds++; }).observe(document.documentElement, { childList: true })`,
  );
  let r = await cli(['apply', 'night-harbor', '--no-daemon'], env);
  check(r.code === 0 && !('daemon' in JSON.parse(r.stdout)), 'CLI apply night-harbor --no-daemon exits 0 and starts nothing', r);
  let wait = await waitFor(() => stateOf(probe), themed('night-harbor'), 3000);
  check(wait.ok, `within 3s of the CLI apply the page has the night-harbor overlay and exactly one panel (took ${wait.ms} ms)`, wait.value);
  check(wait.value.panel.shadowType === 'closed', 'panel sits in a closed shadow root', wait.value.panel);
  check(wait.value.layerAdds === 1, "watch's sync of the CLI's record did not re-create the wallpaper layer (no flicker)", wait.value);
  check(wait.value.panel.mode === 'dark' && wait.value.panel.ring?.includes(ACCENT_RGB['night-harbor']), 'panel follows the dark stand-in and rings night-harbor in its accent', wait.value.panel);

  await reload(probe);
  wait = await waitFor(() => stateOf(probe), themed('night-harbor'), 3000);
  check(wait.ok, `reload: overlay and panel come back with no CLI call (took ${wait.ms} ms after load)`, wait.value);

  const opened = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${FIXTURE}`, { method: 'PUT' })).json();
  const second = await openSession(opened.webSocketDebuggerUrl, PORT);
  wait = await waitFor(() => stateOf(second).catch(() => ({})), themed('night-harbor'), 6000);
  check(wait.ok, `second tab gets the overlay and one panel on its own (took ${wait.ms} ms)`, wait.value);

  await evaluate(probe, `window.${PANEL_BINDING}(JSON.stringify({ type: 'apply', themeId: 'paper-light' }))`);
  wait = await waitFor(() => stateOf(probe), themed('paper-light'), 3000);
  check(wait.ok, `panel apply paper-light: wallpaper swapped and paper-light selected (took ${wait.ms} ms)`, wait.value);
  check(wait.value.panel.ring?.includes(ACCENT_RGB['paper-light']), 'selected ring uses the paper-light accent', wait.value.panel);
  let stored = await readStore('last-applied.json');
  check(stored?.themeId === 'paper-light' && stored.restored === false, 'last-applied.json says paper-light, not restored', stored);
  wait = await waitFor(() => stateOf(second), themed('paper-light'), 3000);
  check(wait.ok, 'second tab follows the panel apply', wait.value);

  async function dragHeader(delta) {
    const card = (await panelOf(probe)).card;
    const grab = { x: card.x + 40, y: card.y + 14 };
    await mouse('mousePressed', grab.x, grab.y, { buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 10; step++) {
      await mouse('mouseMoved', grab.x + (delta.x * step) / 10, grab.y + (delta.y * step) / 10, { buttons: 1 });
    }
    await mouse('mouseReleased', grab.x + delta.x, grab.y + delta.y, { buttons: 0, clickCount: 1 });
    return card;
  }

  await dragHeader({ x: -3000, y: -3000 });
  let moved = await panelOf(probe);
  check(moved.card.x === 8 && moved.card.y === 8, 'dragging far past the top-left corner stops the card 8px inside the viewport', moved.card);

  const delta = { x: 574, y: 228 };
  const before = await dragHeader(delta);
  const expected = { x: Math.round(before.x + delta.x), y: Math.round(before.y + delta.y) };
  moved = await panelOf(probe);
  check(
    Math.round(moved.card.x) === expected.x && Math.round(moved.card.y) === expected.y,
    `pointer drag moved the card from (${Math.round(before.x)}, ${Math.round(before.y)}) to (${expected.x}, ${expected.y})`,
    moved.card,
  );
  wait = await waitFor(() => readStore('panel.json'), (p) => p?.x === expected.x && p?.y === expected.y && p.collapsed === false, 3000);
  check(wait.ok, 'panel.json records the dragged position', wait.value);
  await screenshot(probe, 'standin-panel-expanded.png');

  await click(moved.collapse.x + moved.collapse.w / 2, moved.collapse.y + moved.collapse.h / 2);
  moved = await panelOf(probe);
  check(moved.collapsed && moved.fab?.x === expected.x && moved.fab?.y === expected.y, 'collapse button turns the card into the round button at the same spot', moved);
  wait = await waitFor(() => readStore('panel.json'), (p) => p?.collapsed === true && p.x === expected.x, 3000);
  check(wait.ok, 'panel.json records collapsed', wait.value);
  await screenshot(probe, 'standin-panel-collapsed.png');

  await reload(probe);
  wait = await waitFor(() => stateOf(probe), (s) => s.panel.count === 1 && s.panel.collapsed && s.panel.fab?.x === expected.x && s.panel.fab?.y === expected.y, 3000);
  check(wait.ok, 'after reload the panel comes back collapsed at the saved position', wait.value);

  const fab = wait.value.panel.fab;
  await click(fab.x + fab.w / 2, fab.y + fab.h / 2);
  moved = await panelOf(probe);
  check(!moved.collapsed && moved.card?.x === expected.x && moved.card?.y === expected.y, 'clicking the round button expands the card in place', moved);

  await evaluate(probe, `window.${PANEL_BINDING}(JSON.stringify({ type: 'panel', x: 99999, y: 99999, collapsed: false }))`);
  await waitFor(() => readStore('panel.json'), (p) => p?.x === 99999, 3000);
  await reload(probe);
  const viewport = await evaluate(probe, '[innerWidth, innerHeight]');
  wait = await waitFor(() => panelOf(probe), (p) => p.count === 1 && p.card !== null, 3000);
  const corner = wait.value.card;
  check(
    corner && Math.abs(corner.x - (viewport[0] - corner.w - 8)) < 1 && Math.abs(corner.y - (viewport[1] - corner.h - 8)) < 1,
    `a saved position outside the window is clamped on mount (card at ${corner?.x}, ${corner?.y} in ${viewport.join('x')})`,
    { corner, viewport },
  );

  await evaluate(probe, `window.${PANEL_BINDING}(JSON.stringify({ type: 'restore' }))`);
  wait = await waitFor(async () => [await overlayOf(probe), await overlayOf(second)], (pair) => pair.every(clean), 3000);
  check(wait.ok, `panel restore: overlay and panel gone in both tabs (took ${wait.ms} ms)`, wait.value);
  stored = await readStore('last-applied.json');
  check(stored?.themeId === 'paper-light' && stored.restored === true, 'last-applied.json says restored', stored);
  await reload(probe);
  await sleep(1500);
  state = await overlayOf(probe);
  check(clean(state), 'reload after restore stays clean', state);

  r = await rawHttp('GET', '/api/state', { host: `evil.example:${PANEL_PORT}` });
  check(r.status === 403, 'GET with a foreign Host header: 403', r);
  r = await rawHttp('GET', '/api/state', { host: `localhost:${PANEL_PORT}` });
  check(r.status === 403, 'GET with Host localhost (not the exact loopback origin): 403', r);
  r = await rawHttp('POST', '/api/apply', { origin: 'http://evil.example', 'content-type': 'application/json' }, '{"themeId":"night-harbor"}');
  check(r.status === 403, 'POST /api/apply from a foreign Origin: 403', r);
  r = await rawHttp('POST', '/api/quit', { origin: 'https://grok.com' });
  check(r.status === 403, 'POST /api/quit from a foreign Origin: 403', r);
  stored = await readStore('last-applied.json');
  check(stored?.restored === true && (await listening(PANEL_PORT)), 'refused requests changed nothing and watch is still up', stored);
  const listeners = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-NetTCPConnection -State Listen -LocalPort ${PANEL_PORT} | ForEach-Object { $_.LocalAddress + ' pid ' + $_.OwningProcess }`],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/);
  console.log(`      Get-NetTCPConnection -LocalPort ${PANEL_PORT}: ${listeners.join(' | ')}`);
  check(listeners.length === 1 && listeners[0] === `127.0.0.1 pid ${daemon.pid}`, `the only listener on ${PANEL_PORT} is watch on 127.0.0.1`, listeners);

  r = await rawHttp('POST', '/api/apply', { origin: `http://${SELF}`, 'content-type': 'application/json' }, '{"themeId":"night-harbor"}');
  check(r.status === 200 && JSON.parse(r.body).ok === true, 'same-origin POST /api/apply night-harbor: 200 ok', r);
  wait = await waitFor(() => stateOf(probe), themed('night-harbor'), 3000);
  check(wait.ok, 'HTTP apply put the overlay and panel back', wait.value);

  r = await rawHttp('POST', '/api/quit');
  check(r.status === 200, 'POST /api/quit: 200', r);
  const exitCode = await Promise.race([daemon.exited, sleep(5000).then(() => 'still running')]);
  check(exitCode === 0, 'watch exits with code 0 after quit', exitCode);
  check(!(await listening(PANEL_PORT)), `port ${PANEL_PORT} is free again`);
  state = await overlayOf(probe);
  check(state.hosts === 0 && state.layers === 1, 'on stop the dead panel is taken out and the wallpaper stays until reload', state);

  clearInterval(poller);
  const attachedIds = [...new Set(daemonLog.map((line) => /已接上窗口 (\S+)/.exec(line)?.[1]).filter(Boolean))].sort();
  check(
    JSON.stringify(attachedIds) === JSON.stringify([target.id, opened.id].sort()),
    "watch attached to the two stand-in tabs and nothing else (the browser's own edge:// pages are skipped)",
    attachedIds.map((id) => `${id.slice(0, 8)} ${seenTargets.get(id) ?? '?'}`),
  );

  await second.close();
  await probe.close();
}

await main();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
