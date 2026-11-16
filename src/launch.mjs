import { NotGrokBotError } from './cdp.mjs';
import { describeUnexpected, EXIT, UserError } from './errors.mjs';

// What the "Grok Bot（带壁纸）" icon runs. It has no console anyone can read, so whatever the user must know is
// said in a system dialog (notify) and also logged to stderr for debugging.

export const LAUNCH_MESSAGES = {
  frontFailed: (reason) => `没能把 Grok Bot 的窗口叫到前面：${reason}`,
  notGrokBot: (port, reportedAs) =>
    `本机调试口（${port}）被别的程序占着（它自报「${reportedAs}」），不是 Grok Bot，所以没有打开 Grok Bot，也没有换壁纸。请关掉那个程序再点一次图标。`,
  confirmRelaunch:
    'Grok Bot 已经开着，但不是带壁纸的。\n\n要关掉它再重新打开吗？正在生成的回答会中断，没发出去的输入可能会丢。',
  declined: '你选了不重启，Grok Bot 保持原样，这次没有换壁纸。',
  panelTaken: (port) =>
    `后台小助手要用的端口（${port}）被别的程序占着，没法给 Grok Bot 套壁纸。Grok Bot 本身没受影响。请关掉占用这个端口的程序再点一次图标。`,
  daemonFailed: (reason) => `后台小助手没起来：${reason}。Grok Bot 开着，但这次没有换上壁纸。`,
  fromIcon: '你是从图标启动的，不用敲任何命令：按上面说的处理好之后，再双击一次「Grok Bot（带壁纸）」就行。',
  noThemes: '没有找到任何可用的壁纸（内置主题和自己的图片都没有），所以什么都没有动。',
  done: (themeId) => `好了：Grok Bot 带着调试口开着，后台小助手会把「${themeId}」套到它的窗口上。`,
};

// Which wallpaper the icon puts on. The last record wins even if it was restored, since the user clicked the
// "with wallpaper" icon; a record whose theme is gone counts as no record. Otherwise the first applicable theme,
// which is the user's own picture when there is one (loadApplicableThemes lists it first).
export function pickTheme(lastApplied, themes) {
  const remembered = lastApplied ? themes.find((theme) => theme.id === lastApplied.themeId) : undefined;
  return remembered ?? themes[0] ?? null;
}

// The whole launch, with every effect injected (same idea as relaunchAndWait):
//   checks:      async () => void, each throws a UserError (Node version)
//   findApp:     async () => path | null;   appMissing: () => UserError
//   identify:    async () => { state: 'closed' | 'grokbot' | 'standin' | 'other', reportedAs }
//   isRunning:   async (exe) => boolean
//   bringToFront:async (exe) => void       start the exe again; Electron's single-instance lock raises the open window
//   relaunch:    async (theme) => void      relaunchAndWait with the real platform; throws a UserError that says why
//   confirm:     async (text) => boolean    true only for an explicit yes; a timeout or a closed dialog is false
//   notify:      async (text) => void
//   panelOwner:  async () => 'ours' | 'other' | 'free'
//   startDaemon: async () => void          starts watch --with-app; waitDaemon: async () => boolean (it answers as ours)
//   store:       { readLastApplied, writeLastApplied };  loadThemes: async () => themes
//   debugPort, panelPort: numbers for the messages;  now: () => Date;  log: one line to stderr
// Resolves to an exit code. Nothing here installs a login item.
export async function launchWithWallpaper(deps) {
  const { log } = deps;
  const tell = async (text) => {
    log(text);
    try {
      await deps.notify(text);
    } catch (error) {
      log(`对话框没弹出来：${error.message}`);
    }
  };
  const fail = async (text, exit = EXIT.error) => {
    await tell(text);
    return exit;
  };

  try {
    for (const check of deps.checks ?? []) await check();
    const exe = await deps.findApp();
    const identity = await deps.identify();
    // The stand-in (a test-only state on a test port) is not Grok Bot, so there is no exe to look for or raise.
    const standin = identity.state === 'standin';
    if (!exe && !standin) return fail(deps.appMissing().message);
    if (identity.state === 'other') return fail(LAUNCH_MESSAGES.notGrokBot(deps.debugPort, identity.reportedAs), EXIT.notGrokBot);

    const themes = await deps.loadThemes();
    const lastApplied = await deps.store.readLastApplied();
    const theme = pickTheme(lastApplied, themes);
    if (!theme) return fail(LAUNCH_MESSAGES.noThemes);

    // A port someone else holds makes the whole run pointless, so it is found out before Grok Bot is closed.
    if ((await deps.panelOwner()) === 'other') return fail(LAUNCH_MESSAGES.panelTaken(deps.panelPort));

    if (identity.state === 'grokbot') {
      log('带调试口的 Grok Bot 已经开着，不重启，把它的窗口叫到前面。');
      await deps.bringToFront(exe).catch((error) => log(LAUNCH_MESSAGES.frontFailed(error.message)));
    } else if (identity.state === 'closed') {
      if (await deps.isRunning(exe)) {
        // Without this line a log reads as if the app was closed with no question asked: the dialog leaves no trace of its own.
        log('Grok Bot 开着但没带调试口，正在弹出确认框，等你选择…');
        const yes = (await deps.confirm(LAUNCH_MESSAGES.confirmRelaunch)) === true;
        log(yes ? '你点了「是」。' : '没有得到「是」（点了否、关掉了对话框，或者 60 秒没选）。');
        if (!yes) {
          log(LAUNCH_MESSAGES.declined);
          return EXIT.ok;
        }
      }
      try {
        await deps.relaunch(theme);
      } catch (error) {
        // The relaunch messages are written for someone at a terminal ("run apply again"); the icon has none.
        if (error instanceof UserError) return fail(`${error.message}\n\n${LAUNCH_MESSAGES.fromIcon}`, error.exit);
        if (error instanceof NotGrokBotError) return fail(error.message, EXIT.notGrokBot);
        throw error;
      }
    }

    const owner = await deps.panelOwner();
    if (owner === 'other') return fail(LAUNCH_MESSAGES.panelTaken(deps.panelPort));
    if (owner === 'free') {
      try {
        await deps.startDaemon();
      } catch (error) {
        return fail(LAUNCH_MESSAGES.daemonFailed(error.message));
      }
      if (!(await deps.waitDaemon())) return fail(LAUNCH_MESSAGES.daemonFailed('等了几秒也没见它应答'));
    }
    // A running watch (with or without --with-app) is left alone; it picks the record up on its next look.

    const unchanged = lastApplied && lastApplied.themeId === theme.id && !lastApplied.restored;
    if (!unchanged) await deps.store.writeLastApplied({ themeId: theme.id, appliedAt: deps.now().toISOString(), restored: false });
    log(LAUNCH_MESSAGES.done(theme.id));
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UserError) return fail(error.message, error.exit);
    // No stack in the dialog; GROKBOT_DEBUG=1 still prints it to stderr.
    return fail(describeUnexpected(error, false));
  }
}
