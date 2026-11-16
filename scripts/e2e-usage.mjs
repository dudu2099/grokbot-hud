#!/usr/bin/env node
// Show usage, end to end, against a headless Edge with a fake account menu (test/fixtures/standin-usage.html).
// Never the real Grok Bot: test ports only (19333/19334 by default), a throwaway data dir, the stand-in switch.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { evaluate, openSession } from '../src/cdp.mjs';
import { MARK } from '../src/overlay.mjs';
import { PANEL_BINDING } from '../src/panel.mjs';
import { loadThemes, wallpaperDataUrl } from '../src/themes.mjs';
import { HIDE_MARK, USAGE, USAGE_REASONS } from '../src/usage.mjs';
import { cli, e2ePort, ENTRY, killTree, PACKS_DIR, ROOT, SHOTS, startStandin } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const FIXTURE_USAGE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'standin-usage.html')).href;
const RGB = { warn: 'rgb(230, 162, 60)', danger: 'rgb(217, 83, 79)', paperLight: 'rgb(181, 101, 29)' };
// Shortened for the test only (they can never be lengthened): read every 3 s, idle means 1.5 s without input.
const TEST_TIMING = { GROKBOT_TEST_USAGE_INTERVAL_MS: '3000', GROKBOT_TEST_USAGE_IDLE_MS: '1500', GROKBOT_TEST_USAGE_RETRY_MS: '1000', GROKBOT_TEST_USAGE_FRESH_MS: '1000' };
// Words of the fake menu other than the figure. None of them may ever show up in watch's log.
const MENU_WORDS = ['Premium', '设置', '快捷键', '帮助', '更新日志', '下载', '反馈', '退出登录', '关于'];

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

async function waitFor(read, ok, timeoutMs, stepMs = 100) {
  const started = Date.now();
  let value = await read();
  while (!ok(value) && Date.now() - started < timeoutMs) {
    await sleep(stepMs);
    value = await read();
  }
  return { value, ok: ok(value), ms: Date.now() - started };
}

function panelShadowReport() {
  const part = (name) => this.querySelector(`[data-part="${name}"]`);
  const rect = (node) => {
    if (!node || node.hidden || node.hasAttribute('hidden')) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  };
  const label = part('usage');
  const ring = part('ring');
  const arc = part('ring-arc');
  const badge = part('badge');
  return {
    badge: badge.hidden ? null : { text: badge.textContent, background: getComputedStyle(badge).backgroundColor, color: getComputedStyle(badge).color },
    collapsed: part('card').hidden && !part('fab').hidden,
    label: label.hidden ? null : label.textContent,
    ring: ring.hasAttribute('hidden') ? null : { tone: ring.dataset.tone, stale: ring.hasAttribute('data-stale'), dash: arc.getAttribute('stroke-dasharray') },
    stroke: getComputedStyle(arc).stroke,
    labelColor: label.hidden ? null : getComputedStyle(label).color,
    fabTitle: part('fab').title,
    switchOn: part('usage-switch').checked,
    card: rect(part('card')),
    fab: rect(part('fab')),
    ringBox: rect(ring),
    collapse: rect(part('collapse')),
    toggle: rect(part('usage-switch')),
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
  const { object } = await session.send('DOM.resolveNode', { nodeId: hosts[0].shadowRoots[0].nodeId });
  const { result } = await session.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: panelShadowReport.toString(), returnByValue: true });
  return { count: 1, ...result.value };
}

