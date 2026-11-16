import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { identifyDebug, listTargets, NotGrokBotError, notGrokBotMessage, usableDebug } from './cdp.mjs';
import { describeUnexpected, EXIT, UserError } from './errors.mjs';
import { applyOnce, restoreOnce, windowReport } from './oneshot.mjs';
import { PANEL_SERVICE, servePanel } from './panel-server.mjs';
import { launchWithWallpaper } from './launch.mjs';
import { alwaysStatus, createAlwaysKeeper, describeFields, turnOff, turnOn } from './always.mjs';
import { appMissingError, loadPlatform } from './platform/index.mjs';
import { HOST, PORTS } from './ports.mjs';
import { relaunchAndWait } from './relaunch.mjs';
import { nodeProblem } from './runtime.mjs';
import { wallpaperDataUrl } from './themes.mjs';
import { CUSTOM_ID, importCustomImageFile, loadApplicableThemes } from './custom.mjs';
import { openStore, parseStrength, resolveDataDir } from './store.mjs';
import { runWatch } from './watch.mjs';

const ENTRY = 'node scripts/grokbot-wallpaper.mjs';
const DAEMON_START_WAIT_MS = 8000;
const DAEMON_STOP_WAIT_MS = 5000;
const APPEARANCE_NAME = { dark: '深色', light: '浅色' };

const USAGE = `用法：${ENTRY} <命令>
  status                                    查看 Grok Bot、调试口、面板、自启和上次主题
  list                                      列出可套用的主题（导入过自己的图片时第一项是 custom）
  apply --image <图片路径> [选项]            用自己的图片当壁纸（jpg、png、webp，小于 4 MB；原图不动）
  apply <主题 id> [选项]                     套用内置主题，或用 custom 换回上次导入的图片
    --relaunch                              你已同意重启 Grok Bot
    --no-daemon                             不装登录自启、不起后台 watch
    --strength <0-100>                      壁纸浓淡：0 面板实心看不见壁纸，100 壁纸最浓；记住，下次照用
  restore                                   去掉当前窗口里的主题，不重启，不卸自启
  watch                                     前台常驻：刷新和新窗口自动套上次的主题，窗口里有悬浮面板
    --with-app                              跟着 Grok Bot 走：它关掉 30 秒后自己退出（图标起的小助手带这个）
  panel                                     只跑本机面板网页（调试用）
  autostart <on|off>                        装上或卸掉登录自启；off 还会停掉正在跑的 watch
  launcher <on|off>                         在桌面放上或删掉「Grok Bot（带壁纸）」图标，双击它就打开带壁纸的 Grok Bot
  launch                                    图标实际运行的命令：带调试口打开 Grok Bot（开着的要先问你），套上壁纸
  always <on|off>                           on：把你原有的 Grok Bot 图标（开始菜单、桌面、任务栏固定）改成带壁纸打开，
                                            改之前先把原样备份；本工具或 node 不在了，图标照样能打开 Grok Bot，只是没有壁纸
                                            off：把这些图标一个个恢复成原样（目前只支持 Windows）
  usage <on|off>                            面板上显示用量（默认开）：小助手隔一阵替你点开左下角的账户菜单，只读「百分之几已用」那一个数；
                                            off 之后不再读、不再点，直到 on`;

