#!/usr/bin/env node
// End to end on a light stand-in that mirrors the real Grok Bot's measured colors:
// same-side white cards thin out, the opposite dark bubble and the composer frame stay solid,
// the user's own picture goes in from the CLI and from the panel, and the strength slider works in place.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import { evaluate, openSession } from '../src/cdp.mjs';
import { MARK } from '../src/overlay.mjs';
import { cli, e2ePort, ENTRY, FIXTURE_LIGHT, killTree, PACKS_DIR, SHOTS, startStandin } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const WATCHED = ['html', 'body', '#side', '#main', '#rail', '#card', '#cardInner', '#card2', '#answer', '#mine', '#composerBox', '#composer'];
const SURFACES = ['#side', '#main', '#rail', '#card', '#card2'];
const LEFT_ALONE = ['#answer', '#mine', '#composerBox', '#composer'];

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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A real, decodable PNG. level 0 stores the pixels uncompressed, which is how the test picks its file size.
function png(width, height, pixel, level) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) raw.set(pixel(x / width, y / height), row + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const mix = (a, b, t) => a.map((value, i) => Math.round(value + (b[i] - value) * t));
const IMAGES = {
  // CLI test picture: a small teal-to-amber diagonal.
  cli: { name: 'cli-teal.png', bytes: () => png(960, 600, (u, v) => mix([24, 120, 130], [236, 170, 70], (u + v) / 2), 9) },
  // Panel test picture: about 3 MB, stored uncompressed. Violet dusk with soft bands.
  panel: {
    name: 'panel-dusk.png',
    bytes: () => png(1280, 800, (u, v) => mix(mix([70, 50, 140], [235, 120, 150], u), [255, 214, 170], v * 0.6 + 0.08 * Math.sin(u * 18)), 0),
  },
  // One flat navy background with an orange disc in the middle: the kind of picture the reading lane is for.
  poster: { name: 'poster-flat.png', bytes: () => png(640, 400, (u, v) => ((u - 0.5) ** 2 * 2.56 + (v - 0.5) ** 2 < 0.04 ? [228, 150, 70] : [32, 44, 52]), 0) },
  // A night scene: a dark sky that drifts from near black to deep blue, with a pale moon. Dark, but not one flat color.
  night: { name: 'night-sky.png', bytes: () => png(640, 400, (u, v) => ((u - 0.7) ** 2 * 2.56 + (v - 0.4) ** 2 < 0.02 ? [210, 215, 230] : mix([10, 12, 20], [26, 30, 48], v * 0.8 + u * 0.2)), 0) },
  // Over the 4 MB limit.
  huge: { name: 'too-big.png', bytes: () => png(1400, 1000, (u) => mix([10, 10, 10], [200, 200, 200], u), 0) },
};

function alphaOf(color) {
  if (color === 'transparent') return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
  const parts = /^rgba?\(([^)]*)\)$/.exec(color)?.[1].split(',');
  return parts?.length === 4 ? Number(parts[3]) : 1;
}

function inspectPage(watched, slices, mark) {
  const image = document.querySelector(`[${mark.attr}="image"]`);
  const layer = document.querySelector(`[${mark.attr}="layer"]`);
  const background = image ? image.style.backgroundImage : '';
  const describe = (selector) => {
    const node = document.querySelector(selector);
    return node && { style: node.getAttribute('style'), bg: getComputedStyle(node).backgroundColor };
  };
  return {
    layers: document.querySelectorAll(`[${mark.attr}="layer"]`).length,
    layerTag: layer?.__e2eTag ?? null,
    layerAdds: window.__e2eLayerAdds ?? null,
    wallpaper: Object.keys(slices).find((id) => background.includes(slices[id])) ?? null,
    token: window[mark.key]?.token ?? null,
    report: window[mark.key]?.inspect() ?? null,
    elements: Object.fromEntries(watched.map((selector) => [selector, describe(selector)])),
  };
}