// What the page looks like from outside the panel: menus, the hiding sheet, focus, the stand-in's own counters.
const pageState = (session) =>
  evaluate(
    session,
    `({ menus: document.querySelectorAll('[role="menu"]').length,
        hiding: getComputedStyle(document.documentElement).getPropertyValue('${HIDE_MARK}').trim(),
        sheets: document.adoptedStyleSheets.length,
        focus: document.activeElement?.id || document.activeElement?.tagName || null,
        flip: getComputedStyle(document.documentElement).getPropertyValue('--grokbot-themes-flip').trim(),
        expanded: document.getElementById('account').getAttribute('aria-expanded'),
        ...window.__standin })`,
  );

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-e2e-usage-'));
  const dataDir = join(scratch, 'data');
  const env = {
    GROKBOT_DEBUG_PORT: String(PORT),
    GROKBOT_PANEL_PORT: String(PANEL_PORT),
    GROKBOT_DATA_DIR: dataDir,
    GROKBOT_THEMES_DIR: PACKS_DIR,
    GROKBOT_ALLOW_STANDIN: '1',
    GROKBOT_STARTUP_DIR: join(scratch, 'startup'),
    ...TEST_TIMING,
  };
  if (await listening(PANEL_PORT)) throw new Error(`面板端口 ${PANEL_PORT} 已被占用，换个空闲端口再跑`);
  let standin;
  const daemons = [];
  const daemonLog = [];
  const startDaemon = () => {
    const daemon = spawn(process.execPath, [ENTRY, 'watch'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    daemon.exited = new Promise((resolve) => daemon.once('exit', (code) => resolve(code)));
    for (const stream of [daemon.stdout, daemon.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (text) => daemonLog.push(...text.split('\n').filter(Boolean)));
    }
    daemons.push(daemon);
    console.log(`daemon: watch (pid ${daemon.pid})`);
    return daemon;
  };
  try {
    standin = await startStandin(PORT, join(scratch, 'profile'), FIXTURE_USAGE);
    console.log(`stand-in: ${standin.browser} (pid ${standin.pid}) on 127.0.0.1:${PORT}`);
    await run({ env, dataDir, target: standin.target, startDaemon, daemonLog });
  } finally {
    for (const daemon of daemons) if (daemon.exitCode === null) killTree(daemon.pid);
    if (standin) killTree(standin.pid);
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(`daemon log:\n${daemonLog.map((line) => `      ${line}`).join('\n')}`);
    console.log(
      `cleanup: daemons ${daemons.map((d) => `${d.pid} exit ${d.exitCode ?? d.signalCode}`).join(', ')}, killed stand-in tree ${standin?.pid}, removed ${scratch} (exists now: ${existsSync(scratch)})`,
    );
  }
}

async function run({ env, dataDir, target, startDaemon, daemonLog }) {
  const probe = await openSession(target.wsUrl, PORT);
  const { themes } = await loadThemes(PACKS_DIR);
  const slices = Object.fromEntries(await Promise.all(themes.map(async (t) => [t.id, (await wallpaperDataUrl(t)).slice(1000, 1064)])));
  const wallpaperOf = () =>
    evaluate(probe, `(() => { const b = document.querySelector('[${MARK.attr}="image"]')?.style.backgroundImage ?? ''; const s = ${JSON.stringify(slices)}; return Object.keys(s).find((id) => b.includes(s[id])) ?? null; })()`);
  const readUsage = async () => JSON.parse(await readFile(join(dataDir, 'usage.json'), 'utf8').catch(() => 'null'));
  const status = async () => JSON.parse((await cli(['status'], env)).stdout).usage;
  const setFigure = (text) => evaluate(probe, `window.__standin.usage = ${JSON.stringify(text)}`);
  const mouse = (type, x, y, extra = {}) => probe.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  async function click(x, y) {
    await mouse('mousePressed', x, y, { buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', x, y, { buttons: 0, clickCount: 1 });
  }
  const clickBox = (box) => click(box.x + box.w / 2, box.y + box.h / 2);
  async function escape() {
    for (const type of ['keyDown', 'keyUp']) await probe.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  const account = await evaluate(probe, `(() => { const b = document.getElementById('account').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  async function shot(name, clip) {
    await probe.send('Page.bringToFront');
    const { data } = await probe.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 3 } } : {}) });
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log(`      screenshot: docs/verify/${name}`);
  }
  const around = (box, pad) => ({ x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2 });

  // The wallpaper and panel first, by a one-shot apply; then watch, which should read the figure on its own.
  let r = await cli(['apply', 'paper-light', '--no-daemon'], env);
  check(r.code === 0, 'one-shot apply paper-light on the stand-in (panel shows, no watch yet)', r);
  const before = await pageState(probe);
  check(before.presses === 0 && before.opens === 0, 'nothing has pressed the account button before watch starts', before);

  let daemon = startDaemon();
  const attached = await waitFor(() => daemonLog.findIndex((line) => line.includes(`已接上窗口 ${target.id}`)), (i) => i >= 0, 8000);
  check(attached.ok, 'watch attached to the stand-in window', daemonLog);
  const attachedAt = Date.now();
  let wait = await waitFor(() => panelOf(probe), (p) => p.label === '用量 97%' && p.ring?.dash === '97 100', 6000);
  const seconds = ((Date.now() - attachedAt) / 1000).toFixed(1);
  check(wait.ok, `the panel shows 用量 97% and a 97% ring ${seconds} s after watch attached (stand-in set 97)`, wait.value);
  let stored = await readUsage();
  check(stored?.percent === 97 && stored.enabled === true && typeof stored.readAt === 'string', 'usage.json holds 97, on, with a time', stored);
  let page = await waitFor(() => pageState(probe), (s) => s.menus === 0 && s.closes === s.opens, 2000);
  check(
    page.value.menus === 0 && page.value.hiding === '' && page.value.opens >= 1 && page.value.closes === page.value.opens,
    'after the read: no menu left, the hiding sheet is gone, every open was closed',
    page.value,
  );
  check(page.value.focus === 'BODY', 'nothing was focused before, and nothing is left focused after (not the account button)', page.value);

  // Focus on a page button, figure 85: the next read gives the focus back and turns the ring amber.
  await evaluate(probe, `document.getElementById('other').focus()`);
  await setFigure('85% 已用');
  const opensBefore = (await pageState(probe)).opens;
  wait = await waitFor(() => panelOf(probe), (p) => p.label === '用量 85%', 8000);
  page = await waitFor(() => pageState(probe), (s) => s.menus === 0 && s.closes === s.opens, 2000);
  check(wait.ok && page.value.opens > opensBefore, `a periodic read happened (opens ${opensBefore} -> ${page.value.opens}) and the panel shows 用量 85%`, wait.value);
  check(page.value.focus === 'other' && page.value.hiding === '' && page.value.menus === 0, 'focus is back on the page button, no sheet, no menu', page.value);
  check(wait.value.ring?.tone === 'warn' && wait.value.stroke === RGB.warn && wait.value.labelColor === RGB.warn, `85: the ring and the figure are amber (${wait.value.stroke})`, wait.value);
  check(
    wait.value.badge?.text === '85%' && wait.value.badge.background === RGB.warn && wait.value.badge.color === 'rgb(27, 29, 34)',
    '85: the ball carries an amber badge reading 85% in dark figures',
    wait.value.badge,
  );

  await setFigure('97% 已用');
  wait = await waitFor(() => panelOf(probe), (p) => p.label === '用量 97%', 8000);
  check(wait.ok && wait.value.ring?.tone === 'danger' && wait.value.stroke === RGB.danger, `97: the ring is red (${wait.value.stroke})`, wait.value);
  check(
    wait.value.badge?.text === '97%' && wait.value.badge.background === RGB.danger && wait.value.badge.color === 'rgb(255, 255, 255)',
    '97: the badge is red and reads 97% in white figures',
    wait.value.badge,
  );

  // Typing: no click at all, nothing changes, and the store says why.
  await evaluate(probe, `document.getElementById('composer').focus()`);
  await setFigure('50% 已用');
  page = await pageState(probe);
  const typingFrom = { presses: page.presses, expandedChanges: page.expandedChanges };
  // Real key presses the whole time: focus resting in the box is not typing, keys going in are.
  for (let elapsed = 0; elapsed < 3000 * 2 + 1500; elapsed += 500) {
    await probe.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
    await probe.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await sleep(500);
  }
  page = await pageState(probe);
  stored = await readUsage();
  let st = await status();
  check(page.presses === typingFrom.presses && page.expandedChanges === typingFrom.expandedChanges, `typing for 7.5 s: the account button was never pressed (presses ${page.presses}, expanded changes ${page.expandedChanges})`, { typingFrom, page });
  check(stored.percent === 97 && (await panelOf(probe)).label === '用量 97%', 'the figure did not change while typing', stored);
  check(st.lastAttempt?.outcome === 'skipped' && st.lastAttempt.reason === USAGE_REASONS.typing, `status: lastAttempt says「${st.lastAttempt?.reason}」`, st);

  // The real app keeps focus in its message box all the time. Once the keys stop, a read goes ahead,
  // and focus and the caret end up exactly where they were.
  const caret = await evaluate(probe, `(() => { const box = document.getElementById('composer'); box.setSelectionRange(3, 3); return { start: box.selectionStart, length: box.value.length }; })()`);
  wait = await waitFor(() => readUsage(), (u) => u.percent === 50, 16000);
  const afterRest = await evaluate(probe, `(() => { const box = document.getElementById('composer'); return { focused: document.activeElement === box, start: box.selectionStart, length: box.value.length }; })()`);
  check(wait.ok, 'focus resting in the message box with no keys pressed does not hold the read back', wait.value);
  check(afterRest.focused && afterRest.start === caret.start && afterRest.length === caret.length, 'after that read the message box still has focus, the caret has not moved and its text is untouched', { caret, afterRest });
  await evaluate(probe, `document.getElementById('composer').blur()`);

  // A covered or minimized window: nobody can see the figure and its timers crawl, so nothing is pressed until it shows again.
  await evaluate(probe, `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })`);
  await setFigure('61% 已用');
  const hiddenFrom = (await pageState(probe)).presses;
  wait = await waitFor(() => status(), (s) => s.lastAttempt?.reason === USAGE_REASONS.hidden, 12000);
  page = await pageState(probe);
  check(wait.ok && page.presses === hiddenFrom && (await readUsage()).percent === 50, `window not visible: the account button is not pressed, the figure stays, status says「${wait.value.lastAttempt?.reason}」`, { status: wait.value, page });
  await evaluate(probe, `delete document.visibilityState`);
  wait = await waitFor(() => readUsage(), (u) => u.percent === 61, 16000);
  check(wait.ok, 'visible again: the next look reads the new figure', wait.value);

  // Something on top of the account button (a dialog's backdrop): the click would land on it, so there is no click at all.
  await evaluate(probe, `(() => { const cover = Object.assign(document.createElement('div'), { id: 'cover' }); cover.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.2);'; window.__coverClicks = 0; for (const type of ['pointerdown', 'mousedown', 'click']) cover.addEventListener(type, () => window.__coverClicks++); document.body.append(cover); })()`);
  await setFigure('73% 已用');
  const coveredFrom = (await pageState(probe)).presses;
  wait = await waitFor(() => status(), (s) => s.lastAttempt?.reason === USAGE_REASONS.covered, 12000);
  await sleep(3500);
  page = await pageState(probe);
  const coverClicks = await evaluate(probe, 'window.__coverClicks');
  check(wait.ok && page.presses === coveredFrom && coverClicks === 0 && (await readUsage()).percent === 61, `account button covered by a backdrop: nothing is clicked, not the button and not the backdrop (${coverClicks}), the figure stays, status says「${wait.value.lastAttempt?.reason}」`, { status: wait.value, page, coverClicks });
  await evaluate(probe, `document.getElementById('cover').remove()`);
  wait = await waitFor(() => readUsage(), (u) => u.percent === 73, 16000);
  check(wait.ok, 'backdrop gone: the next look reads the new figure', wait.value);

  // The user opens the menu with a real pointer press: the panel takes the figure and leaves the menu open.
  await setFigure('42% 已用');
  page = await pageState(probe);
  const closesBefore = page.closes;
  await clickBox(account);
  wait = await waitFor(() => panelOf(probe), (p) => p.label === '用量 42%', 4000);
  check(wait.ok, `the user's own menu: the panel shows 用量 42% (took ${wait.ms} ms)`, wait.value);
  check(wait.value.ring?.tone === 'normal' && wait.value.stroke === RGB.paperLight, `42: the ring is in the theme's accent (${wait.value.stroke})`, wait.value);
  await sleep(3000 + 1500);
  page = await pageState(probe);
  check(page.menus === 1 && page.closes === closesBefore && page.expanded === 'true' && page.hiding === '', "4.5 s later the user's menu is still open, visible, and was not closed by the tool", page);
  await escape();
  page = await waitFor(() => pageState(probe), (s) => s.menus === 0, 2000);
  check(page.ok, 'the user closes it with their own Escape', page.value);

  // No usage item in the menu: no ring, a reason in status, and the wallpaper and panel still work.
  await setFigure(null);
  wait = await waitFor(() => panelOf(probe), (p) => p.label === null && p.ring === null, 9000);
  st = await status();
  check(wait.ok && wait.value.badge === null, 'menu without the usage item: the panel shows no ring, no figure and no badge', wait.value);
  check(st.percent === null && st.lastError?.reason === USAGE_REASONS.noNumber, `status: percent null, lastError「${st.lastError?.reason}」`, st);
  page = await waitFor(() => pageState(probe), (s) => s.menus === 0 && s.closes === s.opens, 3000);
  check(page.value.menus === 0 && page.value.hiding === '', 'the failed read still closed the menu and removed the sheet', page.value);
  await evaluate(probe, `window.${PANEL_BINDING}(JSON.stringify({ type: 'apply', themeId: 'night-harbor' }))`);
  const switched = await waitFor(async () => ({ wallpaper: await wallpaperOf(), panel: await panelOf(probe) }), (s) => s.wallpaper === 'night-harbor' && s.panel.count === 1, 4000);
  check(switched.ok, 'panel apply night-harbor still swaps the wallpaper and keeps one panel', switched.value);
  await evaluate(probe, `window.${PANEL_BINDING}(JSON.stringify({ type: 'apply', themeId: 'paper-light' }))`);
  await waitFor(wallpaperOf, (id) => id === 'paper-light', 4000);

  // Panel switch off: ring gone; time passes with every condition for a read met; not one press. On again: back.
  await setFigure('97% 已用');
  let panel = (await waitFor(() => panelOf(probe), (p) => p.count === 1 && p.toggle, 3000)).value;
  if (panel.collapsed) {
    await clickBox(panel.fab);
    panel = (await waitFor(() => panelOf(probe), (p) => !p.collapsed && p.toggle, 3000)).value;
  }
  await clickBox(panel.toggle);
  wait = await waitFor(async () => ({ panel: await panelOf(probe), stored: await readUsage() }), (s) => !s.panel.switchOn && s.panel.ring === null && s.stored?.enabled === false, 4000);
  check(wait.ok, 'clicking「显示用量」off: switch off, no ring, usage.json enabled false', wait.value);
  await sleep(500);
  page = await pageState(probe);
  const offFrom = page.presses;
  await sleep(3000 * 2 + 2000);
  await clickBox(account);
  await setFigure('55% 已用');
  await sleep(1500);
  page = await pageState(probe);
  panel = await panelOf(probe);
  check(page.presses === offFrom + 1, `switched off for 8 s: the tool pressed nothing (presses ${offFrom} -> ${page.presses}, the one is the test's own press)`, page);
  check(panel.label === null && (await readUsage()).percent !== 55, "while off, a menu the user opens is not read either", { panel, stored: await readUsage() });
  await escape();
  await waitFor(() => pageState(probe), (s) => s.menus === 0, 2000);
  await setFigure('97% 已用');
  panel = await panelOf(probe);
  const onFrom = (await pageState(probe)).presses;
  await clickBox(panel.toggle);
  wait = await waitFor(() => panelOf(probe), (p) => p.switchOn && p.label === '用量 97%' && p.ring?.tone === 'danger', 8000);
  page = await pageState(probe);
  check(wait.ok && page.presses > onFrom, `switched on again: 用量 97% is back after a fresh read (presses ${onFrom} -> ${page.presses})`, wait.value);

  // The command line switch, picked up by the running watch.
  r = await cli(['usage', 'off'], env);
  wait = await waitFor(() => panelOf(probe), (p) => p.ring === null && !p.switchOn, 5000);
  check(r.code === 0 && wait.ok, `usage off from the command line: the running watch drops the ring (took ${wait.ms} ms)`, { r, panel: wait.value });
  const onLines = () => daemonLog.filter((line) => line.includes('显示用量已打开')).length;
  const onBefore = onLines();
  r = await cli(['usage', 'on'], env);
  wait = await waitFor(() => panelOf(probe), (p) => p.label === '用量 97%' && p.switchOn, 8000);
  check(r.code === 0 && wait.ok, 'usage on from the command line: the figure comes back', wait.value);
  const heard = await waitFor(onLines, (n) => n > onBefore, 5000);
  check(heard.ok, 'the running watch passed the switch on to the page (its log says 显示用量已打开)', daemonLog.slice(-6));
  st = await status();
  check(st.enabled === true && st.percent === 97 && typeof st.readAt === 'string', `status: enabled, 97, read at ${st.readAt}`, st);

  // Screenshots, plain and flipped (night-harbor is dark, the stand-in is light, so the app gets flipped).
  panel = await panelOf(probe);
  if (panel.collapsed) {
    await clickBox(panel.fab);
    panel = (await waitFor(() => panelOf(probe), (p) => !p.collapsed, 3000)).value;
  }
  await shot('standin-usage-expanded.png', around(panel.card, 16));
  await clickBox(panel.collapse);
  panel = (await waitFor(() => panelOf(probe), (p) => p.collapsed && p.ring, 3000)).value;
  const ringOutside =
    Math.abs(panel.ringBox.x - (panel.fab.x - 7)) < 0.5 && Math.abs(panel.ringBox.w - (panel.fab.w + 14)) < 0.5 && panel.fab.w === 40;
  check(ringOutside, `the ring box (${panel.ringBox.w}px) sits 7px outside the ${panel.fab.w}px ball, so the thumbnail is not covered`, panel);
  check(/用量 97%，.*读到/.test(panel.fabTitle), `hovering the ball says「${panel.fabTitle}」`, panel.fabTitle);
  await shot('standin-usage-collapsed.png', around(panel.fab, 30));

  await evaluate(probe, `window.${PANEL_BINDING}(JSON.stringify({ type: 'apply', themeId: 'night-harbor' }))`);
  wait = await waitFor(async () => ({ page: await pageState(probe), panel: await panelOf(probe) }), (s) => s.page.flip !== '' && s.panel.ring?.tone === 'danger', 5000);
  check(wait.ok, `night-harbor flips the light stand-in (--grokbot-themes-flip: ${wait.value.page.flip}) and the ring is still drawn`, wait.value);
  check(wait.value.panel.stroke === RGB.danger, 'flipped: the ring is still the same red before the flip-back filter', wait.value.panel);
  panel = wait.value.panel;
  await shot('standin-usage-collapsed-flipped.png', around(panel.fab, 30));
  await clickBox(panel.fab);
  panel = (await waitFor(() => panelOf(probe), (p) => !p.collapsed, 3000)).value;
  await shot('standin-usage-expanded-flipped.png', around(panel.card, 16));

  // The debug connection dies in the middle of a read: the hiding sheet must go away on its own.
  await setFigure(null);
  const caught = await waitFor(() => pageState(probe), (s) => s.hiding === '1', 15000, 20);
  check(caught.ok, 'caught a read in progress (the hiding sheet is on)', caught.value);
  const killedAt = Date.now();
  killTree(daemon.pid);
  const healed = await waitFor(() => pageState(probe), (s) => s.hiding === '', 12000, 100);
  check(caught.ok && healed.ok, `watch killed mid-read: the hiding sheet removed itself ${((Date.now() - killedAt) / 1000).toFixed(1)} s later (failsafe ${USAGE.failsafeMs / 1000} s)`, healed.value);
  console.log(`      after the kill: menus open ${healed.value.menus}, sheets ${healed.value.sheets}, account expanded ${healed.value.expanded}`);

  const leaked = MENU_WORDS.filter((word) => daemonLog.some((line) => line.includes(word)));
  check(leaked.length === 0, "watch's log never carried a word of the menu other than the figure", leaked);
  await probe.close();
}

await main();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