const MESSAGES = {
  debugClosed: (themeId) =>
    [
      `Grok Bot 的本机调试口（${HOST}:${PORTS.debug}）没有打开，所以这次没有换壁纸，也没有关闭或重启 Grok Bot。`,
      '第一次使用需要用带调试口的方式重新打开 Grok Bot：当前窗口会关掉再自动打开，正在生成的回答会中断。',
      '如果它不肯正常退出（比如缩在托盘里），工具会强制结束它，没保存的输入可能丢。',
      '如果现在可以重启，请运行：',
      `  ${ENTRY} apply ${themeId} --relaunch`,
    ].join('\n'),
  restoreUnverifiable: [
    `Grok Bot 的本机调试口（${HOST}:${PORTS.debug}）没有打开，没法检查当前窗口里还有没有主题，所以不能说已经恢复。`,
    '本命令不会重启 Grok Bot。完全退出 Grok Bot（包括托盘里的图标）再打开，也会清掉窗口里的主题。',
  ].join('\n'),
  noWindows: '调试口开着，但没有找到 Grok Bot 的窗口。',
  noPanels: (code) =>
    `提醒：壁纸层已经放进窗口，但没有找到任何一块能透出壁纸的面板，你多半看不到壁纸（可能页面还没加载完，或者 Grok Bot 的界面改了）。稍等再运行一次 apply 试试，或者运行 restore 去掉它。退出码 ${code}。`,
  autostartFailed: (reason) => `登录自启没装上：${reason}。壁纸这次已经换上，但重新登录后不会自己回来。`,
  daemonFailed: (reason) => `后台小助手没起来：${reason}。壁纸这次已经换上，但刷新页面或开新窗口后会掉。`,
  panelPortTaken: `面板端口 ${HOST}:${PORTS.panel} 被别的程序占着（它答不出我们的暗号），不是我们的后台小助手`,
  flipped: (tone, seen) =>
    `这张图是${APPEARANCE_NAME[tone]}的，Grok Bot 现在是${APPEARANCE_NAME[seen]}模式。为了让字看得清，已经把它的界面翻成${APPEARANCE_NAME[tone]}来配这张图。运行 restore 或换一张${APPEARANCE_NAME[seen]}的图，界面就会变回去。`,
  unknownTheme: (requested, themes) =>
    `没有叫 "${requested}" 的主题。可用的有：${themes.map((t) => t.id).join('、') || '（没有）'}。想用自己的图片，运行 apply --image <图片路径>。`,
  imageAndTheme: '--image 和主题 id 只能二选一。',
  badStrength: (raw) => `--strength 必须是 0 到 100 的整数，现在是 "${raw}"。0 是面板实心看不见壁纸，100 是壁纸最浓。`,
};

const printJson = (value) => console.log(JSON.stringify(value, null, 2));
const log = (line) => console.error(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);

function parseCommandArgs(args, options, positionalCount) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UserError(`${error.message}\n\n${USAGE}`);
  }
  const counts = [positionalCount].flat();
  if (!counts.includes(parsed.positionals.length)) throw new UserError(USAGE);
  return parsed;
}

function parseStrengthOption(raw) {
  if (raw === undefined) return null;
  const value = /^\d{1,3}$/.test(raw) ? parseStrength(Number(raw)) : null;
  if (value === null) throw new UserError(MESSAGES.badStrength(raw));
  return value;
}

// A loopback connect answers at once or is refused at once. The timeout only matters when this process itself is
// stalled, so it is generous: starting the PowerShell helpers freezes the event loop for most of a second (measured:
// 714 ms on a busy machine), and 800 ms here used to report a live helper as gone about one time in twelve.
const PORT_PROBE_TIMEOUT_MS = 3000;

function portListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port, timeout: PORT_PROBE_TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

// Who holds the panel port: 'ours' (our watch or panel answers the hello), 'other' (something else listens) or 'free'.
async function panelOwner() {
  if (!(await portListening(PORTS.panel))) return 'free';
  try {
    const response = await fetch(`http://${HOST}:${PORTS.panel}/api/hello`, { signal: AbortSignal.timeout(1500) });
    if (response.ok && (await response.json())?.service === PANEL_SERVICE) return 'ours';
  } catch {}
  return 'other';
}

async function waitUntil(check, timeoutMs, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return check();
}

const openPlatformStore = (platform) => openStore(resolveDataDir(platform));

// Best effort after a successful apply: neither step may change apply's exit code.
async function ensureDaemon(platform) {
  let autostart;
  try {
    await platform.installAutostart();
    autostart = { installed: await platform.autostartInstalled(), error: null };
  } catch (error) {
    autostart = { installed: false, error: error.message };
  }
  if (autostart.error === null && !autostart.installed) autostart.error = '写完以后没在启动项里找到它';
  const owner = await panelOwner();
  if (owner === 'ours') return { autostart, daemon: { running: true, started: false, error: null } };
  if (owner === 'other') return { autostart, daemon: { running: false, started: false, error: MESSAGES.panelPortTaken } };
  try {
    await platform.startDaemon();
    const up = await waitUntil(async () => (await panelOwner()) === 'ours', DAEMON_START_WAIT_MS);
    const error = up ? null : `${DAEMON_START_WAIT_MS / 1000} 秒内没看到 watch 在 ${HOST}:${PORTS.panel} 起来`;
    return { autostart, daemon: { running: up, started: up, error } };
  } catch (error) {
    return { autostart, daemon: { running: false, started: false, error: error.message } };
  }
}