function panelShadowReport() {
  const rect = (part) => {
    const node = this.querySelector(`[data-part="${part}"]`);
    if (!node || node.hidden) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  };
  const status = this.querySelector('[data-part="status"]');
  return {
    items: [...this.querySelectorAll('[data-part="item"]')].map((node) => ({
      id: node.dataset.id,
      name: node.querySelector('[data-part="name"]').textContent,
      pressed: node.getAttribute('aria-pressed') === 'true',
      thumb: node.querySelector('[data-part="thumb"]').style.backgroundImage.length > 0,
    })),
    pickText: this.querySelector('[data-part="pick"]')?.textContent ?? null,
    picker: (() => {
      const input = this.querySelector('[data-part="picker"]');
      return input && { type: input.type, accept: input.accept, hidden: input.hidden };
    })(),
    slider: Number(this.querySelector('[data-part="slider"]')?.value),
    sliderText: this.querySelector('[data-part="strength-value"]')?.textContent ?? null,
    status: status && !status.hidden ? { tone: status.dataset.tone, text: status.textContent } : null,
    card: rect('card'),
    sliderRect: rect('slider'),
    pick: rect('pick'),
    list: rect('list'),
    footer: rect('footer'),
  };
}

function walkPanel(root) {
  const hosts = [];
  const walk = (node) => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === MARK.attr && attrs[i + 1] === 'panel') hosts.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  return hosts;
}

function findPart(node, part) {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'data-part' && attrs[i + 1] === part) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const hit = findPart(child, part);
    if (hit) return hit;
  }
  return null;
}

// The panel lives in a closed shadow root; DevTools' DOM domain can still see inside.
// watch remounts the panel after every sync, so a read can race a remount; that read just reports no panel and is retried.
async function panelOf(session) {
  try {
    return await panelOnce(session);
  } catch (error) {
    return { count: -1, error: error.message };
  }
}

