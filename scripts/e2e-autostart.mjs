#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { evaluate, openSession } from '../src/cdp.mjs';
import { MARK } from '../src/overlay.mjs';
import { cli, ENTRY, killTree, PACKS_DIR, startStandin, e2ePort } from './standin.mjs';

const PORT = e2ePort('GBT_E2E_DEBUG_PORT', 19333);
const PANEL_PORT = e2ePort('GBT_E2E_PANEL_PORT', 19334);
const SHORTCUT = 'Grok Bot 换壁纸.lnk';
const CONHOST = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');

if (process.platform !== 'win32') {
  console.log('Windows only: the macOS LaunchAgent path has not been run anywhere.');
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
      `$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}); [pscustomobject]@{ TargetPath = $l.TargetPath; Arguments = $l.Arguments; WorkingDirectory = $l.WorkingDirectory; WindowStyle = $l.WindowStyle } | ConvertTo-Json -Compress`,
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

const alive = (pid) => ps(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`) === 'True';

function killOurWatch() {
  const tree = listenerTree();
  if (tree && tree.commandLine?.includes(ENTRY)) {
    killTree(tree.parentName === 'conhost.exe' ? tree.parentPid : tree.pid);
    console.log(`cleanup: killed leftover watch ${tree.pid}`);
  }
}

function expectHiddenWatch(tree, label) {
  console.log(`      listener: ${JSON.stringify(tree)}`);
  check(tree?.localAddress === '127.0.0.1' && tree.name === 'node.exe' && tree.commandLine.includes(ENTRY) && tree.commandLine.endsWith(' watch'), `${label}: node watch listens on 127.0.0.1:${PANEL_PORT}`, tree);
  check(tree?.parentName === 'conhost.exe' && tree.hwnd === 0 && tree.parentHwnd === 0, `${label}: parent is conhost and neither process has a window (MainWindowHandle 0)`, tree);
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'gbt-e2e-autostart-'));
  const startup = join(scratch, 'startup');
  await mkdir(startup);
  const env = {
    GROKBOT_DEBUG_PORT: String(PORT),
    GROKBOT_PANEL_PORT: String(PANEL_PORT),
    GROKBOT_DATA_DIR: join(scratch, 'data'),
    GROKBOT_THEMES_DIR: PACKS_DIR,
    // The stand-in is a headless Edge, not Grok Bot; this test-only switch lets it through on the test port.
    GROKBOT_ALLOW_STANDIN: '1',
    GROKBOT_STARTUP_DIR: startup,
  };
  if ((await listening(PORT)) || (await listening(PANEL_PORT))) throw new Error(`端口 ${PORT} 或 ${PANEL_PORT} 已被占用`);
  let standin;
  try {
    await shortcutRoundTrip(env, startup);
    standin = await startStandin(PORT, join(scratch, 'profile'));
    console.log(`stand-in: pid ${standin.pid} on 127.0.0.1:${PORT}`);
    await applyStartsEverything(env, startup, standin.target);
  } finally {
    killOurWatch();
    if (standin) killTree(standin.pid);
    await sleep(500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(`cleanup: port ${PANEL_PORT} listening now: ${await listening(PANEL_PORT)}, removed ${scratch} (exists now: ${existsSync(scratch)})`);
  }
}

async function shortcutRoundTrip(env, startup) {
  const link = join(startup, SHORTCUT);
  let r = await cli(['autostart', 'on'], env);
  check(r.code === 0 && JSON.parse(r.stdout).autostart === true, 'autostart on exits 0 and reports installed', r);
  check(existsSync(link), `shortcut written at ${link}`);
  const read = readShortcut(link);
  console.log(`      TargetPath:       ${read.TargetPath}`);
  console.log(`      Arguments:        ${read.Arguments}`);
  console.log(`      WorkingDirectory: ${read.WorkingDirectory}`);
  console.log(`      WindowStyle:      ${read.WindowStyle}`);
  check(read.TargetPath.toLowerCase() === CONHOST.toLowerCase(), 'shortcut target is conhost.exe', read);
  check(read.Arguments === `--headless "${process.execPath}" "${ENTRY}" watch`, 'shortcut arguments are --headless "<node>" "<this repo entry>" watch', read);

  // Launching the .lnk itself goes through ShellExecute, the same path Explorer takes at login. The test env is inherited.
  ps(`Start-Process -FilePath ${psQuote(link)}`, env);
  const up = await waitFor(() => listening(PANEL_PORT), Boolean, 10000);
  check(up, `launching the shortcut brings watch up on ${PANEL_PORT} (so the test env reached it)`);
  const tree = listenerTree();
  expectHiddenWatch(tree, 'shortcut launch');

  r = await cli(['status'], env);
  const status = JSON.parse(r.stdout);
  check(status.panel === true && status.autostart === true, 'status: panel true, autostart true', status);

  r = await cli(['autostart', 'off'], env);
  const off = JSON.parse(r.stdout);
  console.log(`      autostart off: ${r.stdout.replace(/\s+/g, ' ')}`);
  check(r.code === 0 && off.autostart === false && off.daemon.stopped === true, 'autostart off exits 0, reports removed and the daemon stopped', off);
  check(!existsSync(link), 'shortcut removed');
  check(!(await listening(PANEL_PORT)), `port ${PANEL_PORT} is free`);
  const gone = await waitFor(() => !alive(tree.pid) && !alive(tree.parentPid), Boolean, 5000);
  check(gone, `node ${tree?.pid} and its conhost ${tree?.parentPid} have exited`);
}

async function applyStartsEverything(env, startup, target) {
  const link = join(startup, SHORTCUT);
  const r = await cli(['apply', 'night-harbor'], env);
  const out = r.code === 0 ? JSON.parse(r.stdout) : null;
  console.log(`      apply output: autostart ${JSON.stringify(out?.autostart)}, daemon ${JSON.stringify(out?.daemon)}`);
  check(out?.autostart?.installed === true && out.autostart.error === null, 'apply without --no-daemon installs autostart (into the temp Startup dir)', out ?? r);
  check(out?.daemon?.started === true && out.daemon.error === null, 'apply without --no-daemon starts watch in the background', out ?? r);
  check(existsSync(link), 'shortcut exists after apply');
  expectHiddenWatch(listenerTree(), 'apply-started daemon');

  const probe = await openSession(target.wsUrl, PORT);
  const hosts = await waitFor(() => evaluate(probe, `document.querySelectorAll('[${MARK.attr}="panel"]').length`), (n) => n === 1, 5000);
  check(hosts === 1, 'the apply-started watch put the panel into the stand-in window', hosts);
  await probe.close();

  const off = JSON.parse((await cli(['autostart', 'off'], env)).stdout);
  check(off.daemon.stopped === true && !existsSync(link) && !(await listening(PANEL_PORT)), 'autostart off removes it and stops the apply-started watch', off);
}

await main();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
