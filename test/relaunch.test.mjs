// The relaunch path is only ever run here against fake platform functions and a fake clock.
// Nothing in this file can find, close or start the real Grok Bot.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UserError } from '../src/errors.mjs';
import { launchEnv, RELAUNCH, relaunchAndWait } from '../src/relaunch.mjs';

const EXE = 'C:\\Fake\\Grok Bot.exe';

// A scripted world: when the app quits, when the port answers, when the window shows up.
function world({
  running = true,
  quitsAfterAsk = 1000,
  quitsAfterKill = 500,
  launchError = null,
  portAfterLaunch = 2000,
  windowAfterLaunch = 2000,
  aliveAfterLaunch = true,
  answersAs = 'grokbot',
} = {}) {
  let t = 0;
  const calls = [];
  const lines = [];
  let askedAt = null;
  let killedAt = null;
  let launchedAt = null;
  let launchedEnv = null;
  const isRunning = async () => {
    calls.push('isRunning');
    if (launchedAt !== null) return aliveAfterLaunch;
    if (!running) return false;
    if (killedAt !== null) return t - killedAt < quitsAfterKill;
    if (askedAt !== null && quitsAfterAsk !== null) return t - askedAt < quitsAfterAsk;
    return true;
  };
  const app = {
    findApp: async () => (calls.push('findApp'), EXE),
    appMissing: () => new UserError('找不到'),
    isRunning,
    requestQuit: async () => {
      calls.push('requestQuit');
      askedAt = t;
    },
    forceQuit: async () => {
      calls.push('forceQuit');
      killedAt = t;
    },
    launch: async (exe, env) => {
      calls.push('launch');
      launchedEnv = env;
      if (launchError) throw launchError;
      launchedAt = t;
    },
  };
  const ready = async () => {
    if (launchedAt === null || !aliveAfterLaunch) return { state: 'closed', reportedAs: null, windows: 0 };
    const since = t - launchedAt;
    if (portAfterLaunch === null || since < portAfterLaunch) return { state: 'closed', reportedAs: null, windows: 0 };
    if (answersAs !== 'grokbot') return { state: answersAs, reportedAs: 'Edg/1', windows: 1 };
    return { state: 'grokbot', reportedAs: 'Chrome/140', windows: windowAfterLaunch !== null && since >= windowAfterLaunch ? 1 : 0 };
  };
  return {
    calls,
    lines,
    launchedEnv: () => launchedEnv,
    run: (extra = {}) =>
      relaunchAndWait({
        app,
        ready,
        notGrokBot: (who) => new UserError(`不是 Grok Bot：${who}`, 4),
        log: (line) => lines.push({ t, line }),
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
        env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', Electron_Run_As_Node: '1', KEEP: 'yes' },
        ...extra,
      }),
  };
}

// The user never waits more than 3 seconds without a new line, counted on the fake clock, until the call returns.
function assertNeverSilent(w, endT) {
  const times = [0, ...w.lines.map((l) => l.t), endT];
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] <= 3000, `silent from ${times[i - 1]} to ${times[i]} ms: ${JSON.stringify(w.lines)}`);
}

const texts = (w) => w.lines.map((l) => l.line);
const endOf = (w) => Math.max(0, ...w.lines.map((l) => l.t));

test('normal quit: asks, sees it go, reopens with a clean environment, waits until the window is there', async () => {
  const w = world();
  await w.run();
  assert.deepEqual(
    w.calls.filter((c) => c !== 'isRunning'),
    ['findApp', 'requestQuit', 'launch'],
  );
  const all = texts(w).join('\n');
  for (const step of ['正在请 Grok Bot 退出', '正在带调试口重新打开 Grok Bot', '正在等 Grok Bot 准备好', 'Grok Bot 准备好了']) assert.match(all, new RegExp(step));
  assert.doesNotMatch(all, /托盘|强制结束它/);
  assert.deepEqual(w.launchedEnv(), { PATH: 'x', KEEP: 'yes' }, 'ELECTRON_RUN_AS_NODE is gone in any letter case');
  assertNeverSilent(w, endOf(w));
});

