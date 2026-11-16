#!/usr/bin/env node
// Measures how long the overlay's page scans take on a synthetic chat page in a throwaway headless Edge.
// Same method as the review: a light app shell padded to N nodes, then one span appended every 30 ms for 5 s
// (and a second load: a <style> pushed into <head> every 100 ms). Only timer callbacks the overlay schedules are timed.
//
//   node scripts/bench-scan.mjs                       measures src/overlay.mjs
//   node scripts/bench-scan.mjs --overlay <file.mjs>  measures another copy, e.g. the previous commit's
//   node scripts/bench-scan.mjs --json                prints the raw numbers as JSON too
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluate, openSession } from '../src/cdp.mjs';
import { e2ePort, killTree, ROOT, startStandin } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const { values } = parseArgs({ options: { overlay: { type: 'string' }, json: { type: 'boolean', default: false } } });
const overlayFile = resolve(values.overlay ?? join(ROOT, 'src', 'overlay.mjs'));
const { applyExpression } = await import(pathToFileURL(overlayFile).href);

const RUN_MS = 5000;
const LONG_TASK_MS = 50;
const SCENARIOS = [
  { label: '3800 节点，每 30ms 追加 span', nodes: 3800, load: 'append', overlay: true },
  { label: '1.8 万节点，每 30ms 追加 span', nodes: 18000, load: 'append', overlay: true },
  { label: '4.8 万节点，每 30ms 追加 span', nodes: 48000, load: 'append', overlay: true },
  { label: '1.8 万节点，每 100ms 往 head 插 style', nodes: 18000, load: 'style', overlay: true },
  { label: '1.8 万节点，每 30ms 追加 span，不挂覆盖层', nodes: 18000, load: 'append', overlay: false },
  // A dark picture on the light page: the whole page is flipped by a root filter.
  { label: '1.8 万节点，每 30ms 追加 span，翻转开着', nodes: 18000, load: 'append', overlay: true, appearance: 'dark' },
  { label: '4.8 万节点，每 30ms 追加 span，翻转开着', nodes: 48000, load: 'append', overlay: true, appearance: 'dark' },
  { label: '1.8 万节点，每 100ms 插 style，翻转开着', nodes: 18000, load: 'style', overlay: true, appearance: 'dark' },
];

