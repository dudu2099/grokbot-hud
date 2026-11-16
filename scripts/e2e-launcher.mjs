#!/usr/bin/env node
// The "Grok Bot（带壁纸）" icon end to end, on Windows, against a stand-in browser on test ports.
// Never the real app: launch always runs with GROKBOT_APP_PATH pointing at a path that does not exist, so the only
// branch it can take is "the debug port already answers" (the allowed stand-in). The icon goes into a temp desktop;
// dialogs are off (GROKBOT_NO_DIALOG). The helper's two waits are shortened with the test-only variables.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { evaluate, openSession } from '../src/cdp.mjs';
import { MARK } from '../src/overlay.mjs';
import { cli, ENTRY, killTree, PACKS_DIR, ROOT, startStandin, e2ePort } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const LINK_NAME = 'Grok Bot（带壁纸）.lnk';
const CONHOST = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');
const GONE_MS = 4000;
const GRACE_MS = 8000;

if (process.platform !== 'win32') {
  console.log('Windows only: the macOS .command icon has not been run anywhere.');
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

async function waitFor(read, ok, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await sleep(200);
    value = await read();
  }
  return value;
}

const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
function ps(script, env = {}) {
  const source = `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

const readShortcut = (path) =>
  JSON.parse(
    ps(
      `$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}); [pscustomobject]@{ TargetPath = $l.TargetPath; Arguments = $l.Arguments; IconLocation = $l.IconLocation; WorkingDirectory = $l.WorkingDirectory; WindowStyle = $l.WindowStyle } | ConvertTo-Json -Compress`,
    ),
  );

// Who listens on the panel port, its parent, and whether either owns a window.
function listenerTree() {
  const text = ps(`
    $c = Get-NetTCPConnection -State Listen -LocalPort ${PANEL_PORT} -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { 'null'; return }
    $node = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($node.ParentProcessId)"
    [pscustomobject]@{
      localAddress = $c.LocalAddress
      pid = $node.ProcessId
      name = $node.Name
      commandLine = $node.CommandLine
      hwnd = [int64](Get-Process -Id $node.ProcessId).MainWindowHandle
      parentPid = $parent.ProcessId
      parentName = $parent.Name
      parentHwnd = [int64](Get-Process -Id $parent.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle
    } | ConvertTo-Json -Compress
  `);
  return JSON.parse(text);
}

// node processes running this repo's entry with the launch command (started from the icon).
const launchProcesses = () =>
  JSON.parse(
    ps(
      `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ${psQuote(`*${ENTRY}*`)} -and $_.CommandLine -match ' launch$' } | ForEach-Object { $_.ProcessId })`,
    ) || '[]',
  );

const alive = (pid) => ps(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`) === 'True';

function killOurWatch() {
  const tree = listenerTree();
  if (tree && tree.commandLine?.includes(ENTRY)) {
    killTree(tree.parentName === 'conhost.exe' ? tree.parentPid : tree.pid);
    console.log(`cleanup: killed leftover watch ${tree.pid}`);
  }
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-e2e-launcher-'));
  const desktop = join(scratch, '桌面 OneDrive');
  await mkdir(desktop);
  // An existing file is all launcher on needs from the app (its path becomes the icon). It is never run.
  const fakeApp = join(scratch, 'fake-app', 'Grok Bot.exe');
  await mkdir(join(scratch, 'fake-app'));
  await writeFile(fakeApp, 'not a program');
  const env = {
    GROKBOT_DEBUG_PORT: String(PORT),
    GROKBOT_PANEL_PORT: String(PANEL_PORT),
    GROKBOT_DATA_DIR: join(scratch, 'data'),
    GROKBOT_THEMES_DIR: PACKS_DIR,
    GROKBOT_ALLOW_STANDIN: '1',
    GROKBOT_STARTUP_DIR: join(scratch, 'startup-never-created'),
    GROKBOT_DESKTOP_DIR: desktop,
    GROKBOT_NO_DIALOG: '1',
    // The safety net: nothing that runs launch can find, close or start an app.
    GROKBOT_APP_PATH: join(scratch, 'no-such-app', 'Grok Bot.exe'),
    GROKBOT_TEST_APP_GONE_MS: String(GONE_MS),
    GROKBOT_TEST_APP_GRACE_MS: String(GRACE_MS),
  };
  if ((await listening(PORT)) || (await listening(PANEL_PORT))) throw new Error(`端口 ${PORT} 或 ${PANEL_PORT} 已被占用`);
  let standin;
  try {
    const link = await launcherRoundTrip({ ...env, GROKBOT_APP_PATH: fakeApp }, desktop, fakeApp);
    await graceExit(env);
    standin = await startStandin(PORT, join(scratch, 'profile'));
    console.log(`stand-in: pid ${standin.pid} on 127.0.0.1:${PORT}`);
    await iconOnStandin(env, link, standin);
    standin = null;
    check(!existsSync(join(scratch, 'startup-never-created')), 'nothing was written to the (test) Startup folder: launch installs no login item');
  } finally {
    killOurWatch();
    if (standin) killTree(standin.pid);
    for (const pid of launchProcesses()) killTree(pid);
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(
      `cleanup: port ${PORT} listening now: ${await listening(PORT)}, port ${PANEL_PORT} listening now: ${await listening(PANEL_PORT)}, removed ${scratch} (exists now: ${existsSync(scratch)})`,
    );
  }
}

