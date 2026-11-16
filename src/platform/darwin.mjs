// 未在真机验证：写这一版时手边没有 Mac，下面的命令全部照交接手册 7.1 独立实现，没跑过。
// 登录自启（LaunchAgent + launchctl bootstrap/bootout）和后台起 watch 也一样，一行都没在 Mac 上跑过。
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEBUG_LAUNCH_ARGS } from '../ports.mjs';
import { ENTRY_SCRIPT, REPO_ROOT } from './entry.mjs';

const APP_NAME = 'Grok Bot';
const LAUNCH_AGENT = 'com.dudu.grokbot-hud';
const MAIN_BINARY = `/${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;
const execFileAsync = promisify(execFile);

const run = async (file, args) => (await execFileAsync(file, args, { encoding: 'utf8' })).stdout.trim();

const candidatePaths = () => [`/Applications/${APP_NAME}.app`, join(homedir(), 'Applications', `${APP_NAME}.app`)];

// pgrep -x "Grok Bot" misses the main process (reference project's note), so ask Launch Services first.
async function osascriptSaysRunning() {
  try {
    return (await run('osascript', ['-e', `application "${APP_NAME}" is running`])) === 'true';
  } catch {
    return false;
  }
}

async function psShowsMainBinary() {
  try {
    return (await run('ps', ['-axo', 'command'])).split('\n').some((line) => line.includes(MAIN_BINARY));
  } catch {
    return false;
  }
}

export function dataDir() {
  return join(homedir(), 'Library', 'Application Support', 'grokbot-wallpaper');
}

export async function appPath() {
  return candidatePaths().find((path) => existsSync(path)) ?? null;
}

export async function running() {
  return (await osascriptSaysRunning()) || (await psShowsMainBinary());
}

// The relaunch path's real effects (src/relaunch.mjs paces them). Unverified on a Mac like the rest of this file.
export async function isRunning() {
  return running();
}

export async function requestQuit() {
  await run('osascript', ['-e', `tell application "${APP_NAME}" to quit`]);
}

export async function forceQuit() {
  await execFileAsync('pkill', ['-9', '-f', MAIN_BINARY]).catch(() => {});
}

// open -a keeps Launch Services from spawning a second copy that drops the flags.
export async function launch(app, env) {
  await execFileAsync('open', ['-a', app, '--args', ...DEBUG_LAUNCH_ARGS], { encoding: 'utf8', env });
}

// GROKBOT_STARTUP_DIR exists for tests only, so they never write the real LaunchAgents folder.
const agentsDir = () => process.env.GROKBOT_STARTUP_DIR || join(homedir(), 'Library', 'LaunchAgents');
const plistPath = () => join(agentsDir(), `${LAUNCH_AGENT}.plist`);
const launchDomain = () => `gui/${process.getuid()}`;
const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const xml = (text) => text.replace(/[<>&'"]/g, (char) => XML_ESCAPES[char]);

function plist() {
  const args = [process.execPath, ENTRY_SCRIPT, 'watch'].map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(REPO_ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

const bootout = () => run('launchctl', ['bootout', `${launchDomain()}/${LAUNCH_AGENT}`]).catch(() => {});

export async function installAutostart() {
  await mkdir(agentsDir(), { recursive: true });
  await writeFile(plistPath(), plist());
  await bootout();
  await run('launchctl', ['bootstrap', launchDomain(), plistPath()]);
}

export async function autostartInstalled() {
  try {
    return (await readFile(plistPath(), 'utf8')) === plist();
  } catch {
    return false;
  }
}

export async function uninstallAutostart() {
  await bootout();
  await rm(plistPath(), { force: true });
}

export async function startDaemon({ withApp = false } = {}) {
  spawn(process.execPath, [ENTRY_SCRIPT, 'watch', ...(withApp ? ['--with-app'] : [])], { cwd: REPO_ROOT, detached: true, stdio: 'ignore' }).unref();
}

// 以下「带壁纸启动」的图标、确认框、通知同样没在 Mac 上跑过。
// The icon is an executable .command script on the desktop; double-clicking it opens Terminal and runs launch.
export const LAUNCHER_NAME = 'Grok Bot（带壁纸）';
// GROKBOT_DESKTOP_DIR exists for tests only, so they never write the real desktop.
const desktopDir = () => process.env.GROKBOT_DESKTOP_DIR || join(homedir(), 'Desktop');
export const launcherPath = async () => join(desktopDir(), `${LAUNCHER_NAME}.command`);
const shQuote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;
const launcherScript = () => `#!/bin/sh\ncd ${shQuote(REPO_ROOT)} && exec ${shQuote(process.execPath)} ${shQuote(ENTRY_SCRIPT)} launch\n`;

export async function installLauncher() {
  const path = await launcherPath();
  await mkdir(desktopDir(), { recursive: true });
  await writeFile(path, launcherScript(), { mode: 0o755 });
  return path;
}

export async function launcherInstalled() {
  try {
    return (await readFile(await launcherPath(), 'utf8')) === launcherScript();
  } catch {
    return false;
  }
}

export async function uninstallLauncher() {
  const path = await launcherPath();
  await rm(path, { force: true });
  return path;
}

// open -a without arguments only activates the running app.
export async function bringToFront(app) {
  await execFileAsync('open', ['-a', app]);
}

const DIALOG_TITLE = 'Grok Bot 换壁纸';
const CONFIRM_TIMEOUT_S = 60;
// GROKBOT_NO_DIALOG exists for tests only: no real dialog ever shows, a confirm reads as no.
const dialogsOff = () => process.env.GROKBOT_NO_DIALOG === '1';

// The text goes in as an argument (item 1 of argv), so nothing in it needs AppleScript escaping.
// True only for 是; 否 (which cancels), the 60-second timeout and any error read as no.
export async function confirm(text) {
  if (dialogsOff()) return false;
  try {
    const out = await execFileAsync(
      'osascript',
      ['-e', 'on run argv', '-e', `display dialog (item 1 of argv) with title "${DIALOG_TITLE}" buttons {"否", "是"} default button "是" cancel button "否" giving up after ${CONFIRM_TIMEOUT_S}`, '-e', 'end run', text],
      { encoding: 'utf8' },
    );
    return /button returned:是/.test(out.stdout) && !/gave up:true/.test(out.stdout);
  } catch {
    return false;
  }
}

export async function notify(text) {
  if (dialogsOff()) return;
  await execFileAsync('osascript', ['-e', 'on run argv', '-e', `display dialog (item 1 of argv) with title "${DIALOG_TITLE}" buttons {"好"} default button "好"`, '-e', 'end run', text], {
    encoding: 'utf8',
  });
}