// Light shell with the real app's measured colors: two big panels, white cards every few messages.
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>bench</title><style>
html, body { margin: 0; height: 100%; background: rgb(252, 252, 252); color: rgb(28, 28, 28); font: 14px system-ui, sans-serif; }
.app { display: flex; height: 100vh; }
#side { width: 22vw; padding: 12px; box-sizing: border-box; background: rgb(245, 245, 245); overflow: hidden; }
#main { flex: 1; padding: 16px; box-sizing: border-box; background: rgb(252, 252, 252); overflow: auto; }
.msg { margin: 6px 0; padding: 6px 10px; border-radius: 10px; }
.card { background: rgb(255, 255, 255); }
.mine { background: rgb(28, 28, 28); color: #fff; width: 30vw; margin-left: auto; }
</style></head><body><div class="app"><aside id="side"></aside><main id="main"><div id="list"></div></main></div></body></html>`;

// Runs in the page: pads the document to about `target` elements with chat-like messages.
function build(target) {
  const list = document.getElementById('list');
  const side = document.getElementById('side');
  for (let i = 0; i < 40; i++) side.insertAdjacentHTML('beforeend', `<div class="item"><span>对话 ${i}</span></div>`);
  let n = 0;
  while (document.getElementsByTagName('*').length < target) {
    const kind = n % 7 === 0 ? 'msg card' : n % 5 === 0 ? 'msg mine' : 'msg';
    list.insertAdjacentHTML(
      'beforeend',
      `<div class="${kind}"><p><span>第 ${n} 条</span> <em>一些</em> <b>文字</b> <span>和</span> <code>code</code></p><ul><li><span>要点</span></li><li><span>要点</span></li></ul></div>`,
    );
    n++;
  }
  return document.getElementsByTagName('*').length;
}

// Runs in the page before the overlay goes in: times every setTimeout callback (the overlay's scans run in one) and counts long tasks.
function instrument(longTaskMs) {
  const bench = { scans: [], longTasks: [], recording: false };
  window.__bench = bench;
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) =>
    realSetTimeout(() => {
      const started = performance.now();
      try {
        fn(...rest);
      } finally {
        if (bench.recording) bench.scans.push(performance.now() - started);
      }
    }, ms);
  new PerformanceObserver((list) => {
    if (!bench.recording) return;
    for (const entry of list.getEntries()) if (entry.duration >= longTaskMs) bench.longTasks.push(entry.duration);
  }).observe({ type: 'longtask', buffered: false });
  return true;
}

function startLoad(kind, runMs) {
  const bench = window.__bench;
  bench.recording = true;
  const list = document.getElementById('list');
  let i = 0;
  const every = kind === 'append' ? 30 : 100;
  const timer = setInterval(() => {
    if (kind === 'append') {
      const span = document.createElement('span');
      span.textContent = ` 追加 ${i++}`;
      list.lastElementChild.append(span);
    } else {
      const style = document.createElement('style');
      style.textContent = `.x${i++} { color: inherit; }`;
      document.head.append(style);
    }
  }, every);
  return new Promise((done) =>
    setTimeout(() => {
      clearInterval(timer);
      // One more beat so the last scheduled scan lands inside the window.
      setTimeout(() => {
        bench.recording = false;
        done({ scans: bench.scans, longTasks: bench.longTasks, nodes: document.getElementsByTagName('*').length });
      }, 800);
    }, runMs),
  );
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (ms) => `${ms.toFixed(1)}ms`;

async function measure(session, pageUrl, scenario) {
  await session.send('Page.navigate', { url: pageUrl });
  await sleep(300);
  while ((await evaluate(session, 'document.readyState').catch(() => 'loading')) !== 'complete') await sleep(100);
  const built = await evaluate(session, `(${build})(${scenario.nodes})`);
  await evaluate(session, `(${instrument})(${LONG_TASK_MS})`);
  let firstScanMs = null;
  if (scenario.overlay) {
    const started = Date.now();
    await evaluate(session, applyExpression({ dataUrl: TINY_PNG, opacity: 1, appearance: scenario.appearance ?? 'light', token: `bench-${Date.now()}`, strength: null }));
    firstScanMs = Date.now() - started;
    await sleep(800);
  }
  const flipped = await evaluate(session, 'getComputedStyle(document.documentElement).filter');
  const result = await evaluate(session, `(${startLoad})(${JSON.stringify(scenario.load)}, ${RUN_MS})`);
  const scans = result.scans.filter((ms) => ms > 0.05);
  return {
    ...scenario,
    built,
    endNodes: result.nodes,
    firstScanMs,
    rootFilter: flipped,
    scanCount: scans.length,
    median: median(scans),
    max: scans.length ? Math.max(...scans) : 0,
    over50: scans.filter((ms) => ms >= LONG_TASK_MS).length,
    longTasks: result.longTasks.length,
    longTaskMax: result.longTasks.length ? Math.max(...result.longTasks) : 0,
  };
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-bench-'));
  const pageFile = join(scratch, 'bench.html');
  await writeFile(pageFile, PAGE);
  let standin;
  const rows = [];
  try {
    standin = await startStandin(PORT, join(scratch, 'profile'), pathToFileURL(pageFile).href);
    const session = await openSession(standin.target.wsUrl, PORT);
    await session.send('Page.enable');
    console.log(`overlay: ${overlayFile}`);
    console.log(`stand-in: ${standin.browser} (pid ${standin.pid}) on 127.0.0.1:${PORT}`);
    for (const scenario of SCENARIOS) {
      const row = await measure(session, pathToFileURL(pageFile).href, scenario);
      rows.push(row);
      console.log(
        `${row.label.padEnd(34)} 起始 ${row.built} 结束 ${row.endNodes} 节点 | 首次全扫 ${row.firstScanMs ?? '-'}ms | 扫描 ${row.scanCount} 次 中位 ${fmt(row.median)} 最大 ${fmt(row.max)} ≥50ms ${row.over50} 次 | 长任务 ${row.longTasks} 次 最长 ${fmt(row.longTaskMax)} | 根滤镜 ${row.rootFilter}`,
      );
    }
    await session.close();
  } finally {
    if (standin) killTree(standin.pid);
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  if (values.json) console.log(JSON.stringify(rows, null, 2));
}

await main();