async function stopDaemon() {
  const owner = await panelOwner();
  if (owner === 'free') return { running: false, stopped: false, error: null };
  // Never tell a program we did not start to quit.
  if (owner === 'other') return { running: false, stopped: false, error: `${MESSAGES.panelPortTaken}，没有向它发退出请求` };
  try {
    await fetch(`http://${HOST}:${PORTS.panel}/api/quit`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch (error) {
    return { running: true, stopped: false, error: `没能让 watch 停下：${error.message}` };
  }
  const freed = await waitUntil(async () => !(await portListening(PORTS.panel)), DAEMON_STOP_WAIT_MS);
  return { running: !freed, stopped: freed, error: freed ? null : `${HOST}:${PORTS.panel} 还在占用` };
}

async function status(args) {
  parseCommandArgs(args, {}, 0);
  const platform = await loadPlatform();
  const store = openPlatformStore(platform);
  // The two network looks go first and alone: run next to the PowerShell helpers below, their short timeouts expire
  // while this process is busy starting those helpers, and an open port reads as closed.
  const [identity, owner] = await Promise.all([identifyDebug(PORTS.debug), panelOwner()]);
  const [appPath, running, autostart, launcher, lastApplied, always, usage] = await Promise.all([
    platform.appPath(),
    platform.running(),
    platform.autostartInstalled(),
    platform.launcherInstalled(),
    store.readLastApplied(),
    alwaysReport(platform, store),
    store.readUsage(),
  ]);
  if (identity.state === 'other') console.error(notGrokBotMessage(PORTS.debug, identity.reportedAs));
  printJson({
    platform: platform.name,
    appPath,
    running,
    // 'closed', 'grokbot' (Grok Bot answers), 'other' (another program answers; nothing will be injected), or 'standin' (self-test only).
    debug: identity.state,
    debugReportedAs: identity.reportedAs,
    panel: owner === 'ours',
    panelPortTakenByOther: owner === 'other',
    autostart,
    // The desktop icon「Grok Bot（带壁纸）」is there and runs this repo's launch.
    launcher,
    // always on: whether the user's own Grok Bot shortcuts are switched to open with the wallpaper, and how many are changed now.
    alwaysOn: always,
    lastApplied,
    // Show usage: whether it is on, the last figure read and when, the most recent failure, and the most recent try of any kind.
    usage,
    ports: { host: HOST, debug: PORTS.debug, panel: PORTS.panel },
  });
  return EXIT.ok;
}

async function list(args) {
  parseCommandArgs(args, {}, 0);
  const platform = await loadPlatform();
  const { themes, broken } = await loadApplicableThemes(resolveDataDir(platform));
  printJson({
    themes: themes.map(({ id, name, appearance, opacity }) => ({ id, name, appearance, opacity })),
    broken,
  });
  return EXIT.ok;
}

async function apply(args) {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      relaunch: { type: 'boolean', default: false },
      'no-daemon': { type: 'boolean', default: false },
      image: { type: 'string' },
      strength: { type: 'string' },
    },
    [0, 1],
  );
  const image = values.image;
  if (image !== undefined && positionals.length === 1) throw new UserError(MESSAGES.imageAndTheme);
  if (image === undefined && positionals.length === 0) throw new UserError(USAGE);
  if (image === '') throw new UserError(USAGE);
  const strength = parseStrengthOption(values.strength);

  const platform = await loadPlatform();
  const store = openPlatformStore(platform);
  // The picture goes into the slot first; from there on it is just the theme called custom.
  if (image !== undefined) await importCustomImageFile(store.dir, image);
  const requested = image === undefined ? positionals[0] : CUSTOM_ID;
  const { themes } = await loadApplicableThemes(store.dir);
  const theme = themes.find((candidate) => candidate.id === requested);
  if (!theme) throw new UserError(MESSAGES.unknownTheme(requested, themes));

  const identity = await identifyDebug(PORTS.debug);
  if (identity.state === 'other') throw new NotGrokBotError(PORTS.debug, identity.reportedAs);
  if (identity.state === 'closed') {
    if (!values.relaunch) throw new UserError(MESSAGES.debugClosed(theme.id), EXIT.debugClosed);
    await relaunch(platform, theme);
  }

  if (strength !== null) await store.writeStrength(strength);
  const results = await applyOnce(theme, store);
  if (results.length === 0) throw new UserError(MESSAGES.noWindows);
  const injected = results.some((result) => result.ok);
  const background = injected && !values['no-daemon'] ? await ensureDaemon(platform) : {};
  printJson({ theme: theme.id, windows: results.map(windowReport), ...background });
  if (background.autostart?.error) console.error(MESSAGES.autostartFailed(background.autostart.error));
  if (background.daemon?.error) console.error(MESSAGES.daemonFailed(background.daemon.error));
  const flipped = results.find((result) => result.ok && result.value.flipped);
  if (flipped) console.error(MESSAGES.flipped(flipped.value.imageTone, flipped.value.appAppearance));
  if (!results.every((result) => result.ok)) return EXIT.error;
  if (panelsTouched(results) === 0) {
    console.error(MESSAGES.noPanels(EXIT.noPanels));
    return EXIT.noPanels;
  }
  return EXIT.ok;
}

