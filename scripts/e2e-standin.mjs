#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { evaluate, openSession } from '../src/cdp.mjs';
import { applyExpression, colorToRgb, MARK } from '../src/overlay.mjs';
import { loadThemes, wallpaperDataUrl } from '../src/themes.mjs';
import { cli, e2ePort, FIXTURE_OKLCH, killTree, PACKS_DIR, SHOTS, startStandin } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const WATCHED = ['html', 'body', '#sidebar', '#main', '#composer', '#send', '#dlg', '#late', '#after'];

const results = [];
function check(ok, label, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ''}`);
}

function alphaOf(color) {
  if (color === 'transparent') return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
  const parts = /^rgba?\(([^)]*)\)$/.exec(color)?.[1].split(',');
  return parts?.length === 4 ? Number(parts[3]) : 1;
}

function luma(color) {
  const rgb = colorToRgb(color);
  return rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null;
}

function inspectPage(watched, slices, mark) {
  const image = document.querySelector(`[${mark.attr}="image"]`);
  const background = image ? image.style.backgroundImage : '';
  const describe = (selector) => {
    const node = document.querySelector(selector);
    return node && { style: node.getAttribute('style'), bg: getComputedStyle(node).backgroundColor };
  };
  return {
    layers: document.querySelectorAll(`[${mark.attr}="layer"]`).length,
    wallpaper: Object.keys(slices).find((id) => background.includes(slices[id])) ?? null,
    token: window[mark.key]?.token ?? null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    rootFilter: getComputedStyle(document.documentElement).filter,
    layerFilter: image ? getComputedStyle(image.parentElement).filter : null,
    elements: Object.fromEntries(watched.map((selector) => [selector, describe(selector)])),
  };
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-e2e-'));
  const env = {
    GROKBOT_DEBUG_PORT: String(PORT),
    GROKBOT_PANEL_PORT: String(PANEL_PORT),
    GROKBOT_DATA_DIR: join(scratch, 'data'),
    GROKBOT_THEMES_DIR: PACKS_DIR,
    // The stand-in is a headless Edge, not Grok Bot; this test-only switch lets it through on the test port.
    GROKBOT_ALLOW_STANDIN: '1',
    GROKBOT_STARTUP_DIR: join(scratch, 'startup'),
  };
  let standin;
  try {
    standin = await startStandin(PORT, join(scratch, 'profile'));
    console.log(`stand-in: ${standin.browser} (pid ${standin.pid}) on 127.0.0.1:${PORT}`);
    await run(env, standin.target);
  } finally {
    if (standin) killTree(standin.pid);
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(`cleanup: killed pid tree ${standin?.pid}, removed ${scratch} (exists now: ${existsSync(scratch)})`);
  }
}

async function run(env, target) {
  const { themes } = await loadThemes(PACKS_DIR);
  const dataUrls = Object.fromEntries(await Promise.all(themes.map(async (t) => [t.id, await wallpaperDataUrl(t)])));
  const slices = Object.fromEntries(Object.entries(dataUrls).map(([id, url]) => [id, url.slice(1000, 1064)]));
  const probe = await openSession(target.wsUrl, PORT);
  const inspect = () => evaluate(probe, `(${inspectPage})(${JSON.stringify(WATCHED)}, ${JSON.stringify(slices)}, ${JSON.stringify(MARK)})`);
  const pageEval = (source) => evaluate(probe, source);
  async function reload() {
    await probe.send('Page.reload');
    await sleep(300);
    while ((await pageEval('document.readyState')) !== 'complete') await sleep(100);
  }
  async function screenshot(name) {
    const { data } = await probe.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log(`      screenshot: docs/verify/${name}`);
  }
  const MATCHED = 0.28;
  const flippedOver = (state) => state.rootFilter.includes('invert(1)') && state.layerFilter.includes('invert(1)');
  const translucent = (state, selector, alpha = MATCHED) => Math.abs(alphaOf(state.elements[selector].bg) - alpha) < 0.01;
  const sameAsBaseline = (state, baseline, selectors) =>
    selectors.every((s) => JSON.stringify(state.elements[s]) === JSON.stringify(baseline.elements[s]));

  await reload();
  const baseline = await inspect();
  let state;
  check(baseline.layers === 0 && alphaOf(baseline.elements['#sidebar'].bg) === 1, 'baseline: no layer, sidebar opaque', baseline);

  // Without the test-only switch the stand-in is what it is: a browser that is not Grok Bot. Nothing may be put into it.
  const strict = { ...env, GROKBOT_ALLOW_STANDIN: '' };
  let refused = await cli(['apply', 'night-harbor', '--no-daemon'], strict);
  check(refused.code === 4 && /上应答的不是 Grok Bot，是别的程序（它自报「/.test(refused.stderr), 'without GROKBOT_ALLOW_STANDIN, apply on the stand-in is refused with exit 4 and names what answered', refused);
  console.log(`      ${refused.stderr.trim()}`);
  refused = await cli(['status'], strict);
  check(refused.code === 0 && JSON.parse(refused.stdout).debug === 'other', 'without the switch, status reports the debug port as other', refused);
  state = await inspect();
  check(state.layers === 0 && state.token === null && sameAsBaseline(state, baseline, WATCHED), 'the refused apply left the page exactly as it was', state);

  let r = await cli(['apply', 'night-harbor', '--no-daemon'], env);
  check(r.code === 0, 'apply night-harbor exits 0', r);
  state = await inspect();
  check(state.layers === 1 && state.wallpaper === 'night-harbor', 'apply night-harbor: exactly one wallpaper layer with the night-harbor image', state);
  check(translucent(state, '#sidebar') && translucent(state, '#main'), 'apply night-harbor: sidebar and main panel translucent', state.elements);
  check(sameAsBaseline(state, baseline, ['#composer', '#send', '#dlg']), 'apply night-harbor: textarea, button and dialog untouched', state.elements);
  check(state.colorScheme === 'dark', 'apply night-harbor: color-scheme dark', state.colorScheme);
  check(state.rootFilter === 'none', 'apply night-harbor: a dark picture on a dark page leaves the page as it is', state.rootFilter);
  await screenshot('standin-after-apply-night-harbor.png');

  await reload();
  state = await inspect();
  check(state.layers === 0, 'reload after one-shot apply: overlay is gone (CLI session closed; persistence needs a held session)', state);

  const holder = await openSession(target.wsUrl, PORT);
  await holder.send('Page.enable');
  const night = themes.find((t) => t.id === 'night-harbor');
  await holder.send('Page.addScriptToEvaluateOnNewDocument', {
    source: applyExpression({ dataUrl: dataUrls['night-harbor'], opacity: night.opacity, appearance: night.appearance, token: 'held-session' }),
  });
  await reload();
  state = await inspect();
  check(
    state.layers === 1 && state.token === 'held-session' && translucent(state, '#sidebar') && sameAsBaseline(state, baseline, ['#composer', '#send']),
    'reload while a session holds the new-document script: overlay re-applied',
    state,
  );
  await holder.close();
  await reload();
  state = await inspect();
  check(state.layers === 0, 'reload after the holding session closed: overlay gone', state);

  r = await cli(['apply', 'night-harbor', '--no-daemon'], env);
  check(r.code === 0, 'apply night-harbor again exits 0', r);
  r = await cli(['apply', 'paper-light', '--no-daemon'], env);
  check(r.code === 0, 'apply paper-light exits 0', r);
  state = await inspect();
  check(state.layers === 1 && state.wallpaper === 'paper-light', 'apply paper-light: wallpaper swapped, exactly one layer', state);
  check(state.token?.startsWith('paper-light@') && state.colorScheme === 'dark', 'apply paper-light: state belongs to paper-light, color-scheme stays with the dark page', state);
  check(translucent(state, '#sidebar') && translucent(state, '#main'), 'apply paper-light on a dark page: panels keep the usual thin veil', state.elements);
  check(flippedOver(state), 'apply paper-light on a dark page: the page is flipped to the picture\'s side and the wallpaper is flipped back', { root: state.rootFilter, layer: state.layerFilter });
  check(sameAsBaseline(state, baseline, ['#composer', '#send', '#dlg']), 'apply paper-light: textarea, button and dialog untouched', state.elements);

  await pageEval(`document.body.insertAdjacentHTML('beforeend', '<section id="late" class="late"></section>')`);
  await sleep(700);
  state = await inspect();
  check(translucent(state, '#late'), 'panel added after apply is made translucent by the observer', state.elements['#late']);
  await screenshot('standin-after-apply-paper-light.png');

  r = await cli(['restore'], env);
  check(r.code === 0 && JSON.parse(r.stdout).restored === true, 'restore exits 0 and reports restored', r);
  state = await inspect();
  check(state.layers === 0 && state.token === null, 'restore: layer and page state removed', state);
  check(
    sameAsBaseline(state, baseline, ['html', 'body', '#sidebar', '#main', '#composer', '#send', '#dlg']),
    'restore: every inline style and background back to baseline',
    { now: state.elements, baseline: baseline.elements },
  );
  check(state.elements['#late'].style === null && alphaOf(state.elements['#late'].bg) === 1, 'restore: observer-touched panel back to no inline style', state.elements['#late']);
  check(state.colorScheme === baseline.colorScheme, 'restore: color-scheme back to baseline', state.colorScheme);
  check(state.rootFilter === 'none', 'restore: the page is no longer flipped', state.rootFilter);
  await screenshot('standin-after-restore.png');

  await pageEval(`document.body.insertAdjacentHTML('beforeend', '<section id="after" class="late"></section>')`);
  await sleep(700);
  state = await inspect();
  check(state.elements['#after'].style === null, 'after restore no observer is left: a new panel stays untouched', state.elements['#after']);

  r = await cli(['status'], env);
  const status = r.code === 0 ? JSON.parse(r.stdout) : null;
  check(
    status?.debug === 'standin' && status.lastApplied?.themeId === 'paper-light' && status.lastApplied.restored === true,
    'status: debug standin (let through by the test switch), lastApplied paper-light with restored true',
    status ?? r,
  );

  // The app writing its own inline background on a thinned panel: our override steps aside, and the new color is what gets veiled.
  await reload();
  r = await cli(['apply', 'night-harbor', '--no-daemon'], env);
  check(r.code === 0, 'apply night-harbor on a fresh page exits 0', r);
  await pageEval(`document.getElementById('main').style.backgroundColor = 'rgb(200, 0, 0)'`);
  await sleep(700);
  state = await inspect();
  console.log(`      #main after the app paints it red: ${JSON.stringify(state.elements['#main'])}`);
  check(
    /^color\(srgb 0\.78\d* 0 0 \/ 0\.28\)$/.test(state.elements['#main'].bg) && state.elements['#main'].style.includes('rgb(200, 0, 0)'),
    'the app setting its own inline color wins: our old override is gone and the new red is the one veiled at 28%',
    state.elements['#main'],
  );
  r = await cli(['restore'], env);
  state = await inspect();
  check(r.code === 0 && state.layers === 0 && state.elements['#main'].style === 'background-color: rgb(200, 0, 0);', 'restore leaves the app its own red and nothing of ours', state.elements['#main']);

  // Light panels written as oklch(), a stylesheet pushed into <head>, and the app switching to dark on <body>.
  await probe.send('Page.navigate', { url: FIXTURE_OKLCH });
  await sleep(300);
  while ((await pageEval('document.readyState')) !== 'complete') await sleep(100);
  r = await cli(['apply', 'paper-light', '--no-daemon'], env);
  const okl = () =>
    pageEval(`(() => { const s = window.${MARK.key}?.inspect(); const bg = (id) => getComputedStyle(document.getElementById(id)).backgroundColor; return { report: s, side: bg('side'), main: bg('main'), sideStyle: document.getElementById('side').getAttribute('style'), styleWrites: window.__e2eSideWrites ?? null }; })()`);
  let o = await okl();
  console.log(`      oklch page after apply paper-light: ${JSON.stringify(o)}`);
  check(r.code === 0 && o.report?.appAppearance === 'light' && o.report.flipped === false, 'panels written as oklch(0.97 0 0) on a light page: the app reads as light, and a light picture leaves it unflipped', o.report);
  check(Math.abs(alphaOf(o.side) - MATCHED) < 0.01 && Math.abs(alphaOf(o.main) - MATCHED) < 0.01, 'the oklch panels are thinned like any other', o);

  await pageEval(
    `window.__e2eSideWrites = 0; new MutationObserver((rs) => { window.__e2eSideWrites += rs.length; }).observe(document.getElementById('side'), { attributes: true, attributeFilter: ['style'] }); 1`,
  );
  await pageEval(`for (let i = 0; i < 5; i++) { const s = document.createElement('style'); s.textContent = '.x' + i + ' { color: inherit; }'; document.head.append(s); } 1`);
  await sleep(800);
  o = await okl();
  check(o.styleWrites === 0 && o.report.appAppearance === 'light', 'five <style> tags pushed into <head> do not make the overlay forget and redo the panels', o);

  await pageEval(`document.body.classList.add('dark'); 1`);
  await sleep(800);
  o = await okl();
  console.log(`      after the app adds class "dark" to <body>: ${JSON.stringify({ report: o.report, side: o.side })}`);
  check(o.report.appAppearance === 'dark' && o.report.flipped === true && luma(o.side) < 80, 'the app switching to dark on <body> (not the root) is seen: the panels are redone from the dark colors and the page is flipped to the light picture', o);
  r = await cli(['restore'], env);
  check(r.code === 0, 'restore on the oklch page exits 0', r);

  // The flip is a filter on the root. It must not move the app's position: fixed elements (a filter on a lower element would).
  await reload();
  const pin = () => pageEval(`(() => { const b = document.getElementById('pin').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, root: getComputedStyle(document.documentElement).filter, sheets: document.adoptedStyleSheets.length }; })()`);
  const pinBefore = await pin();
  r = await cli(['apply', 'night-harbor', '--no-daemon'], env);
  await sleep(300);
  const pinFlipped = await pin();
  o = await okl();
  console.log(`      #pin before: ${JSON.stringify(pinBefore)} flipped: ${JSON.stringify(pinFlipped)}`);
  check(r.code === 0 && o.report.flipped === true && pinFlipped.root.includes('invert(1)'), 'a dark picture on the light oklch page flips the page', { r, report: o.report, pinFlipped });
  check(['x', 'y', 'w', 'h'].every((k) => pinFlipped[k] === pinBefore[k]), 'the fixed #pin keeps exactly the same box while the page is flipped', { pinBefore, pinFlipped });
  r = await cli(['restore'], env);
  const pinAfter = await pin();
  check(r.code === 0 && pinAfter.root === 'none' && pinAfter.sheets === pinBefore.sheets, 'restore takes the flip stylesheet away again', pinAfter);

  // A page with nothing that can show the wallpaper: the overlay goes in, but apply says so and exits 3.
  await probe.send('Page.navigate', { url: 'data:text/html;charset=utf-8,<!doctype html><title>empty</title><p>只有一行字</p>' });
  await sleep(300);
  while ((await pageEval('document.readyState')) !== 'complete') await sleep(100);
  r = await cli(['apply', 'night-harbor', '--no-daemon'], env);
  check(r.code === 3 && /没有找到任何一块能透出壁纸的面板/.test(r.stderr) && JSON.parse(r.stdout).windows.every((w) => w.panels === 0), 'a page with no panels: apply warns that the wallpaper is likely invisible and exits 3', r);
  r = await cli(['restore'], env);
  check(r.code === 0, 'restore on the empty page exits 0', r);

  // What a relaunch looks like: the window is there, the app draws its panels a moment later. apply waits for them.
  const late = '<!doctype html><title>late</title><body style="margin:0"><script>setTimeout(() => { for (const width of ["30vw", "70vw"]) { const panel = document.createElement("div"); panel.style.cssText = "float:left;height:100vh;background:rgb(40,44,52);width:" + width; document.body.append(panel); } }, 2500);</script>';
  await probe.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(late) });
  await sleep(300);
  while ((await pageEval('document.readyState')) !== 'complete') await sleep(100);
  r = await cli(['apply', 'night-harbor', '--no-daemon'], env);
  check(r.code === 0 && JSON.parse(r.stdout).windows.every((w) => w.panels === 2) && !/没有找到任何一块/.test(r.stderr), 'panels that show up 2.5 seconds after the window: apply waits for them and exits 0', r);
  r = await cli(['restore'], env);
  check(r.code === 0, 'restore on the late page exits 0', r);
  await probe.close();
}

await main();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