async function panelOnce(session) {
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const hosts = walkPanel(root);
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

// Hands a file to the hidden picker the way the system dialog would, then fires change on it.
async function pickFile(session, path) {
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const [host] = walkPanel(root);
  const input = findPart(host.shadowRoots[0], 'picker');
  await session.send('DOM.setFileInputFiles', { files: [path], nodeId: input.nodeId });
  const { object } = await session.send('DOM.resolveNode', { nodeId: input.nodeId });
  await session.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { this.dispatchEvent(new Event("change", { bubbles: true })); }',
  });
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-e2e-custom-'));
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
  const files = {};
  await mkdir(join(scratch, 'pics'));
  for (const [key, { name, bytes }] of Object.entries(IMAGES)) {
    const data = bytes();
    files[key] = { path: join(scratch, 'pics', name), bytes: data, sha: sha256(data) };
    await writeFile(files[key].path, data);
  }
  console.log(`test pictures: ${Object.entries(files).map(([k, f]) => `${k} ${f.bytes.length} bytes`).join(', ')}`);

  let standin;
  let daemon;
  const daemonLog = [];
  try {
    standin = await startStandin(PORT, join(scratch, 'profile'), FIXTURE_LIGHT);
    console.log(`stand-in: ${standin.browser} (pid ${standin.pid}) on 127.0.0.1:${PORT}, light fixture`);
    const startDaemon = () => {
      daemon = spawn(process.execPath, [ENTRY, 'watch'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      daemon.exited = new Promise((resolve) => daemon.once('exit', (code) => resolve(code)));
      for (const stream of [daemon.stdout, daemon.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', (text) => daemonLog.push(...text.split('\n').filter(Boolean)));
      }
      console.log(`daemon: watch (pid ${daemon.pid}) on 127.0.0.1:${PANEL_PORT}`);
      return daemon;
    };
    await run({ env, dataDir, files, target: standin.target, startDaemon, daemonLog });
  } finally {
    if (daemon && daemon.exitCode === null) killTree(daemon.pid);
    if (standin) killTree(standin.pid);
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(`daemon log:\n${daemonLog.map((line) => `      ${line}`).join('\n')}`);
    console.log(
      `cleanup: daemon exit code ${daemon?.exitCode}, killed stand-in tree ${standin?.pid}, removed ${scratch} (exists now: ${existsSync(scratch)}), ` +
        `${PORT} listening: ${await listening(PORT)}, ${PANEL_PORT} listening: ${await listening(PANEL_PORT)}`,
    );
  }
}

async function run({ env, dataDir, files, target, startDaemon, daemonLog }) {
  const dataUrlOf = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
  const slices = Object.fromEntries(Object.entries(files).map(([key, f]) => [key, dataUrlOf(f.bytes).slice(1000, 1064)]));
  const probe = await openSession(target.wsUrl, PORT);
  const inspect = (session = probe) => evaluate(session, `(${inspectPage})(${JSON.stringify(WATCHED)}, ${JSON.stringify(slices)}, ${JSON.stringify(MARK)})`);
  const readStore = async (name) => JSON.parse(await readFile(join(dataDir, name), 'utf8').catch(() => 'null'));
  async function reload(session = probe) {
    await session.send('Page.reload');
    await sleep(300);
    while ((await evaluate(session, 'document.readyState').catch(() => 'loading')) !== 'complete') await sleep(100);
  }
  async function screenshot(name) {
    await probe.send('Page.bringToFront');
    const { data } = await probe.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log(`      screenshot: docs/verify/${name}`);
  }
  const alphas = (state, selectors) => Object.fromEntries(selectors.map((s) => [s, alphaOf(state.elements[s].bg)]));
  const allAt = (state, selectors, alpha) => selectors.every((s) => Math.abs(alphaOf(state.elements[s].bg) - alpha) < 0.011);
  const sameAs = (state, baseline, selectors) => selectors.every((s) => JSON.stringify(state.elements[s]) === JSON.stringify(baseline.elements[s]));
  const watchLayer = (session = probe) =>
    evaluate(
      session,
      `window.__e2eLayerAdds = 0; new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.getAttribute?.('${MARK.attr}') === 'layer') window.__e2eLayerAdds++; }).observe(document.documentElement, { childList: true }); 1`,
    );
  const tagLayer = (tag, session = probe) => evaluate(session, `(() => { const l = document.querySelector('[${MARK.attr}="layer"]'); if (l) l.__e2eTag = ${JSON.stringify(tag)}; return Boolean(l); })()`);

  // 1. Same-side blocks on a light page, with a shipped light theme.
  await reload();
  const baseline = await inspect();
  check(
    baseline.layers === 0 && alphaOf(baseline.elements['#card'].bg) === 1 && baseline.elements['#mine'].bg === 'rgb(28, 28, 28)' && baseline.elements['#composerBox'].bg === 'rgb(255, 255, 255)',
    'baseline: no layer; white card, dark own bubble and white composer frame all solid',
    baseline.elements,
  );
  let r = await cli(['apply', 'paper-light', '--no-daemon'], env);
  check(r.code === 0, 'apply paper-light exits 0', r);
  let state = await inspect();
  console.log(`      alpha after apply paper-light: ${JSON.stringify(alphas(state, [...SURFACES, '#cardInner', ...LEFT_ALONE]))}`);
  check(state.report?.appAppearance === 'light' && state.report.flipped === false && state.report.strength === 72, 'the stand-in reads as a light app, a light theme leaves it unflipped, default strength 72', state.report);
  check(allAt(state, ['#side', '#main', '#rail'], 0.28), 'large panels at 28% (strength 72)', alphas(state, SURFACES));
  check(allAt(state, ['#card', '#card2'], 0.28), 'pure white inner cards are translucent like the panels', alphas(state, SURFACES));
  check(sameAs(state, baseline, ['#mine']), 'the opposite-color own bubble (dark, white text) is untouched', state.elements['#mine']);
  check(sameAs(state, baseline, ['#composerBox', '#composer']), 'the white frame holding the textarea and the textarea itself are untouched', state.elements);
  check(sameAs(state, baseline, ['#answer']), 'the near-transparent answer bubble is untouched', state.elements['#answer']);
  check(alphaOf(state.elements['#cardInner'].bg) === 0, 'a white block inside a white card goes clear: no solid patch, no second veil', state.elements['#cardInner']);

  r = await cli(['restore'], env);
  check(r.code === 0 && JSON.parse(r.stdout).restored === true, 'restore exits 0 and reports restored', r);
  state = await inspect();
  check(state.layers === 0 && sameAs(state, baseline, WATCHED), 'restore: card, bubble, frame and every other watched element back to baseline', { now: state.elements, baseline: baseline.elements });

  // 2. apply --image from the CLI.
  r = await cli(['apply', '--image', files.cli.path, '--no-daemon'], env);
  check(r.code === 0, 'apply --image <generated png> exits 0', r);
  state = await inspect();
  check(state.layers === 1 && state.wallpaper === 'cli', 'the page wallpaper is the generated picture', { layers: state.layers, wallpaper: state.wallpaper });
  let stored = await readStore('last-applied.json');
  check(stored?.themeId === 'custom' && stored.restored === false, 'last-applied.json records custom', stored);
  let meta = await readStore('custom/custom.json');
  check(meta?.sha256 === files.cli.sha && meta.originalName === 'cli-teal.png', 'custom.json records the original name and the same SHA-256', meta);
  check(sha256(await readFile(files.cli.path)) === files.cli.sha && existsSync(files.cli.path), 'the source picture is still there, unchanged');
  check(
    ['dark', 'light', 'mid'].includes(state.report?.imageTone) && state.report.flipped === (state.report.imageTone === 'dark') && allAt(state, SURFACES, 0.28) && sameAs(state, baseline, LEFT_ALONE),
    'custom picture: its brightness is measured, the light page is flipped only for a dark picture, same-side blocks at 28%, the rest untouched', { report: state.report, a: alphas(state, [...SURFACES, ...LEFT_ALONE]) });

  // 3. watch takes over; the panel picks a picture.
  await watchLayer();
  await tagLayer('cli-apply');
  const daemon = startDaemon();
  const up = await waitFor(() => listening(PANEL_PORT), Boolean, 8000);
  check(up.ok, 'watch is listening', up);
  let wait = await waitFor(() => panelOf(probe), (p) => p.count === 1, 6000);
  const panel0 = wait.value;
  check(wait.ok && panel0.shadowType === 'closed', 'watch put one panel in a closed shadow root', panel0);
  check(panel0.items?.[0]?.id === 'custom' && panel0.items[0].name === '我的图片' && panel0.items[0].pressed, 'the panel lists 我的图片 first, selected', panel0.items);
  const sides = await evaluate(probe, `(() => { const filterOf = (node) => (node ? getComputedStyle(node).filter : null); return { flipped: window.${MARK.key}?.inspect().flipped, root: filterOf(document.documentElement), panel: filterOf(document.querySelector('[${MARK.attr}="panel"]')), layer: filterOf(document.querySelector('[${MARK.attr}="layer"]')) }; })()`);
  check(
    sides.flipped ? [sides.root, sides.panel, sides.layer].every((filter) => filter?.includes('invert(1)')) : [sides.root, sides.panel, sides.layer].every((filter) => filter === 'none'),
    'when the page is flipped, the panel and the wallpaper are flipped back with it; when it is not, none of them carries a filter',
    sides,
  );
  check(panel0.pickText === '选择图片' && panel0.picker?.type === 'file' && panel0.picker.accept === 'image/jpeg,image/png,image/webp' && panel0.picker.hidden, 'the panel has a 选择图片 button and a hidden jpeg/png/webp file input', panel0);
  check(panel0.slider === 72 && panel0.sliderText === '72', 'the slider shows the default 72', panel0);
  state = await inspect();
  check(state.layerAdds === 0 && state.layerTag === 'cli-apply', "watch's sync of the CLI record kept the same wallpaper layer", state);

  await pickFile(probe, files.panel.path);
  wait = await waitFor(() => panelOf(probe), (p) => p.status?.tone === 'ok', 15000);
  console.log(`      panel status after pick: ${JSON.stringify(wait.value.status)} (${wait.ms} ms)`);
  check(wait.ok && wait.value.status.text.includes('panel-dusk.png'), 'the panel says the picture is on', wait.value.status);
  const onDisk = await readFile(join(dataDir, 'custom', 'wallpaper.png'));
  console.log(`      source ${files.panel.bytes.length} bytes ${files.panel.sha}`);
  console.log(`      slot   ${onDisk.length} bytes ${sha256(onDisk)}`);
  check(onDisk.length === files.panel.bytes.length && sha256(onDisk) === files.panel.sha, 'watch got the whole file: same byte count and SHA-256 as the source');
  meta = await readStore('custom/custom.json');
  check(meta?.originalName === 'panel-dusk.png' && meta.bytes === files.panel.bytes.length, 'custom.json now names panel-dusk.png', meta);
  state = await inspect();
  check(state.wallpaper === 'panel' && state.layers === 1, 'the page wallpaper is the picked picture', { wallpaper: state.wallpaper, layers: state.layers });
  let panel = await panelOf(probe);
  check(panel.items?.[0]?.id === 'custom' && panel.items[0].pressed && panel.items[0].thumb && panel.items.filter((i) => i.pressed).length === 1, '我的图片 is listed, selected and shows the picture as its thumbnail', panel.items);
  stored = await readStore('last-applied.json');
  check(stored?.themeId === 'custom' && !stored.restored, 'last-applied.json still says custom', stored);
  await screenshot('standin-custom-panel.png');

  const before = (await stat(join(dataDir, 'custom', 'wallpaper.png'))).mtimeMs;
  await pickFile(probe, files.huge.path);
  wait = await waitFor(() => panelOf(probe), (p) => p.status?.tone === 'error', 5000);
  console.log(`      panel status after oversize pick: ${JSON.stringify(wait.value.status)}`);
  check(wait.ok && /4\.01 MB，超过了 4 MB 的上限/.test(wait.value.status.text) && wait.value.status.text.includes('too-big.png'),'a picture over 4 MB is refused and the panel says why', wait.value.status);
  await sleep(500);
  state = await inspect();
  const after = await readFile(join(dataDir, 'custom', 'wallpaper.png'));
  check(state.wallpaper === 'panel' && sha256(after) === files.panel.sha && (await stat(join(dataDir, 'custom', 'wallpaper.png'))).mtimeMs === before, 'the wallpaper and the slot are unchanged', { wallpaper: state.wallpaper });

  // 4. Switch away and back through the panel's own message path.
  await evaluate(probe, `window.__grokbotThemesSend(JSON.stringify({ type: 'apply', themeId: 'paper-light' }))`);
  wait = await waitFor(() => inspect(), (s) => s.token?.startsWith('paper-light@'), 3000);
  check(wait.ok, 'switching to a shipped theme from the panel works', wait.value.token);
  await evaluate(probe, `window.__grokbotThemesSend(JSON.stringify({ type: 'apply', themeId: 'custom' }))`);
  wait = await waitFor(() => inspect(), (s) => s.token?.startsWith('custom@') && s.wallpaper === 'panel', 3000);
  check(wait.ok, 'and back to 我的图片', wait.value.token);

  // 5. The strength slider, with real pointer events.
  const opened = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${FIXTURE_LIGHT}`, { method: 'PUT' })).json();
  const second = await openSession(opened.webSocketDebuggerUrl, PORT);
  wait = await waitFor(() => inspect(second).catch(() => ({})), (s) => s.wallpaper === 'panel' && s.report?.strength === 72, 6000);
  check(wait.ok, 'a second tab gets 我的图片 at the default strength', wait.value.report);
  await reload();
  await waitFor(() => panelOf(probe), (p) => p.count === 1, 3000);
  await watchLayer();
  await tagLayer('before-slide');
  panel = await panelOf(probe);
  const track = panel.sliderRect;
  const mouse = (type, x, y, extra = {}) => probe.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  const y = track.y + track.h / 2;
  const startX = track.x + track.w * 0.72;
  const endX = track.x + track.w * 0.1;
  await probe.send('Page.bringToFront');
  await mouse('mouseMoved', startX, y);
  await mouse('mousePressed', startX, y, { buttons: 1, clickCount: 1 });
  const series = [];
  for (let step = 1; step <= 8; step++) {
    await mouse('mouseMoved', startX + ((endX - startX) * step) / 8, y, { buttons: 1 });
    await sleep(40);
    const s = await inspect();
    series.push({ main: alphaOf(s.elements['#main'].bg), card: alphaOf(s.elements['#card'].bg), tag: s.layerTag, adds: s.layerAdds });
  }
  const midStore = await readStore('strength.json');
  await mouse('mouseReleased', endX, y, { buttons: 0, clickCount: 1 });
  console.log(`      during drag (#main alpha, #card alpha): ${series.map((s) => `${s.main.toFixed(2)}/${s.card.toFixed(2)}`).join(' ')}`);
  check(series.every((s) => s.tag === 'before-slide' && s.adds === 0), 'while dragging the wallpaper layer is the same node and no new layer is added', series);
  check(series.every((s, i) => i === 0 || s.main >= series[i - 1].main) && series.at(-1).main > series[0].main + 0.3, 'the panel alpha follows the drag (thicker as the slider goes left)', series);
  check(series.every((s) => Math.abs(s.main - s.card) < 0.011), 'white cards follow the slider together with the panels', series);
  check(midStore === null, 'nothing is saved before the pointer is released', midStore);
  wait = await waitFor(() => readStore('strength.json'), (v) => Number.isInteger(v?.strength) && v.strength < 20, 3000);
  const chosen = wait.value?.strength;
  check(wait.ok, `after release strength.json holds the new value (${chosen})`, wait.value);
  wait = await waitFor(() => panelOf(probe), (p) => p.count === 1 && p.slider === chosen && p.sliderText === String(chosen), 3000);
  check(wait.ok, 'the slider and its number show the saved value', wait.value);
  state = await inspect();
  check(Math.abs(alphaOf(state.elements['#main'].bg) - (100 - chosen) / 100) < 0.011 && state.layerTag === 'before-slide' && state.layerAdds === 0, 'after release: alpha is 100 - strength and the layer is still the same node', { a: alphas(state, SURFACES), tag: state.layerTag, adds: state.layerAdds });
  wait = await waitFor(() => inspect(second), (s) => s.report?.strength === chosen && Math.abs(alphaOf(s.elements['#main'].bg) - (100 - chosen) / 100) < 0.011, 3000);
  check(wait.ok, 'the second tab synced to the new strength', wait.value.report);
  const secondPanel = await panelOf(second);
  check(secondPanel.slider === chosen, 'the second tab’s slider shows it too', secondPanel.slider);
  await sleep(1200);
  await screenshot('standin-custom-faint.png');

  await reload();
  wait = await waitFor(async () => ({ s: await inspect(), p: await panelOf(probe) }), ({ s, p }) => s.report?.strength === chosen && p.slider === chosen, 3000);
  check(wait.ok && Math.abs(alphaOf(wait.value.s.elements['#main'].bg) - (100 - chosen) / 100) < 0.011, 'after a reload the page and the slider still use the saved strength', wait.value.s.report);

  // 6. --strength from the CLI while watch runs.
  r = await cli(['apply', 'custom', '--strength', '90', '--no-daemon'], env);
  check(r.code === 0, 'apply custom --strength 90 exits 0', r);
  state = await inspect();
  check(allAt(state, SURFACES, 0.1) && state.report.strength === 90, 'the CLI strength shows at once: same-side blocks at 10%', alphas(state, SURFACES));
  check((await readStore('strength.json'))?.strength === 90, 'strength.json says 90');
  wait = await waitFor(() => inspect(second), (s) => s.report?.strength === 90, 4000);
  check(wait.ok, 'watch carries the CLI strength to the second tab', wait.value.report);

  // 7. Reading lane: a picture with one flat background has the strip behind the replies painted over in that color.
  const laneOf = () =>
    evaluate(
      probe,
      `(() => { const lane = document.querySelector('[${MARK.attr}="lane"]'); const style = lane ? getComputedStyle(lane) : null; const box = (id) => { const r = document.getElementById(id)?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.right)] : null; };
        return { report: window.${MARK.key}?.inspect().lane ?? null, shown: Boolean(style) && style.display !== 'none', background: style?.backgroundColor ?? null, mask: lane?.style.maskImage ?? '', inImage: lane?.parentElement?.getAttribute('${MARK.attr}') === 'image', column: box('column'), reply: document.querySelector('.reply') ? (() => { const r = document.querySelector('.reply').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })() : null, wide: box('wide') }; })()`,
    );
  r = await cli(['apply', '--image', files.poster.path, '--no-daemon'], env);
  check(r.code === 0, 'apply --image <flat poster> exits 0', r);
  wait = await waitFor(laneOf, (l) => l.inImage, 3000);
  await sleep(600);
  let laneNow = await laneOf();
  check(laneNow.inImage && laneNow.report === null && !laneNow.shown, 'flat picture but no conversation column on the page: no lane', laneNow);
  await evaluate(
    probe,
    `(() => { const feed = Object.assign(document.createElement('div'), { id: 'feed' }); feed.style.cssText = 'flex:1;min-height:0;overflow-y:auto;';
      const column = Object.assign(document.createElement('div'), { id: 'column' }); column.style.cssText = 'width:36vw;margin:0 auto;';
      for (let i = 0; i < 30; i++) { const reply = document.createElement('div'); reply.className = 'reply'; reply.style.cssText = 'width:22vw;height:60px;margin:10px 0;'; column.append(reply); }
      feed.append(column); document.getElementById('main').prepend(feed); })()`,
  );
  wait = await waitFor(laneOf, (l) => l.report !== null, 3000);
  laneNow = wait.value;
  check(
    wait.ok && laneNow.report.left === laneNow.column[0] && laneNow.report.right === laneNow.reply[1] && laneNow.reply[1] < laneNow.column[1] - 60,
    'a column of replies appears: the lane runs from the column’s left edge to where the replies end, not to the column’s right edge',
    laneNow,
  );
  const [lr, lg, lb] = (laneNow.background?.match(/[\d.]+/g) ?? []).map(Number);
  check(laneNow.shown && Math.abs(lr - 32) <= 2 && Math.abs(lg - 44) <= 2 && Math.abs(lb - 52) <= 2 && laneNow.report.color === laneNow.background, `the lane is painted in the picture’s own background color (${laneNow.background})`, laneNow);
  check(laneNow.mask.includes(`${laneNow.report.left - 12}px`) && laneNow.mask.includes(`${laneNow.report.right + 12}px`) && laneNow.mask.includes('transparent'), 'and fades out on both sides', laneNow.mask);
  await sleep(700);
  await screenshot('standin-lane.png');
  await evaluate(probe, `(() => { const wide = Object.assign(document.createElement('div'), { id: 'wide' }); wide.style.cssText = 'width:28vw;height:60px;margin:10px 0;'; document.getElementById('column').prepend(wide); })()`);
  wait = await waitFor(laneOf, (l) => l.wide && l.report?.right === l.wide[1], 3000);
  check(wait.ok, 'a wider reply shows up: the lane widens to it', wait.value);
  r = await cli(['apply', '--image', files.cli.path, '--no-daemon'], env);
  wait = await waitFor(laneOf, (l) => l.inImage && l.report === null, 3000);
  await sleep(600);
  laneNow = await laneOf();
  check(r.code === 0 && laneNow.report === null && !laneNow.shown, 'a picture without a flat background (a gradient): no lane, with the same column on the page', laneNow);
  r = await cli(['apply', '--image', files.night.path, '--no-daemon'], env);
  wait = await waitFor(laneOf, (l) => l.inImage && l.report === null, 3000);
  await sleep(600);
  laneNow = await laneOf();
  check(r.code === 0 && laneNow.report === null && !laneNow.shown, 'a dark night sky that is not one flat color: no lane (it used to get a dark band across the scenery)', laneNow);
  await evaluate(probe, `document.getElementById('feed').remove()`);

  r = await cli(['restore'], env);
  check(r.code === 0, 'restore exits 0', r);
  wait = await waitFor(() => inspect(), (s) => s.layers === 0, 3000);
  check(wait.ok && sameAs(wait.value, baseline, WATCHED), 'restore: everything back to baseline on the light page', wait.value.elements);

  const quit = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/quit`, { method: 'POST' }).then((res) => res.status);
  const exitCode = await Promise.race([daemon.exited, sleep(5000).then(() => 'still running')]);
  check(quit === 200 && exitCode === 0, 'watch quits with code 0', { quit, exitCode });
  check(daemonLog.some((line) => line.includes(files.panel.sha)), 'watch logged the received SHA-256');
  await second.close();
  await probe.close();
}

await main();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