// How many app panels the overlay thinned out, over every window that answered.
export const panelsTouched = (results) =>
  results.reduce((sum, result) => sum + (result.ok && Number.isFinite(result.value?.panels) ? result.value.panels : 0), 0);

// Everything that can be checked is checked before Grok Bot is asked to quit; then the real platform calls are handed over.
function relaunch(platform, theme) {
  return relaunchAndWait({
    checks: [
      async () => {
        const problem = nodeProblem();
        if (problem) throw new UserError(problem);
      },
      async () => {
        await wallpaperDataUrl(theme);
      },
    ],
    app: {
      findApp: () => platform.appPath(),
      appMissing: () => appMissingError(platform.name),
      isRunning: (exe) => platform.isRunning(exe),
      requestQuit: (exe) => platform.requestQuit(exe),
      forceQuit: (exe) => platform.forceQuit(exe),
      launch: (exe, env) => platform.launch(exe, env),
    },
    ready: async () => {
      const identity = await identifyDebug(PORTS.debug);
      const windows = usableDebug(identity) ? (await listTargets(PORTS.debug).catch(() => [])).length : 0;
      return { ...identity, windows };
    },
    notGrokBot: (reportedAs) => new NotGrokBotError(PORTS.debug, reportedAs),
    log,
  });
}

async function restore(args) {
  parseCommandArgs(args, {}, 0);
  const platform = await loadPlatform();
  const identity = await identifyDebug(PORTS.debug);
  if (identity.state === 'closed') throw new UserError(MESSAGES.restoreUnverifiable);
  if (identity.state === 'other') throw new NotGrokBotError(PORTS.debug, identity.reportedAs);
  const { clean, results } = await restoreOnce(openPlatformStore(platform));
  if (results.length === 0) throw new UserError(`${MESSAGES.noWindows}没法确认已经恢复。`);
  printJson({ restored: clean, windows: results.map(windowReport) });
  return clean ? EXIT.ok : EXIT.error;
}

async function watch(args) {
  const { values } = parseCommandArgs(args, { 'with-app': { type: 'boolean', default: false } }, 0);
  const platform = await loadPlatform();
  const store = openPlatformStore(platform);
  // While always on is switched on, a shortcut Grok Bot has rewritten to its original is changed again.
  const keeper = platform.alwaysOnSupported
    ? createAlwaysKeeper({ store, log, dirs: () => platform.shortcutDirs(), read: (paths) => platform.readShortcuts(paths), write: (path, fields) => platform.writeShortcut(path, fields) })
    : null;
  await runWatch({ store, log, withApp: values['with-app'], onTick: keeper ? () => keeper.check() : undefined });
  return EXIT.ok;
}

// Without watch nothing holds a session, so the panel page only does what a CLI apply or restore would do.
function oneShotDispatch(store) {
  const ONE_SHOT = {
    async apply({ themeId }) {
      const { themes } = await loadApplicableThemes(store.dir);
      const theme = themes.find((candidate) => candidate.id === themeId);
      if (!theme) return { ok: false, error: MESSAGES.unknownTheme(themeId, themes) };
      const results = await applyOnce(theme, store);
      return { ok: results.length > 0 && results.every((r) => r.ok), windows: results.map(windowReport) };
    },
    async restore() {
      const { clean, results } = await restoreOnce(store);
      return { ok: clean, windows: results.map(windowReport) };
    },
  };
  return async (message) => {
    const identity = await identifyDebug(PORTS.debug);
    if (identity.state === 'closed') return { ok: false, error: MESSAGES.debugClosed(message.themeId ?? '<主题 id>') };
    if (identity.state === 'other') return { ok: false, error: notGrokBotMessage(PORTS.debug, identity.reportedAs) };
    return ONE_SHOT[message.type]?.(message) ?? { ok: false, error: '面板网页只能换主题或恢复' };
  };
}

