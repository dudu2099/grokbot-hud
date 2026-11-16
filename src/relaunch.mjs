import { setTimeout as realSleep } from 'node:timers/promises';
import { UserError } from './errors.mjs';

// How the "close Grok Bot, reopen it with the debug port, wait until it can take a wallpaper" path is paced.
export const RELAUNCH = Object.freeze({
  // After this long the app is probably sitting in the tray instead of quitting; the user is told so.
  trayHintMs: 3000,
  // The polite quit gets this long in total before the app is ended by force.
  quitTimeoutMs: 15000,
  // A dying instance still holds Electron's single-instance lock, and a new one started too early exits without the debug flags.
  killSettleMs: 5000,
  // From launch until the debug port answers as Grok Bot and at least one window shows up.
  readyTimeoutMs: 30000,
  pollMs: 300,
  // No wait stays silent for longer than this (plus one poll), so the user never sees more than 3 seconds of nothing.
  heartbeatMs: 2000,
});

const REMOVED_ENV = ['ELECTRON_RUN_AS_NODE'];

// The environment Grok Bot is started with. A terminal that carries ELECTRON_RUN_AS_NODE would make it run as plain Node and exit.
export function launchEnv(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (REMOVED_ENV.includes(key.toUpperCase())) delete env[key];
  return env;
}

const reasonOf = (error) => (error && typeof error === 'object' && 'message' in error ? error.message : String(error));

export const RELAUNCH_MESSAGES = {
  asking: '正在请 Grok Bot 退出…',
  trayHint: 'Grok Bot 过了 3 秒还在，它可能缩到了托盘里。再等一会儿，还不退出就强制结束。',
  stillWaiting: (left) => `Grok Bot 还没退出，再等几秒（最多再等 ${left} 秒就强制结束）…`,
  forcing: 'Grok Bot 一直没有退出，正在强制结束它…',
  closed: 'Grok Bot 已经退出。',
  opening: '正在带调试口重新打开 Grok Bot…',
  waiting: (seconds) => `正在等 Grok Bot 准备好（调试口应答、窗口出现，最多 ${seconds} 秒）…`,
  waitingPort: '还在等：调试口还没有应答…',
  waitingWindow: '调试口已经应答，在等 Grok Bot 的窗口出现…',
  ready: 'Grok Bot 准备好了，开始换壁纸。',
  stuck: '强制结束之后 Grok Bot 还在运行，所以没有重新打开它。请手动完全退出 Grok Bot（包括托盘里的图标）后再试。',
  launchFailed: (wasRunning, reason) =>
    wasRunning
      ? `Grok Bot 已经关闭，但没能重新打开，请手动打开它。原因：${reason}`
      : `没能打开 Grok Bot，请手动打开它。原因：${reason}`,
  noDebugPort: (seconds) =>
    `Grok Bot 打开了，但 ${seconds} 秒内调试口一直没开，可能这个版本不支持调试参数。这次没有换壁纸。`,
  noWindow: (seconds) =>
    `Grok Bot 打开了，调试口也开了，但 ${seconds} 秒内没有出现窗口。等它的窗口出来后再运行一次 apply，这次不用加 --relaunch。`,
  notUp: '应用没有起来，请手动打开后重试，重试时仍需要 --relaunch。',
};

// The whole relaunch, with every effect injected so it can be run against fake functions:
//   checks:   async () => void, each throws a UserError when something is not ready (run before anything is closed)
//   app:      { findApp() -> path | null, appMissing() -> UserError, isRunning(path), requestQuit(path), forceQuit(path), launch(path, env) }
//   ready:    async () => { state: 'closed' | 'grokbot' | 'standin' | 'other', reportedAs, windows: number }
//   log:      one line of progress, in Chinese, to stderr
// Resolves once Grok Bot answers on the debug port and has a window; otherwise throws a UserError that says what to do.
export async function relaunchAndWait({ checks = [], app, ready, notGrokBot, log, sleep = realSleep, now = Date.now, timing = RELAUNCH, env = process.env }) {
  for (const check of checks) await check();
  const exe = await app.findApp();
  if (!exe) throw app.appMissing();

  // Waits until done() is true. After every poll beat(elapsed, due) may return a line to print; `due` says the heartbeat
  // is up and something must be said. Returns whether done() came true.
  async function waitFor(done, timeoutMs, beat) {
    const started = now();
    let lastLine = started;
    while (now() - started < timeoutMs) {
      if (await done()) return true;
      await sleep(timing.pollMs);
      const line = beat(now() - started, now() - lastLine >= timing.heartbeatMs);
      if (line) {
        log(line);
        lastLine = now();
      }
    }
    return done();
  }

  const wasRunning = await app.isRunning(exe);
  if (wasRunning) {
    log(RELAUNCH_MESSAGES.asking);
    await app.requestQuit(exe);
    let hinted = false;
    const quit = await waitFor(
      async () => !(await app.isRunning(exe)),
      timing.quitTimeoutMs,
      (elapsed, due) => {
        if (!hinted && elapsed >= timing.trayHintMs) {
          hinted = true;
          return RELAUNCH_MESSAGES.trayHint;
        }
        return due ? RELAUNCH_MESSAGES.stillWaiting(Math.max(1, Math.ceil((timing.quitTimeoutMs - elapsed) / 1000))) : null;
      },
    );
    if (!quit) {
      log(RELAUNCH_MESSAGES.forcing);
      await app.forceQuit(exe);
      const gone = await waitFor(async () => !(await app.isRunning(exe)), timing.killSettleMs, (_, due) => (due ? RELAUNCH_MESSAGES.forcing : null));
      if (!gone) throw new UserError(RELAUNCH_MESSAGES.stuck);
    }
    log(RELAUNCH_MESSAGES.closed);
  }

  log(RELAUNCH_MESSAGES.opening);
  try {
    await app.launch(exe, launchEnv(env));
  } catch (error) {
    throw new UserError(RELAUNCH_MESSAGES.launchFailed(wasRunning, reasonOf(error)));
  }

  const seconds = Math.round(timing.readyTimeoutMs / 1000);
  log(RELAUNCH_MESSAGES.waiting(seconds));
  let last = { state: 'closed', reportedAs: null, windows: 0 };
  const up = await waitFor(
    async () => {
      last = await ready();
      return (last.state === 'grokbot' || last.state === 'standin') && last.windows > 0;
    },
    timing.readyTimeoutMs,
    (_, due) => (due ? (last.state === 'closed' ? RELAUNCH_MESSAGES.waitingPort : RELAUNCH_MESSAGES.waitingWindow) : null),
  );
  if (up) {
    log(RELAUNCH_MESSAGES.ready);
    return { exe, wasRunning };
  }
  if (last.state === 'other') throw notGrokBot(last.reportedAs);
  if (!(await app.isRunning(exe))) throw new UserError(RELAUNCH_MESSAGES.notUp);
  throw new UserError(last.state === 'closed' ? RELAUNCH_MESSAGES.noDebugPort(seconds) : RELAUNCH_MESSAGES.noWindow(seconds));
}
