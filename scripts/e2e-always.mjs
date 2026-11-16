#!/usr/bin/env node
// always on / off end to end, on Windows, in a temp folder that stands in for the Start menu, desktop and taskbar.
// Never the real shortcuts and never the real app: the search folders, data folder and app path all point into the temp
// folder, and "Grok Bot" is a tiny window-less program built here that only writes its command line to a file.
// Opening a changed shortcut goes through Start-Process, the same ShellExecute a double-click uses.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cli, e2ePort, ENTRY } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const CONHOST = join(SYSTEM32, 'conhost.exe');
const CSC = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
// Processes whose new visible window would be the "black box" the user must never see.
const CONSOLE_LIKE = new Set(['conhost', 'cmd', 'node', 'powershell', 'pwsh', 'windowsterminal', 'openconsole', 'grok bot', '']);

if (process.platform !== 'win32') {
  console.log('Windows only: macOS has no shortcuts to change.');
  process.exit(0);
}

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

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const psSource = (script) => `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`;
const encoded = (script) => Buffer.from(psSource(script), 'utf16le').toString('base64');
function ps(script, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

const FIELDS = ['TargetPath', 'Arguments', 'WorkingDirectory', 'IconLocation', 'Description', 'WindowStyle', 'Hotkey'];
const readShortcut = (path) =>
  JSON.parse(ps(`$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}); [pscustomobject]@{ ${FIELDS.map((f) => `${f} = $l.${f}`).join('; ')} } | ConvertTo-Json -Compress`));

function makeShortcut(path, { target, args = '', workdir = '', icon = null, description = '', hotkey = '', style = 1 }) {
  ps(`
    $l = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)})
    $l.TargetPath = ${psQuote(target)}
    $l.Arguments = ${psQuote(args)}
    $l.WorkingDirectory = ${psQuote(workdir)}
    ${icon === null ? '' : `$l.IconLocation = ${psQuote(icon)}`}
    $l.Description = ${psQuote(description)}
    $l.WindowStyle = ${style}
    ${hotkey ? `$l.Hotkey = ${psQuote(hotkey)}` : ''}
    $l.Save()
  `);
}

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashes = (paths) => Object.fromEntries(paths.map((path) => [path, existsSync(path) ? hash(path) : null]));
const runsOf = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : []);

// The stand-in for Grok Bot: a window-less program that appends its own command line to runs.log next to it.
const FAKE_APP_SOURCE = `using System; using System.IO;
class FakeGrokBot { static void Main() {
  File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "runs.log"), Environment.CommandLine + "\\r\\n", new System.Text.UTF8Encoding(false));
} }`;

// The stand-in for this tool's entry script: mode.txt next to it says ok (start the fake app once, like launch does,
// then exit 0) or fail (exit 3 without starting anything). Both stay alive a moment so the window watch sees them.
const STUB_ENTRY = `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = readFileSync(join(import.meta.dirname, 'mode.txt'), 'utf8').trim();
if (process.argv[2] !== 'launch') process.exit(9);
if (mode === 'ok') spawn(process.env.GBT_E2E_FAKE_APP, ['--from-launch'], { detached: true, stdio: 'ignore' }).unref();
setTimeout(() => process.exit(mode === 'ok' ? 0 : 3), 1500);
`;

// Lists every top-level window that becomes visible while it runs (polled every 30 ms against a baseline), with the
// name of the process that owns it. Ready and result go through files, since a piped PowerShell may hold its output.
function watchWindows(seconds, dir) {
  const ready = join(dir, `windows-ready-${Date.now()}`);
  const out = `${ready}.json`;
  const script = `
    Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class GbtE2eWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Visible() {
    var list = new List<string>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) { uint pid; GetWindowThreadProcessId(h, out pid); var sb = new StringBuilder(256); GetWindowText(h, sb, 256); list.Add(h.ToInt64() + "|" + pid + "|" + sb); } return true; }, IntPtr.Zero);
    return list;
  }
}
"@
    $base = @{}; foreach ($w in [GbtE2eWindows]::Visible()) { $base[$w.Split('|')[0]] = 1 }
    Set-Content -LiteralPath ${psQuote(ready)} -Value 'ready'
    $seen = @{}; $samples = 0; $deadline = (Get-Date).AddSeconds(${seconds})
    while ((Get-Date) -lt $deadline) {
      $samples++
      foreach ($w in [GbtE2eWindows]::Visible()) {
        $p = $w.Split('|', 3)
        if (-not $base.ContainsKey($p[0]) -and -not $seen.ContainsKey($p[0])) {
          $name = (Get-Process -Id ([int]$p[1]) -ErrorAction SilentlyContinue).ProcessName
          $seen[$p[0]] = [pscustomobject]@{ name = [string]$name; title = $p[2] }
        }
      }
      Start-Sleep -Milliseconds 30
    }
    [pscustomobject]@{ samples = $samples; windows = @($seen.Values) } | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath ${psQuote(out)} -Encoding UTF8
  `;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { stdio: 'ignore', windowsHide: true });
  const done = new Promise((resolve) => child.once('exit', resolve));
  return {
    async ready() {
      for (let i = 0; i < 100 && !existsSync(ready); i++) await sleep(100);
      if (!existsSync(ready)) throw new Error('窗口监视没起来');
    },
    async result() {
      await done;
      return JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
    },
  };
}