test('an app that hides in the tray: a tray note after 3 s, then a forced end only at the full limit', async () => {
  const w = world({ quitsAfterAsk: null });
  await w.run();
  assert.deepEqual(
    w.calls.filter((c) => c !== 'isRunning'),
    ['findApp', 'requestQuit', 'forceQuit', 'launch'],
  );
  const tray = w.lines.find((l) => /可能缩到了托盘里。再等一会儿，还不退出就强制结束/.test(l.line));
  const forcing = w.lines.find((l) => /正在强制结束它/.test(l.line));
  assert.ok(tray && tray.t >= 3000 && tray.t < 3000 + RELAUNCH.pollMs * 2, JSON.stringify(tray));
  assert.ok(forcing && forcing.t >= RELAUNCH.quitTimeoutMs, JSON.stringify(forcing));
  assert.ok(w.lines.indexOf(tray) < w.lines.indexOf(forcing));
  assertNeverSilent(w, endOf(w));
});

test('an exe that will not start: says Grok Bot is closed and must be opened by hand, with the reason, as a UserError', async () => {
  const w = world({ launchError: Object.assign(new Error('spawn D:\\grok\\Grok Bot.exe ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(w.run(), (error) => {
    assert.ok(error instanceof UserError);
    assert.match(error.message, /^Grok Bot 已经关闭，但没能重新打开，请手动打开它。原因：spawn .*ENOENT$/);
    assert.doesNotMatch(error.message, /\n\s+at /);
    return true;
  });
});

test('the debug port answers before any window exists: keeps waiting for the window instead of failing', async () => {
  const w = world({ portAfterLaunch: 1000, windowAfterLaunch: 9000 });
  await w.run();
  const all = texts(w).join('\n');
  assert.match(all, /调试口已经应答，在等 Grok Bot 的窗口出现/);
  assert.match(all, /Grok Bot 准备好了/);
  assertNeverSilent(w, endOf(w));
});

test('the debug port never opens while the app runs: says this version may not take the debug flags', async () => {
  const w = world({ portAfterLaunch: null });
  await assert.rejects(w.run(), /Grok Bot 打开了，但 30 秒内调试口一直没开，可能这个版本不支持调试参数/);
  assertNeverSilent(w, endOf(w));
  assert.ok(texts(w).some((line) => /调试口还没有应答/.test(line)));
});

test('the app does not come up at all: open it by hand and retry, still with --relaunch', async () => {
  const w = world({ aliveAfterLaunch: false });
  await assert.rejects(w.run(), (error) => {
    assert.equal(error.message, '应用没有起来，请手动打开后重试，重试时仍需要 --relaunch。');
    return true;
  });
  assertNeverSilent(w, endOf(w));
});

test('port up and app alive but no window within the limit: retry apply without --relaunch, which no longer loops', async () => {
  const w = world({ portAfterLaunch: 500, windowAfterLaunch: null });
  await assert.rejects(w.run(), /调试口也开了，但 30 秒内没有出现窗口.*这次不用加 --relaunch/);
});

test('a program other than Grok Bot takes the port after the reopen: refused like any foreign program', async () => {
  const w = world({ answersAs: 'other' });
  await assert.rejects(w.run(), /不是 Grok Bot：Edg\/1/);
});

test('a failed check (Node too old, bad picture) or a missing app stops everything before Grok Bot is touched', async () => {
  for (const failing of [new UserError('需要 Node.js 22 或更高，你现在是 v20.11.0。'), new UserError('这张图不能用：太大')]) {
    const w = world();
    await assert.rejects(
      w.run({
        checks: [
          async () => {
            throw failing;
          },
        ],
      }),
      (error) => error === failing,
    );
    assert.deepEqual(w.calls, [], 'not even looked for the app');
    assert.deepEqual(w.lines, []);
  }
  const w = world();
  const missing = new UserError('找不到 Grok Bot 的程序文件');
  await assert.rejects(w.run({ app: { findApp: async () => null, appMissing: () => missing } }), (error) => error === missing);
  assert.deepEqual(w.calls, []);
});

test('an app that was not running is just opened, without asking anything to quit', async () => {
  const w = world({ running: false });
  await w.run();
  assert.deepEqual(
    w.calls.filter((c) => c !== 'isRunning'),
    ['findApp', 'launch'],
  );
  const failing = world({ running: false, launchError: new Error('拒绝访问') });
  await assert.rejects(failing.run(), /没能打开 Grok Bot，请手动打开它。原因：拒绝访问$/);
});

test('launchEnv only drops ELECTRON_RUN_AS_NODE', () => {
  assert.deepEqual(launchEnv({ A: '1', ELECTRON_RUN_AS_NODE: '1' }), { A: '1' });
});
