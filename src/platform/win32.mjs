import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { FIELDS } from '../always.mjs';
import { DEBUG_LAUNCH_ARGS } from '../ports.mjs';
import { ENTRY_SCRIPT, REPO_ROOT } from './entry.mjs';

const EXE_NAME = 'grok bot.exe';
const STARTUP_SHORTCUT = 'Grok Bot 换壁纸.lnk';
const execFileAsync = promisify(execFile);

async function powershell(script) {
  const source = `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}

async function powershellJsonArray(script) {
  // ConvertTo-Json flattens anything nested deeper than -Depth into a string; shortcut rows nest three levels.
  const text = await powershell(`ConvertTo-Json -Compress -Depth 6 -InputObject @(${script})`);
  return text ? JSON.parse(text) : [];
}

// PowerShell ends a single-quoted string at any of ' U+2018 U+2019 U+201A U+201B, and doubling the same character escapes it.
export const psQuote = (value) => `'${String(value).replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;

const isAppExe = (path) =>
  typeof path === 'string' && win32.basename(path).toLowerCase() === EXE_NAME && existsSync(path);

async function grokProcesses() {
  const rows = await powershellJsonArray(
    `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*grok*' } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; path = $_.Path } }`,
  );
  return rows.filter((row) => isAppExe(row.path));
}

// After always on, the user's Start menu shortcut targets conhost and names Grok Bot only in its fallback
// (`|| start "" "<exe>"`), so that is read too; otherwise launch could no longer find an app that is not running.
const FALLBACK_EXE = /\|\| start "" (?:"([^"]+)"|(\S+))/;
export function shortcutAppTargets(rows) {
  return rows.flatMap(({ target, args }) => {
    if (win32.basename(String(target ?? '')).toLowerCase() !== 'conhost.exe') return [target];
    const match = FALLBACK_EXE.exec(String(args ?? ''));
    return match ? [match[1] ?? match[2]] : [];
  });
}

async function startMenuShortcutTargets() {
  const rows = await powershellJsonArray(`
    $shell = New-Object -ComObject WScript.Shell
    $dirs = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    Get-ChildItem -LiteralPath $dirs -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -like '*grok*' } |
      ForEach-Object { $l = $shell.CreateShortcut($_.FullName); [pscustomobject]@{ target = $l.TargetPath; args = $l.Arguments } }
  `);
  return shortcutAppTargets(rows);
}

function candidatePaths() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return [
    join(local, 'Programs', 'Grok Bot', 'Grok Bot.exe'),
    join(local, 'Programs', 'GrokBot', 'Grok Bot.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Grok Bot', 'Grok Bot.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Grok Bot', 'Grok Bot.exe'),
  ];
}

const APP_PATH_SOURCES = [
  async () => (await grokProcesses()).map((row) => row.path),
  startMenuShortcutTargets,
  candidatePaths,
];

export function dataDir() {
  return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'grokbot-wallpaper');
}

export async function appPath() {
  for (const source of APP_PATH_SOURCES) {
    const hit = (await source()).find(isAppExe);
    if (hit) return hit;
  }
  return null;
}

export async function running() {
  return (await grokProcesses()).length > 0;
}

// The relaunch path's real effects. src/relaunch.mjs decides when each one runs; these only do one thing each.
const sameExe = (exe) => `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${psQuote(exe)} }`;

export async function isRunning(exe) {
  return (await powershell(`[bool](${sameExe(exe)})`)) === 'True';
}

// Asks every window of this exe to close, the same as clicking its X. An app that lives on in the tray keeps running.
export async function requestQuit(exe) {
  await powershell(`${sameExe(exe)} | ForEach-Object { [void]$_.CloseMainWindow() }`);
}

export async function forceQuit(exe) {
  await powershell(`${sameExe(exe)} | Stop-Process -Force -ErrorAction SilentlyContinue`);
}

