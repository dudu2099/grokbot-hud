import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listTargets, probeDebug } from '../src/cdp.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ENTRY = join(ROOT, 'scripts', 'grokbot-wallpaper.mjs');
export const PACKS_DIR = join(ROOT, 'test', 'fixtures', 'packs');
export const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'standin.html')).href;
export const SHOTS = join(ROOT, 'docs', 'verify');

// Test ports can be moved off the defaults so two runs never share a stand-in. The real app's ports are refused outright.
const REAL_PORTS = new Set([19222, 19223]);
export function e2ePort(name, fallback) {
  const raw = process.env[name];
  const port = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${name} 必须是 1024 到 65535 之间的整数，现在是 "${raw}"`);
  if (REAL_PORTS.has(port)) throw new Error(`${name}=${port} 是真 Grok Bot 用的端口，自测不能用`);
  return port;
}

export const FIXTURE_LIGHT = pathToFileURL(join(ROOT, 'test', 'fixtures', 'standin-light.html')).href;
export const FIXTURE_OKLCH = pathToFileURL(join(ROOT, 'test', 'fixtures', 'standin-oklch.html')).href;

const BROWSERS = [
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

// A throwaway headless Edge/Chrome on a test debug port, standing in for Grok Bot so the real app is never touched.
export async function startStandin(port, profile, url = FIXTURE) {
  const browser = BROWSERS.find((path) => existsSync(path));
  if (!browser) throw new Error('找不到 Edge 或 Chrome');
  if (await probeDebug(port)) throw new Error(`端口 ${port} 已被占用，换个空闲端口再跑`);
  const child = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--hide-scrollbars',
      '--window-size=1280,800',
      url,
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 15000;
  let target;
  while (!target && Date.now() < deadline) {
    if (await probeDebug(port)) target = (await listTargets(port)).find((t) => t.type === 'page');
    if (!target) await sleep(250);
  }
  if (!target) {
    killTree(child.pid);
    throw new Error('浏览器的调试口没起来');
  }
  return { browser, pid: child.pid, target };
}

export function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

// Self-tests never show a real dialog box and never write the real desktop, unless a script points the desktop at a temp dir.
const NO_DESKTOP_DIR = join(tmpdir(), 'gbt-e2e-desktop-never-created');
// Nor read or change the user's own Grok Bot shortcuts (always on): its search folders point at a path never created.
const NO_SHORTCUT_DIR = join(tmpdir(), 'gbt-e2e-shortcuts-never-created');

export function cli(args, env) {
  const base = { ...process.env, GROKBOT_ALLOW_STANDIN: '1', GROKBOT_NO_DIALOG: '1', GROKBOT_DESKTOP_DIR: NO_DESKTOP_DIR, GROKBOT_SHORTCUT_DIRS: NO_SHORTCUT_DIR };
  return new Promise((resolve) => {
    execFile(process.execPath, [ENTRY, ...args], { env: { ...base, ...env }, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}