// Builds the icon, then puts it back on (overwrite), reads it back, removes it; status follows each step.
async function launcherRoundTrip(env, desktop, fakeApp) {
  const link = join(desktop, LINK_NAME);
  let r = await cli(['launcher', 'on'], env);
  console.log(`      launcher on stdout: ${r.stdout.replace(/\s+/g, ' ')}`);
  console.log(`      launcher on stderr: ${r.stderr.trim()}`);
  const on = r.code === 0 ? JSON.parse(r.stdout) : null;
  check(on?.launcher?.installed === true && on.launcher.path === link, `launcher on exits 0 and reports ${link}`, r);
  check(existsSync(link), 'the shortcut file exists in the temp desktop (a path with Chinese and a space)');
  r = await cli(['launcher', 'on'], env);
  check(r.code === 0 && existsSync(link), 'launcher on again overwrites it without complaint', r);

  const read = readShortcut(link);
  console.log(`      TargetPath:       ${read.TargetPath}`);
  console.log(`      Arguments:        ${read.Arguments}`);
  console.log(`      IconLocation:     ${read.IconLocation}`);
  console.log(`      WorkingDirectory: ${read.WorkingDirectory}`);
  console.log(`      WindowStyle:      ${read.WindowStyle}`);
  check(read.TargetPath.toLowerCase() === CONHOST.toLowerCase(), 'target is conhost.exe', read);
  check(read.Arguments === `--headless "${process.execPath}" "${ENTRY}" launch`, 'arguments are --headless "<node>" "<this repo entry>" launch', read);
  check(read.IconLocation === `${fakeApp},0`, "icon is the app exe's own icon (index 0)", read);
  check(read.WorkingDirectory.replace(/\\$/, '') === ROOT.replace(/\\$/, ''), 'start-in is the repo folder', read);

  r = await cli(['status'], env);
  check(JSON.parse(r.stdout).launcher === true, 'status: launcher true', r.stdout);

  r = await cli(['launcher', 'off'], env);
  console.log(`      launcher off stdout: ${r.stdout.replace(/\s+/g, ' ')}`);
  check(r.code === 0 && JSON.parse(r.stdout).launcher.installed === false && !existsSync(link), 'launcher off exits 0 and the file is gone', r);
  r = await cli(['status'], env);
  check(JSON.parse(r.stdout).launcher === false, 'status: launcher false', r.stdout);
  r = await cli(['launcher', 'off'], env);
  check(r.code === 0, 'launcher off with nothing there still exits 0', r);

  r = await cli(['launcher', 'on'], { ...env, GROKBOT_APP_PATH: join(desktop, 'missing', 'Grok Bot.exe') });
  check(r.code === 1 && !existsSync(link) && /没有建「Grok Bot（带壁纸）」图标/.test(r.stderr), 'launcher on with no app builds nothing and says why', r);

  // Put it back for the double-click below.
  r = await cli(['launcher', 'on'], env);
  check(r.code === 0 && existsSync(link), 'launcher on again for the run below', r);
  return link;
}