// Runs the real helper (watch) against the temp folders until done() says so or the time is up, then asks it to quit.
// No app answers on the test debug port, so all it does is look around every two seconds.
async function withWatch(env, done, ms) {
  const child = spawn(process.execPath, [ENTRY, 'watch'], {
    env: { ...process.env, GROKBOT_ALLOW_STANDIN: '1', GROKBOT_NO_DIALOG: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (log += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const deadline = Date.now() + ms;
  let ok = false;
  while (Date.now() < deadline && !(ok = await done())) await sleep(300);
  await fetch(`http://127.0.0.1:${PANEL_PORT}/api/quit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  await Promise.race([exited, sleep(5000).then(() => child.kill())]);
  return { ok, log };
}

// Opens the shortcut the way a double-click does and waits until runs.log stops growing.
async function openShortcut(link, log, scratch, env) {
  const before = runsOf(log).length;
  const watch = watchWindows(7, scratch);
  await watch.ready();
  ps(`Start-Process -FilePath ${psQuote(link)}`, env);
  const deadline = Date.now() + 6000;
  while (runsOf(log).length === before && Date.now() < deadline) await sleep(100);
  const { samples, windows } = await watch.result();
  const newRuns = runsOf(log).slice(before);
  const consoleWindows = windows.filter((w) => CONSOLE_LIKE.has(w.name.toLowerCase()));
  return { newRuns, windows, consoleWindows, samples };
}

async function main() {
  if (!existsSync(CSC)) throw new Error(`找不到 C# 编译器 ${CSC}，没法造假的 Grok Bot`);
  if ((await listening(PORT)) || (await listening(PANEL_PORT))) throw new Error(`端口 ${PORT} 或 ${PANEL_PORT} 已被占用`);
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-e2e-always-'));
  try {
    await run(scratch);
  } finally {
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(`cleanup: removed ${scratch} (exists now: ${existsSync(scratch)}); port ${PORT} listening: ${await listening(PORT)}, port ${PANEL_PORT} listening: ${await listening(PANEL_PORT)}`);
  }
}

async function run(scratch) {
  const start = join(scratch, '开始菜单', 'Programs');
  const desktop = join(scratch, '桌面 OneDrive');
  const taskbar = join(scratch, '任务栏', 'User Pinned', 'TaskBar');
  const appDir = join(scratch, 'Grok Bot (测试) & co');
  const sub = join(start, '工具 (测试) & 其他');
  const stubDir = join(scratch, '入口 (stub)');
  for (const dir of [start, desktop, taskbar, appDir, sub, stubDir, join(scratch, 'only-other')]) await mkdir(dir, { recursive: true });

  const fakeApp = join(appDir, 'Grok Bot.exe');
  const runLog = join(appDir, 'runs.log');
  await writeFile(join(scratch, 'fake.cs'), FAKE_APP_SOURCE);
  execFileSync(CSC, ['-nologo', '-target:winexe', `-out:${fakeApp}`, join(scratch, 'fake.cs')], { stdio: 'pipe', windowsHide: true });
  const stub = join(stubDir, 'stub entry.mjs');
  await writeFile(stub, STUB_ENTRY);
  await writeFile(join(stubDir, 'mode.txt'), 'ok');

  const data = join(scratch, 'data');
  const backup = join(data, 'always-on-backup.json');
  const env = {
    GROKBOT_DEBUG_PORT: String(PORT),
    GROKBOT_PANEL_PORT: String(PANEL_PORT),
    GROKBOT_DATA_DIR: data,
    GROKBOT_SHORTCUT_DIRS: [start, desktop, taskbar].join(';'),
    GROKBOT_DESKTOP_DIR: desktop,
    GROKBOT_STARTUP_DIR: join(scratch, 'startup-never-created'),
    GROKBOT_APP_PATH: fakeApp,
    GROKBOT_TEST_ENTRY_SCRIPT: stub,
    GROKBOT_NO_DIALOG: '1',
  };
  const iconEnv = { ...env, GBT_E2E_FAKE_APP: fakeApp };

  const links = {
    plain: join(start, 'Grok Bot.lnk'),
    withArgs: join(desktop, 'Grok Bot.lnk'),
    nested: join(sub, 'Grok Bot 副本.lnk'),
    pinned: join(taskbar, 'Grok Bot.lnk'),
    other: join(desktop, '记事本.lnk'),
    ours: join(desktop, 'Grok Bot（带壁纸）.lnk'),
  };
  makeShortcut(links.plain, { target: fakeApp, workdir: appDir, description: 'Grok Bot' });
  makeShortcut(links.withArgs, { target: fakeApp, args: '--lang=zh --e2e-orig=desktop', workdir: appDir, icon: `${fakeApp},0`, description: '桌面上的 Grok Bot' });
  // A hotkey and a minimized window style, to show both are kept. The temp folder is not the real Start menu, so Explorer never registers the hotkey.
  makeShortcut(links.nested, { target: fakeApp, workdir: appDir, description: '子目录里的', hotkey: 'Ctrl+Alt+Shift+F9', style: 7 });
  makeShortcut(links.pinned, { target: fakeApp, workdir: appDir });
  makeShortcut(links.other, { target: join(SYSTEM32, 'notepad.exe'), description: '别的程序' });
  makeShortcut(join(scratch, 'only-other', '记事本.lnk'), { target: join(SYSTEM32, 'notepad.exe') });
  let r = await cli(['launcher', 'on'], env);
  check(r.code === 0 && existsSync(links.ours), 'our own extra icon is put on the temp desktop with launcher on', r);

  const all = Object.values(links);
  const changeable = [links.plain, links.withArgs, links.nested, links.pinned];
  const original = hashes(all);
  const originalFields = Object.fromEntries(all.map((path) => [path, readShortcut(path)]));
  console.log(`      original IconLocation (plain): ${originalFields[links.plain].IconLocation}`);

  // Nothing to change: exits non-zero and writes nothing.
  r = await cli(['always', 'on'], { ...env, GROKBOT_SHORTCUT_DIRS: join(scratch, 'only-other') });
  check(r.code === 1 && /没有找到指向 Grok Bot/.test(r.stderr) && !existsSync(backup), 'always on with only a shortcut to another program: exit 1, says so, no backup', r);

  r = await cli(['always', 'on'], env);
  console.log(`      always on stderr:\n${r.stderr.trim().replace(/^/gm, '        ')}`);
  const onReport = r.code === 0 ? JSON.parse(r.stdout).alwaysOn : null;
  check(r.code === 0 && onReport.changed.length === 4 && changeable.every((path) => onReport.changed.includes(path)), 'always on exits 0 and changes exactly the four Grok Bot shortcuts', r);
  check(existsSync(backup), 'the backup file exists in the data folder');

  const afterOn = hashes(all);
  check(afterOn[links.other] === original[links.other], 'the shortcut to another program is byte-for-byte unchanged');
  check(afterOn[links.ours] === original[links.ours], 'our own extra icon is byte-for-byte unchanged');
  for (const path of changeable) {
    const before = originalFields[path];
    const now = readShortcut(path);
    const expectedIcon = before.IconLocation.replace(/,-?\d+$/, '') ? before.IconLocation : `${fakeApp},0`;
    const ok =
      now.TargetPath.toLowerCase() === CONHOST.toLowerCase() &&
      now.Arguments.startsWith('--headless ') &&
      now.Arguments.includes(` "${stub}" launch || start "" "${fakeApp}"`) &&
      now.Arguments.endsWith(`${before.Arguments ? ` ${before.Arguments}` : ''} )`) &&
      now.IconLocation === expectedIcon &&
      now.Description === before.Description &&
      now.WorkingDirectory === before.WorkingDirectory &&
      now.WindowStyle === before.WindowStyle &&
      now.Hotkey === before.Hotkey;
    check(ok, `changed as planned, description/start-in/window style/hotkey kept, icon still Grok Bot's: ${path.slice(scratch.length)}`, { before, now });
  }
  const { shortcutAppTargets } = await import('../src/platform/win32.mjs');
  const found = shortcutAppTargets(changeable.map((path) => readShortcut(path)).map((f) => ({ target: f.TargetPath, args: f.Arguments })));
  check(found.length === 4 && found.every((exe) => exe === fakeApp), 'the app is still found through a changed shortcut (the Start menu is where the real machine finds it)', found);
  const shown = readShortcut(links.withArgs);
  console.log(`      changed shortcut (desktop, with its own arguments):\n        TargetPath:   ${shown.TargetPath}\n        Arguments:    ${shown.Arguments}\n        IconLocation: ${shown.IconLocation}\n        Arguments length: ${shown.Arguments.length}`);

  r = await cli(['status'], env);
  const statusOn = JSON.parse(r.stdout).alwaysOn;
  console.log(`      status alwaysOn: ${JSON.stringify(statusOn)}`);
  check(statusOn.on === true && statusOn.shortcuts === 4 && statusOn.modified === 4, 'status: on, 4 shortcuts, 4 in the changed state', statusOn);

  // The fallback, opened like a double-click.
  let run = await openShortcut(links.withArgs, runLog, scratch, iconEnv);
  console.log(`      entry there, launch ok: runs ${JSON.stringify(run.newRuns)}; ${run.samples} window samples, new windows ${JSON.stringify(run.windows)}`);
  await sleep(2500);
  const lateRuns = runsOf(runLog).length;
  check(run.newRuns.length === 1 && run.newRuns[0].includes('--from-launch') && lateRuns === 1, 'launch ending with 0: Grok Bot started once, by launch, and not again by the fallback', { run, lateRuns });
  check(run.consoleWindows.length === 0 && run.samples > 20, 'no console-like window became visible', run);

  await rename(stub, `${stub}.away`);
  run = await openShortcut(links.withArgs, runLog, scratch, iconEnv);
  console.log(`      entry gone: runs ${JSON.stringify(run.newRuns)}; new windows ${JSON.stringify(run.windows)}`);
  await rename(`${stub}.away`, stub);
  check(run.newRuns.length === 1 && run.newRuns[0].includes('--lang=zh --e2e-orig=desktop') && !run.newRuns[0].includes('--from-launch'), 'entry script gone: the fallback started Grok Bot itself, once, with the shortcut\'s own arguments', run.newRuns);
  check(run.consoleWindows.length === 0, 'no console-like window became visible', run);

  await writeFile(join(stubDir, 'mode.txt'), 'fail');
  run = await openShortcut(links.plain, runLog, scratch, iconEnv);
  console.log(`      launch exits 3: runs ${JSON.stringify(run.newRuns)}; new windows ${JSON.stringify(run.windows)}`);
  check(run.newRuns.length === 1 && !run.newRuns[0].includes('--from-launch'), 'launch ending non-zero: the fallback started Grok Bot itself, once', run.newRuns);
  check(run.consoleWindows.length === 0, 'no console-like window became visible', run);

  // On again: nothing changes, not even the backup.
  const backupBefore = hash(backup);
  r = await cli(['always', 'on'], env);
  const again = r.code === 0 ? JSON.parse(r.stdout).alwaysOn : null;
  check(r.code === 0 && again.changed.length === 0 && again.already.length === 4, 'always on again exits 0, changes nothing, reports four already changed', r);
  const afterAgain = hashes(all);
  check(all.every((path) => afterAgain[path] === afterOn[path]), 'every shortcut is byte-for-byte what the first on left');
  check(hash(backup) === backupBefore, 'the backup file is byte-for-byte unchanged');

  // The app rewrites its own Start menu shortcut on every launch: same fields as the original, new bytes. The helper
  // changes it again; a shortcut someone changed to something else, and everything untouched, stays as it is.
  const appliedPlain = readShortcut(links.plain);
  // A new file, as the app makes one: saving over the changed file would keep its icon field.
  await rm(links.plain);
  makeShortcut(links.plain, { target: fakeApp, workdir: appDir, description: 'Grok Bot' });
  const rewritten = readShortcut(links.plain);
  check(FIELDS.every((f) => String(rewritten[f]) === String(originalFields[links.plain][f])) && hash(links.plain) !== original[links.plain], 'stand-in for the app rewriting its shortcut: the original fields again, in a file with other bytes', rewritten);
  const untouchedBefore = hashes([links.withArgs, links.nested, links.pinned, links.other, links.ours]);
  let kept = await withWatch(env, () => readShortcut(links.plain).TargetPath.toLowerCase() === CONHOST.toLowerCase(), 15000);
  const reapplied = readShortcut(links.plain);
  check(kept.ok && FIELDS.every((f) => String(reapplied[f]) === String(appliedPlain[f])), 'the running helper put the rewritten shortcut back to open with the wallpaper', { reapplied, log: kept.log });
  check(/图标被写回了原样/.test(kept.log), 'and said so in its log', kept.log);
  const untouchedAfter = hashes(Object.keys(untouchedBefore));
  check(Object.keys(untouchedBefore).every((path) => untouchedAfter[path] === untouchedBefore[path]) && hash(backup) === backupBefore, 'every other shortcut and the backup are byte-for-byte unchanged', { untouchedBefore, untouchedAfter });

  r = await cli(['always', 'off'], env);
  console.log(`      always off stderr:\n${r.stderr.trim().replace(/^/gm, '        ')}`);
  const offReport = r.code === 0 ? JSON.parse(r.stdout).alwaysOff : null;
  check(r.code === 0 && offReport.restored.length === 4, 'always off exits 0 and restores four', r);
  const afterOff = hashes(all);
  const mismatched = all.filter((path) => afterOff[path] !== original[path]);
  check(mismatched.length === 0, 'every shortcut has exactly its original file hash again', mismatched);
  check(!existsSync(backup), 'the backup file is gone');
  r = await cli(['status'], env);
  const statusOff = JSON.parse(r.stdout).alwaysOn;
  check(statusOff.on === false && statusOff.modified === 0, 'status: off', statusOff);

  // A second round with the real entry script: launch cannot find the app (it is pointed at a path that does not exist
  // when the icon runs), exits non-zero, and the fallback opens Grok Bot.
  const realEnv = { ...env };
  delete realEnv.GROKBOT_TEST_ENTRY_SCRIPT;
  r = await cli(['always', 'on'], realEnv);
  check(r.code === 0 && JSON.parse(r.stdout).alwaysOn.changed.length === 4, 'always on with the real entry script changes the four again', r);
  run = await openShortcut(links.pinned, runLog, scratch, { ...iconEnv, GROKBOT_APP_PATH: join(scratch, 'no-such-app', 'Grok Bot.exe') });
  console.log(`      real launch, app not found: runs ${JSON.stringify(run.newRuns)}; new windows ${JSON.stringify(run.windows)}`);
  check(run.newRuns.length === 1 && !run.newRuns[0].includes('remote-debugging'), 'the real launch failed (no app) and the fallback started Grok Bot itself, once', run.newRuns);
  check(run.consoleWindows.length === 0, 'no console-like window became visible', run);

  // Someone else changes one of ours; off leaves it alone and says so.
  ps(`$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(links.nested)}); $l.Description = '被别人改过'; $l.Save()`);
  const tampered = hash(links.nested);
  r = await cli(['always', 'off'], realEnv);
  console.log(`      always off (one changed by someone else) stderr:\n${r.stderr.trim().replace(/^/gm, '        ')}`);
  const off2 = JSON.parse(r.stdout).alwaysOff;
  check(r.code === 1 && off2.restored.length === 3 && off2.changedByOthers.length === 1 && off2.changedByOthers[0].path === links.nested, 'off restores three, reports the one changed by someone else, and exits 1 (not fully off)', r);
  check(hash(links.nested) === tampered, 'the one changed by someone else was not touched');
  const others = hashes(all.filter((path) => path !== links.nested));
  check(Object.entries(others).every(([path, value]) => value === original[path]), 'the other shortcuts are byte-for-byte original');
  const left = JSON.parse(readFileSync(backup, 'utf8'));
  check(left.entries.length === 1 && left.entries[0].path === links.nested && left.entries[0].originalSha256 === original[links.nested] && left.off === true, 'the backup now holds only that one, with its very first original, marked as switched off', left.entries.map((e) => e.path));
  r = await cli(['status'], realEnv);
  const statusLeft = JSON.parse(r.stdout).alwaysOn;
  console.log(`      status alwaysOn: ${JSON.stringify(statusLeft)}`);
  check(statusLeft.on === false && statusLeft.leftover === true && statusLeft.shortcuts === 1 && statusLeft.modified === 0, 'status: off, with 1 shortcut left in the backup as a record', statusLeft);

  // After off the helper changes nothing, even when that leftover shortcut reads like its original again.
  await rm(links.nested);
  makeShortcut(links.nested, { target: fakeApp, workdir: appDir, description: '子目录里的', hotkey: 'Ctrl+Alt+Shift+F9', style: 7 });
  const leftoverFields = readShortcut(links.nested);
  const leftoverHash = hash(links.nested);
  kept = await withWatch(realEnv, () => false, 7000);
  check(FIELDS.every((f) => String(leftoverFields[f]) === String(originalFields[links.nested][f])) && hash(links.nested) === leftoverHash, 'after always off: the helper ran for 7 s next to a shortcut that reads like its original and did not touch it', { leftoverFields, log: kept.log });
  check(!existsSync(join(scratch, 'startup-never-created')), 'nothing was written to the (test) Startup folder');
}

await main();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
