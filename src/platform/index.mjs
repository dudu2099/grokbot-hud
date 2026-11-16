import { existsSync } from 'node:fs';
import { UserError } from '../errors.mjs';

const ADAPTERS = {
  win32: () => import('./win32.mjs'),
  darwin: () => import('./darwin.mjs'),
};

export const APP_PATH_ENV = 'GROKBOT_APP_PATH';

// Where the user says Grok Bot is, when the tool cannot find it by itself. Empty means "find it yourself".
export const appPathOverride = () => process.env[APP_PATH_ENV]?.trim() || null;

const FIND_HINT = {
  win32: [
    `如果你知道它装在哪，可以设环境变量 ${APP_PATH_ENV} 指向 Grok Bot.exe 再试，例如在 PowerShell 里：`,
    `  $env:${APP_PATH_ENV} = 'D:\\你的路径\\Grok Bot.exe'`,
    '不知道装在哪的话，先打开 Grok Bot，再在 PowerShell 里运行下面这条，看 Path 那一行：',
    "  Get-Process | Where-Object { $_.Path -match 'Grok' } | Select-Object Id, ProcessName, Path | Format-List",
  ],
  darwin: [
    `如果你知道它装在哪，可以设环境变量 ${APP_PATH_ENV} 指向 Grok Bot.app 再试，例如：`,
    `  export ${APP_PATH_ENV}="/Applications/Grok Bot.app"`,
  ],
};

// The UserError for "no app to relaunch". Grok Bot has not been touched when this is thrown.
// `outcome` says what did not happen; the default is the relaunch path's.
export function appMissingError(platformName, outcome = '没法带调试口打开 Grok Bot。Grok Bot 没有被关闭。') {
  const override = appPathOverride();
  const first = override ? `环境变量 ${APP_PATH_ENV} 指向的「${override}」不存在，${outcome}` : `找不到 Grok Bot 的程序文件，${outcome}`;
  return new UserError([first, ...(FIND_HINT[platformName] ?? [])].join('\n'));
}

export async function loadPlatform(name = process.platform) {
  const load = ADAPTERS[name];
  if (!load) throw new UserError(`暂不支持 ${name}，目前只支持 Windows 和 macOS。`);
  const adapter = await load();
  // GROKBOT_APP_PATH wins over the adapter's own search; a path that does not exist reads as "not found".
  const appPath = async () => {
    const override = appPathOverride();
    if (override) return existsSync(override) ? override : null;
    return adapter.appPath();
  };
  return { name, ...adapter, appPath };
}