async function panel(args) {
  parseCommandArgs(args, {}, 0);
  const platform = await loadPlatform();
  const store = openPlatformStore(platform);
  await servePanel({ store, log, dispatch: oneShotDispatch(store) });
  return EXIT.ok;
}

const AUTOSTART = {
  async on(platform) {
    await platform.installAutostart();
    return { autostart: await platform.autostartInstalled() };
  },
  async off(platform) {
    await platform.uninstallAutostart();
    return { autostart: await platform.autostartInstalled(), daemon: await stopDaemon() };
  },
};

async function autostart(args) {
  const { positionals } = parseCommandArgs(args, {}, 1);
  const [mode] = positionals;
  if (!Object.hasOwn(AUTOSTART, mode)) throw new UserError(USAGE);
  const result = await AUTOSTART[mode](await loadPlatform());
  printJson(result);
  if (result.daemon?.error) console.error(`后台小助手没停：${result.daemon.error}。`);
  return EXIT.ok;
}

const LAUNCHER = {
  async on(platform) {
    const exe = await platform.appPath();
    if (!exe) throw appMissingError(platform.name, '没有建「Grok Bot（带壁纸）」图标。');
    const path = await platform.installLauncher(exe);
    const installed = await platform.launcherInstalled();
    if (!installed) throw new UserError(`图标写进了 ${path}，但读回来时它指向的不是本仓库的 launch，没装好。`);
    console.error(`已在桌面放好「Grok Bot（带壁纸）」：${path}`);
    return { launcher: { installed, path } };
  },
  async off(platform) {
    const path = await platform.uninstallLauncher();
    return { launcher: { installed: await platform.launcherInstalled(), path } };
  },
};

async function launcher(args) {
  const { positionals } = parseCommandArgs(args, {}, 1);
  const [mode] = positionals;
  if (!Object.hasOwn(LAUNCHER, mode)) throw new UserError(USAGE);
  printJson(await LAUNCHER[mode](await loadPlatform()));
  return EXIT.ok;
}

const ALWAYS_UNSUPPORTED = '这个功能目前只支持 Windows：macOS 程序坞里的图标不是快捷方式，没有东西可改。什么都没有动。';

async function alwaysReport(platform, store) {
  if (!platform.alwaysOnSupported) return { supported: false };
  try {
    return { supported: true, ...(await alwaysStatus({ store, dirs: await platform.shortcutDirs(), read: (paths) => platform.readShortcuts(paths) })) };
  } catch (error) {
    return { supported: true, error: error.message };
  }
}

const listLines = (title, items, line = (item) => item) => (items.length ? [`${title}（${items.length} 个）：`, ...items.map((item) => `  ${line(item)}`)] : []);

function tellAlwaysOn(report) {
  const lines = [
    ...listLines('改成了带壁纸打开', report.changed),
    ...listLines('之前就改过，这次没动', report.already),
    ...listLines('没有改', report.skipped, (s) => `${s.path}：${s.reason}`),
    ...listLines('改失败了', report.failed, (f) =>
      f.restored ? `${f.path}：${f.reason}。已经恢复成原样。` : `${f.path}：${f.reason}。没能恢复，备份还在，原样是：
${describeFields(f.original)}`,
    ),
  ];
  if (report.changed.length || report.already.length) lines.push('现在从这些图标打开 Grok Bot 都会带上壁纸。想恢复原样，运行 always off。');
  console.error(lines.join('\n'));
}

function tellAlwaysOff(report, backupFile) {
  if (!report.wasOn) {
    console.error('没有找到图标备份，开关本来就是关的，什么都没有动。');
    return;
  }
  const lines = [
    ...listLines('恢复成了原样', report.restored),
    ...listLines('本来就是原样', report.alreadyOriginal),
    ...listLines('文件已经不在了，跳过', report.missing),
    ...listLines('被别的程序或官方更新改过，没有动它', report.changedByOthers, (c) => `${c.path}
    它原来是：
${describeFields(c.original)}`),
    ...listLines('没能恢复', report.failed, (f) => `${f.path}：${f.reason}
    原样是：
${describeFields(f.original)}`),
  ];
  if (report.failed.length) lines.push(`有图标没恢复，备份文件（${backupFile}）留着没删，可以照上面的原样手工改回去，或者处理好之后再运行 always off。`);
  else if (report.keptInBackup?.length)
    lines.push(`其余的都处理好了。被改过的那几个的原样还留在备份文件里（${backupFile}），没删：照上面的原样手工改回去，或者确认不再需要之后，可以删掉这个文件。`);
  else lines.push('备份文件已删掉。');
  console.error(lines.join('\n'));
}

