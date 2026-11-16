#!/usr/bin/env node
// How long an icon click takes before Grok Bot is asked to start. Never the real app: the exe is a file in a temp
// folder that is never run (the preload stops the process at the spawn), the debug and panel ports are test ports.
//   1. the orchestration alone, with every platform call faked (instant);
//   2. the real entry script running launch, real PowerShell queries, stopped at the spawn of the exe;
//   3. Windows' part: from Start-Process on a changed shortcut until node is running inside it.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { launchWithWallpaper } from '../src/launch.mjs';
import { relaunchAndWait } from '../src/relaunch.mjs';
import { ENTRY, PACKS_DIR, e2ePort } from './standin.mjs';

const RUNS = Number(process.env.GBT_BENCH_RUNS ?? 5);
const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const PRELOAD = pathToFileURL(join(import.meta.dirname, 'bench-launch-preload.mjs')).href;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function orchestration() {
  const times = [];
  for (let i = 0; i < 200; i++) {
    const started = performance.now();
    let at = null;
    const app = {
      findApp: async () => 'X:\\fake\\Grok Bot.exe',
      appMissing: () => new Error('missing'),
      isRunning: async () => false,
      requestQuit: async () => {},
      forceQuit: async () => {},
      launch: async () => {
        at = performance.now() - started;
      },
    };
    await launchWithWallpaper({
      checks: [],
      findApp: app.findApp,
      appMissing: app.appMissing,
      identify: async () => ({ state: 'closed', reportedAs: null }),
      isRunning: async () => false,
      bringToFront: async () => {},
      relaunch: () => relaunchAndWait({ app, ready: async () => ({ state: 'grokbot', windows: 1 }), log: () => {}, sleep: async () => {} }),
      confirm: async () => false,
      notify: async () => {},
      panelOwner: async () => 'free',
      startDaemon: async () => {},
      waitDaemon: async () => true,
      store: { readLastApplied: async () => null, writeLastApplied: async () => {} },
      loadThemes: async () => [{ id: 'a' }],
      debugPort: 'x',
      panelPort: 'y',
      now: () => new Date(),
      log: () => {},
    });
    times.push(at);
  }
  return median(times);
}

function realLaunch(scratch, fakeApp) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--import', PRELOAD, ENTRY, 'launch'], {
      env: {
        ...process.env,
        GBT_BENCH_FAKE_APP: fakeApp,
        GBT_BENCH_T0: String(t0),
        GROKBOT_APP_PATH: fakeApp,
        GROKBOT_DEBUG_PORT: String(PORT),
        GROKBOT_PANEL_PORT: String(PANEL_PORT),
        GROKBOT_DATA_DIR: join(scratch, 'data'),
        GROKBOT_THEMES_DIR: PACKS_DIR,
        GROKBOT_NO_DIALOG: '1',
        GROKBOT_DESKTOP_DIR: join(scratch, 'no-desktop'),
        GROKBOT_STARTUP_DIR: join(scratch, 'no-startup'),
        GROKBOT_SHORTCUT_DIRS: join(scratch, 'no-shortcuts'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    child.stderr.on('data', (chunk) => (err += chunk));
    child.once('exit', (code) => {
      const lines = err.split(/\r?\n/).filter((line) => line.startsWith('BENCH '));
      const value = (name) => Number(lines.find((line) => line.startsWith(`BENCH ${name} `))?.split(' ')[2]);
      const ps = lines.filter((line) => line.startsWith('BENCH ps ')).map((line) => line.slice('BENCH ps '.length));
      resolve({ code, nodeStart: value('node-start'), launch: value('launch'), ps, other: err.split(/\r?\n/).filter((l) => l && !l.startsWith('BENCH ')) });
    });
  });
}

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const ps = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();

async function shortcutToNode(scratch, fakeApp) {
  const stub = join(scratch, 'stub entry.mjs');
  const mark = join(scratch, 'node-started.txt');
  await writeFile(stub, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(mark)}, String(Date.now()));\n`);
  const link = join(scratch, 'Grok Bot.lnk');
  ps(`$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(link)}); $l.TargetPath = ${psQuote(fakeApp)}; $l.Save()`);
  process.env.GROKBOT_TEST_ENTRY_SCRIPT = stub;
  const win32 = await import('../src/platform/win32.mjs');
  const { fields } = win32.alwaysOnShortcut({ TargetPath: fakeApp, Arguments: '', WorkingDirectory: '', IconLocation: ',0', Description: '', WindowStyle: 1, Hotkey: '' });
  await win32.writeShortcut(link, fields);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    await rm(mark, { force: true });
    const t0 = Number(ps(`$t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); Start-Process -FilePath ${psQuote(link)}; $t`));
    for (let j = 0; j < 100 && !existsSync(mark); j++) await sleep(50);
    times.push(Number(readFileSync(mark, 'utf8')) - t0);
  }
  return times;
}

const scratch = await mkdtemp(join(tmpdir(), 'gbt-bench-launch-'));
try {
  const fakeApp = join(scratch, 'Grok Bot', 'Grok Bot.exe');
  await mkdir(join(scratch, 'Grok Bot'));
  await writeFile(fakeApp, 'never run');
  console.log(`1. orchestration with faked platform calls, start -> launch(exe): median ${(await orchestration()).toFixed(3)} ms over 200 runs`);
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await realLaunch(scratch, fakeApp));
  console.log(`2. real entry script, launch, real PowerShell, stopped at the spawn of the exe (${RUNS} runs):`);
  runs.forEach((run, i) => {
    console.log(`   run ${i + 1}: exit ${run.code}; node running after ${run.nodeStart} ms; launch(exe) at ${run.launch} ms`);
    for (const line of run.ps) console.log(`          powershell ${line}`);
    if (!Number.isFinite(run.launch)) console.log(`          stderr: ${run.other.join(' | ')}`);
  });
  console.log(`   median: node running after ${median(runs.map((r) => r.nodeStart))} ms, launch(exe) at ${median(runs.map((r) => r.launch))} ms`);
  if (process.platform === 'win32') {
    const times = await shortcutToNode(scratch, fakeApp);
    console.log(`3. Start-Process on a changed shortcut -> node running inside it: ${times.join(', ')} ms (median ${median(times)} ms)`);
  }
} finally {
  await sleep(300);
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