// Resolves once the process has started; an exe that cannot start rejects instead of crashing the command.
export function launch(exe, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, DEBUG_LAUNCH_ARGS, { detached: true, stdio: 'ignore', env, windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const conhostPath = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');

// conhost --headless gives node a console nobody sees, so neither login nor apply flashes a window.
const entryArguments = (...command) => `--headless "${process.execPath}" "${ENTRY_SCRIPT}" ${command.join(' ')}`;
const watchArguments = (withApp = false) => entryArguments('watch', ...(withApp ? ['--with-app'] : []));

// GROKBOT_STARTUP_DIR exists for tests only, so they never write the real Startup folder.
const startupDir = async () => process.env.GROKBOT_STARTUP_DIR || (await powershell(`[Environment]::GetFolderPath('Startup')`));

const shortcutPath = async () => join(await startupDir(), STARTUP_SHORTCUT);

export async function installAutostart() {
  await powershell(`
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(await shortcutPath())})
    $link.TargetPath = ${psQuote(conhostPath())}
    $link.Arguments = ${psQuote(watchArguments())}
    $link.WorkingDirectory = ${psQuote(REPO_ROOT)}
    $link.WindowStyle = 7
    $link.Description = 'Grok Bot 换壁纸：登录后在后台套用上次的主题'
    $link.Save()
  `);
}

export async function autostartInstalled() {
  const path = await shortcutPath();
  if (!existsSync(path)) return false;
  const [link] = await powershellJsonArray(
    `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}); [pscustomobject]@{ target = $link.TargetPath; arguments = $link.Arguments }`,
  );
  return (
    link?.target.toLowerCase() === conhostPath().toLowerCase() &&
    link.arguments.toLowerCase() === watchArguments().toLowerCase()
  );
}

export async function uninstallAutostart() {
  await rm(await shortcutPath(), { force: true });
}

// Measured: conhost --headless started through Node's spawn exits at once, while Start-Process keeps it and node alive.
// withApp: the helper leaves when Grok Bot does (only the "with wallpaper" icon asks for this).
export async function startDaemon({ withApp = false } = {}) {
  await powershell(
    `Start-Process -FilePath ${psQuote(conhostPath())} -ArgumentList ${psQuote(watchArguments(withApp))} -WorkingDirectory ${psQuote(REPO_ROOT)} -WindowStyle Hidden`,
  );
}

// The desktop icon that opens Grok Bot with the wallpaper. Nothing else (its own shortcut, the Start menu) is touched.
export const LAUNCHER_NAME = 'Grok Bot（带壁纸）';
const launchArguments = () => entryArguments('launch');

// GROKBOT_DESKTOP_DIR exists for tests only, so they never write the real desktop. The real one may sit under
// OneDrive with Chinese in its path; PowerShell prints it as UTF-8 (see powershell()).
const desktopDir = async () => process.env.GROKBOT_DESKTOP_DIR || (await powershell(`[Environment]::GetFolderPath('Desktop')`));

export const launcherPath = async () => join(await desktopDir(), `${LAUNCHER_NAME}.lnk`);

// Overwrites an older one. The icon is Grok Bot's own, taken from its exe.
export async function installLauncher(exe) {
  const path = await launcherPath();
  await powershell(`
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)})
    $link.TargetPath = ${psQuote(conhostPath())}
    $link.Arguments = ${psQuote(launchArguments())}
    $link.WorkingDirectory = ${psQuote(REPO_ROOT)}
    $link.IconLocation = ${psQuote(`${exe},0`)}
    $link.WindowStyle = 7
    $link.Description = '打开带壁纸的 Grok Bot（Grok Bot 换壁纸）'
    $link.Save()
  `);
  return path;
}

// Installed means the shortcut is there and runs this repo's entry script with launch.
export async function launcherInstalled() {
  const path = await launcherPath();
  if (!existsSync(path)) return false;
  const [link] = await powershellJsonArray(
    `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}); [pscustomobject]@{ target = $link.TargetPath; arguments = $link.Arguments }`,
  );
  return link?.target.toLowerCase() === conhostPath().toLowerCase() && link.arguments.toLowerCase() === launchArguments().toLowerCase();
}

export async function uninstallLauncher() {
  const path = await launcherPath();
  await rm(path, { force: true });
  return path;
}

// ---- always on: the user's own Grok Bot shortcuts open it with the wallpaper ----------------------------------
// src/always.mjs decides what to change and keeps the backup; the functions here only read and write shortcuts.

export const alwaysOnSupported = true;

// GROKBOT_SHORTCUT_DIRS exists for tests only (several folders joined with ;), so they never read or write the real
// Start menu, desktop or taskbar. All-users folders are left out on purpose: changing them needs an administrator.
const SHORTCUT_DIRS_SCRIPT = `@([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'))`;
const shortcutDirsOverride = () =>
  process.env.GROKBOT_SHORTCUT_DIRS === undefined
    ? null
    : process.env.GROKBOT_SHORTCUT_DIRS.split(';').map((dir) => dir.trim()).filter(Boolean);
const dirsExpression = (dirs) => (dirs ? `@(${dirs.map(psQuote).join(', ') || "''"})` : SHORTCUT_DIRS_SCRIPT);

const readFieldsScript = (variable) =>
  `[pscustomobject]@{ ${FIELDS.map((field) => `${field} = [string]${variable}.${field}`).join('; ')} }`;

export async function shortcutDirs() {
  const override = shortcutDirsOverride();
  return override ?? powershellJsonArray(`${SHORTCUT_DIRS_SCRIPT} | Where-Object { $_ }`);
}

// Every .lnk under the folders (subfolders too) with its fields, in one PowerShell run.
export async function scanShortcuts() {
  const [result] = await powershellJsonArray(`
    $shell = New-Object -ComObject WScript.Shell
    $dirs = @(${dirsExpression(shortcutDirsOverride())} | Where-Object { $_ })
    $links = @(foreach ($dir in $dirs) {
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
      Get-ChildItem -LiteralPath $dir -Recurse -File -Force -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq '.lnk' } | ForEach-Object {
        try { $l = $shell.CreateShortcut($_.FullName); [pscustomobject]@{ path = $_.FullName; fields = ${readFieldsScript('$l')} } } catch {}
      }
    })
    [pscustomobject]@{ dirs = $dirs; links = $links }
  `);
  return { dirs: result?.dirs ?? [], links: (result?.links ?? []).map(normalizeLink) };
}

const normalizeLink = ({ path, fields }) => ({ path, fields: { ...fields, WindowStyle: Number(fields.WindowStyle) } });

// The listed shortcuts as they are now; a file that is gone comes back with exists: false.
export async function readShortcuts(paths) {
  if (paths.length === 0) return [];
  const rows = await powershellJsonArray(`
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in @(${paths.map(psQuote).join(', ')})) {
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        $l = $shell.CreateShortcut($path); [pscustomobject]@{ path = $path; exists = $true; fields = ${readFieldsScript('$l')} }
      } else { [pscustomobject]@{ path = $path; exists = $false; fields = $null } }
    }
  `);
  return rows.map((row) => (row.exists ? { ...normalizeLink(row), exists: true } : { path: row.path, exists: false, fields: null }));
}

// Writes the fields, then reads the file back fresh and returns what it says. Every field is set again after the
// target, because setting the target moves a start-in that was the old target's folder to the new one's (measured).
// An empty hotkey is left alone: there is none to keep, and assigning '' is not a valid hotkey.
export async function writeShortcut(path, fields) {
  const [after] = await powershellJsonArray(`
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)})
    $link.TargetPath = ${psQuote(fields.TargetPath)}
    $link.Arguments = ${psQuote(fields.Arguments)}
    $link.WorkingDirectory = ${psQuote(fields.WorkingDirectory)}
    $link.IconLocation = ${psQuote(fields.IconLocation)}
    $link.Description = ${psQuote(fields.Description)}
    $link.WindowStyle = ${Number(fields.WindowStyle)}
    ${fields.Hotkey ? `$link.Hotkey = ${psQuote(fields.Hotkey)}` : ''}
    $link.Save()
    $back = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)})
    ${readFieldsScript('$back')}
  `);
  return after ? { ...after, WindowStyle: Number(after.WindowStyle) } : null;
}

const cmdPath = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
// GROKBOT_TEST_ENTRY_SCRIPT exists for tests only: a stub entry, or one that is not there, to prove the fallback.
const alwaysEntry = () => process.env.GROKBOT_TEST_ENTRY_SCRIPT || ENTRY_SCRIPT;

// conhost splits its command line into arguments and quotes them again before starting cmd (measured: a quoted path
// with no space in it reaches cmd bare). So every piece is written the way conhost will pass it on: quoted exactly when
// it holds whitespace. A piece that would then reach cmd in a form cmd reads differently is refused, never guessed at.
const CMD_BARE_SPECIAL = /[&()^|<>,;=]/;
function cmdPathToken(path, what) {
  if (/["%\r\n]/.test(path)) throw new Error(`${what}的路径里有 " 或 % 这类命令行会改写的字符：${path}`);
  if (/\s/.test(path)) {
    if (path.endsWith('\\')) throw new Error(`${what}的路径以 \\ 结尾：${path}`);
    return `"${path}"`;
  }
  if (CMD_BARE_SPECIAL.test(path)) throw new Error(`${what}的路径里有 & ( ) 这类字符又没有空格，经过 conhost 后会被命令行误读：${path}`);
  return path;
}

// The shortcut's own arguments go to Grok Bot on the fallback path. Only plain words are taken (--flag=value is fine);
// quotes or characters cmd treats specially are refused, since cmd sits between the shortcut and the app.
function originalArgumentTokens(args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  const bad = tokens.find((token) => /["%&()^|<>\r\n]/.test(token));
  if (bad !== undefined) throw new Error(`它自带的参数里有引号或 & ( ) % 这类字符（${args}），经过命令行转一道可能变样`);
  return tokens;
}

// What one of the user's shortcuts becomes. Its name, folder, start-in, description, window style and hotkey stay;
// it starts a hidden console (conhost --headless, no window) running cmd, which runs this tool's launch and, only if
// that cannot run or ends with a non-zero code, starts Grok Bot itself the way the shortcut did. launch ending with 0
// (including "the user said no") starts nothing more. The icon stays Grok Bot's: an empty icon location meant "the
// target's own icon", so it now names the exe explicitly. Returns { fields } or { refuse: reason }.
export function alwaysOnShortcut(original) {
  try {
    const pieces = [
      '--headless',
      cmdPathToken(cmdPath(), 'cmd.exe '),
      '/d /v:off /c (',
      cmdPathToken(process.execPath, 'node '),
      cmdPathToken(alwaysEntry(), '本工具入口脚本'),
      'launch || start ""',
      cmdPathToken(original.TargetPath, 'Grok Bot '),
      ...originalArgumentTokens(original.Arguments ?? ''),
      ')',
    ];
    const iconPath = String(original.IconLocation ?? '').replace(/,-?\d+$/, '').trim();
    const IconLocation = iconPath ? original.IconLocation : `${original.TargetPath},0`;
    return { fields: { ...original, TargetPath: conhostPath(), Arguments: pieces.join(' '), IconLocation } };
  } catch (error) {
    return { refuse: error.message };
  }
}

// Starting the exe a second time hands over to the running instance, which brings its window forward and exits.
export function bringToFront(exe) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const DIALOG_TITLE = 'Grok Bot 换壁纸';
export const CONFIRM_TIMEOUT_S = 60;
// WScript.Shell Popup types: 4 Yes/No, 32 question icon, 48 exclamation icon, 4096 stays on top of other windows.
const POPUP = { confirm: 4 + 32 + 4096, notify: 48 + 4096 };
const POPUP_YES = 6;

// The PowerShell for one dialog; prints the button code (6 yes, 7 no, 1 OK, -1 timed out).
export const popupScript = (text, seconds, type) =>
  `(New-Object -ComObject WScript.Shell).Popup(${psQuote(text)}, ${seconds}, ${psQuote(DIALOG_TITLE)}, ${type})`;

// GROKBOT_NO_DIALOG exists for tests only: no real dialog ever shows, a confirm reads as no.
const dialogsOff = () => process.env.GROKBOT_NO_DIALOG === '1';

// True only for 是; 否, closing the box or the 60-second timeout all read as no.
export async function confirm(text) {
  if (dialogsOff()) return false;
  return Number(await powershell(popupScript(text, CONFIRM_TIMEOUT_S, POPUP.confirm))) === POPUP_YES;
}

export async function notify(text) {
  if (dialogsOff()) return;
  await powershell(popupScript(text, 0, POPUP.notify));
}