const ALWAYS = {
  async on(platform, store) {
    const exe = await platform.appPath();
    if (!exe) throw appMissingError(platform.name, '一个图标都没有改。');
    const { code, report } = await turnOn({
      exe,
      store,
      scan: () => platform.scanShortcuts(),
      plan: (original) => platform.alwaysOnShortcut(original),
      write: (path, fields) => platform.writeShortcut(path, fields),
    });
    printJson({ alwaysOn: report });
    tellAlwaysOn(report);
    return code;
  },
  async off(platform, store) {
    const { code, report } = await turnOff({ store, dirs: () => platform.shortcutDirs(), read: (paths) => platform.readShortcuts(paths) });
    printJson({ alwaysOff: report });
    tellAlwaysOff(report, store.alwaysBackupFile);
    return code;
  },
};

async function always(args) {
  const { positionals } = parseCommandArgs(args, {}, 1);
  const [mode] = positionals;
  if (!Object.hasOwn(ALWAYS, mode)) throw new UserError(USAGE);
  const platform = await loadPlatform();
  if (!platform.alwaysOnSupported) throw new UserError(ALWAYS_UNSUPPORTED);
  return ALWAYS[mode](platform, openPlatformStore(platform));
}

// What the desktop icon runs: the real platform calls handed to src/launch.mjs, which decides when each one runs.
async function launch(args) {
  parseCommandArgs(args, {}, 0);
  const platform = await loadPlatform();
  const store = openPlatformStore(platform);
  return launchWithWallpaper({
    checks: [
      async () => {
        const problem = nodeProblem();
        if (problem) throw new UserError(problem);
      },
    ],
    findApp: () => platform.appPath(),
    appMissing: () => appMissingError(platform.name, '没法打开带壁纸的 Grok Bot，什么都没有动。'),
    identify: () => identifyDebug(PORTS.debug),
    isRunning: (exe) => platform.isRunning(exe),
    bringToFront: (exe) => platform.bringToFront(exe),
    relaunch: (theme) => relaunch(platform, theme),
    confirm: (text) => platform.confirm(text),
    notify: (text) => platform.notify(text),
    panelOwner,
    startDaemon: () => platform.startDaemon({ withApp: true }),
    waitDaemon: () => waitUntil(async () => (await panelOwner()) === 'ours', DAEMON_START_WAIT_MS),
    store,
    loadThemes: async () => (await loadApplicableThemes(store.dir)).themes,
    debugPort: `${HOST}:${PORTS.debug}`,
    panelPort: `${HOST}:${PORTS.panel}`,
    now: () => new Date(),
    log,
  });
}

// Only the switch is written here; a running watch picks it up on its next look (every 2 seconds).
async function usageSwitch(args) {
  const { positionals } = parseCommandArgs(args, {}, 1);
  const [mode] = positionals;
  if (mode !== 'on' && mode !== 'off') throw new UserError(USAGE);
  const store = openPlatformStore(await loadPlatform());
  const state = await store.writeUsage({ ...(await store.readUsage()), enabled: mode === 'on' });
  printJson({ usage: state });
  console.error(mode === 'on' ? '已打开显示用量。正在运行的小助手几秒内会去读一次。' : '已关闭显示用量。小助手不会再点账户菜单，面板上的用量会消失。');
  return EXIT.ok;
}

async function help() {
  console.log(USAGE);
  return EXIT.ok;
}

const COMMANDS = {
  status,
  list,
  apply,
  restore,
  watch,
  panel,
  autostart,
  launcher,
  launch,
  always,
  usage: usageSwitch,
  help,
};

export async function main(argv) {
  const [name, ...args] = argv;
  const command = Object.hasOwn(COMMANDS, name ?? '') ? COMMANDS[name] : null;
  if (!command) {
    console.error(USAGE);
    return EXIT.error;
  }
  try {
    return await command(args);
  } catch (error) {
    if (error instanceof UserError) {
      console.error(error.message);
      return error.exit;
    }
    if (error instanceof NotGrokBotError) {
      console.error(error.message);
      return EXIT.notGrokBot;
    }
    console.error(describeUnexpected(error));
    return EXIT.error;
  }
}