// A --with-app helper that never sees the app leaves at the (shortened) grace.
async function graceExit(env) {
  const started = Date.now();
  const r = await cli(['watch', '--with-app'], env);
  const took = Date.now() - started;
  console.log(`      watch --with-app with no app: exit ${r.code} after ${took} ms; last line: ${r.stderr.trim().split('\n').at(-2)}`);
  check(r.code === 0 && took >= GRACE_MS && took < GRACE_MS + 6000 && /内一直没见到 Grok Bot，小助手退出/.test(r.stderr), `never seeing the app, watch --with-app exits on its own after the ${GRACE_MS / 1000} s grace`, r);
  check(!(await listening(PANEL_PORT)), `port ${PANEL_PORT} free after it left`);
}

async function iconOnStandin(env, link, standin) {
  // Opening the .lnk goes through ShellExecute, like a double-click. The test env is inherited from here.
  ps(`Start-Process -FilePath ${psQuote(link)}`, env);
  const up = await waitFor(() => listening(PANEL_PORT), Boolean, 15000);
  check(up, `the icon brings a helper up on ${PANEL_PORT}`);
  const tree = listenerTree();
  console.log(`      listener: ${JSON.stringify(tree)}`);
  check(tree?.name === 'node.exe' && tree.commandLine.includes(ENTRY) && tree.commandLine.endsWith(' watch --with-app'), 'the helper runs as watch --with-app', tree);
  check(tree?.parentName === 'conhost.exe' && tree.hwnd === 0 && tree.parentHwnd === 0, 'the helper sits under a headless conhost and has no window', tree);

  const leftLaunch = await waitFor(launchProcesses, (pids) => pids.length === 0, 15000);
  check(leftLaunch.length === 0, 'the launch process the icon started has exited by itself', leftLaunch);

  const probe = await openSession(standin.target.wsUrl, PORT);
  const page = () =>
    evaluate(
      probe,
      `({ hosts: document.querySelectorAll('[${MARK.attr}="panel"]').length, images: document.querySelectorAll('[${MARK.attr}="image"]').length, token: window['${MARK.key}']?.token ?? null })`,
    );
  const seen = await waitFor(page, (p) => p.hosts === 1 && p.images === 1, 10000);
  console.log(`      stand-in page: ${JSON.stringify(seen)}`);
  check(seen.hosts === 1 && seen.images === 1 && /^night-harbor@/.test(seen.token ?? ''), 'the stand-in shows the wallpaper (first shipped theme) and the panel', seen);
  await probe.close();

  // A second click while everything is up: the helper is left as it is.
  const again = await cli(['launch'], env);
  console.log(`      second launch: exit ${again.code}; stderr: ${again.stderr.trim().replace(/\n/g, ' | ')}`);
  const tree2 = listenerTree();
  check(again.code === 0 && tree2?.pid === tree.pid, 'a second launch exits 0 and leaves the running helper alone (same pid)', { again, tree2 });

  // Close the "app": the gone time counts from the last look that saw it, which is up to one 2-second look before
  // the kill, and the exit is noticed on a look; so it lands between GONE_MS - 2 s and GONE_MS + 2 s after the kill.
  const closedAt = Date.now();
  killTree(standin.pid);
  const freed = await waitFor(() => listening(PANEL_PORT), (v) => !v, GONE_MS + 10000);
  const took = Date.now() - closedAt;
  console.log(`      stand-in killed; panel port free after ${took} ms`);
  check(!freed && took >= GONE_MS - 2000 && took <= GONE_MS + 4000, `after the stand-in is gone the helper leaves on its own after about ${GONE_MS / 1000} s, freeing ${PANEL_PORT}`, { freed, took });
  const gone = await waitFor(() => !alive(tree.pid) && !alive(tree.parentPid), Boolean, 5000);
  check(gone, `node ${tree.pid} and its conhost ${tree.parentPid} have exited`);
  check(!(await listening(PORT)), `stand-in port ${PORT} is free`);
}

await main();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
