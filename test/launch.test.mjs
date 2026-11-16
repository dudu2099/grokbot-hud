// The "with wallpaper" icon's launch path, only ever run here against fake platform functions, a fake confirm box,
// fake notifications and a fake store. Nothing in this file can find, close or start the real Grok Bot, or show a dialog.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotGrokBotError } from '../src/cdp.mjs';
import { EXIT, UserError } from '../src/errors.mjs';
import { LAUNCH_MESSAGES, launchWithWallpaper, pickTheme } from '../src/launch.mjs';

const EXE = 'C:\\Fake\\Grok Bot.exe';
const THEMES = [{ id: 'night-harbor' }, { id: 'paper-light' }];
const NOW = new Date('2026-11-15T08:00:00.000Z');

// A scripted world. Every effect is recorded in `calls`; the store is in memory.
function world({
  exe = EXE,
  debug = 'closed',
  reportedAs = null,
  running = false,
  answer = false,
  relaunchError = null,
  panel = 'free',
  panelAfterStart = 'ours',
  startError = null,
  lastApplied = null,
  themes = THEMES,
} = {}) {
  const calls = [];
  const notes = [];
  const confirms = [];
  const writes = [];
  let record = lastApplied;
  let panelNow = panel;
  const deps = {
    checks: [],
    findApp: async () => (calls.push('findApp'), exe),
    appMissing: () => new UserError('找不到 Grok Bot 的程序文件，没法打开带壁纸的 Grok Bot，什么都没有动。'),
    identify: async () => (calls.push('identify'), { state: debug, reportedAs }),
    isRunning: async () => (calls.push('isRunning'), running),
    bringToFront: async () => calls.push('bringToFront'),
    relaunch: async (theme) => {
      calls.push(`relaunch:${theme.id}`);
      if (relaunchError) throw relaunchError;
    },
    confirm: async (text) => {
      calls.push('confirm');
      confirms.push(text);
      return answer;
    },
    notify: async (text) => notes.push(text),
    panelOwner: async () => (calls.push(`panelOwner:${panelNow}`), panelNow),
    startDaemon: async () => {
      calls.push('startDaemon');
      if (startError) throw startError;
      panelNow = panelAfterStart;
    },
    waitDaemon: async () => panelNow === 'ours',
    store: {
      readLastApplied: async () => record,
      writeLastApplied: async (next) => {
        writes.push(next);
        record = next;
      },
    },
    loadThemes: async () => themes,
    debugPort: '127.0.0.1:19222',
    panelPort: '127.0.0.1:19223',
    now: () => NOW,
    log: () => {},
  };
  return { calls, notes, confirms, writes, run: (extra = {}) => launchWithWallpaper({ ...deps, ...extra }) };
}

const ACTIONS = /^(relaunch|bringToFront|startDaemon|confirm)/;
const actions = (w) => w.calls.filter((c) => ACTIONS.test(c));

test('app not found: one notification, nothing started, quit or written', async () => {
  const w = world({ exe: null });
  assert.equal(await w.run(), EXIT.error);
  assert.deepEqual(actions(w), []);
  assert.deepEqual(w.writes, []);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /找不到 Grok Bot 的程序文件/);
});

test('a failed Node check is said in a dialog before the app is even looked for', async () => {
  const w = world();
  const code = await w.run({ checks: [async () => { throw new UserError('需要 Node.js 22 或更高，你现在是 v20.11.0。'); }] });
  assert.equal(code, EXIT.error);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.notes, ['需要 Node.js 22 或更高，你现在是 v20.11.0。']);
});

test('Grok Bot already answers on the debug port: no quit, no relaunch, window raised, helper ensured, wallpaper written', async () => {
  const w = world({ debug: 'grokbot', reportedAs: 'Chrome/140' });
  assert.equal(await w.run(), EXIT.ok);
  assert.deepEqual(actions(w), ['bringToFront', 'startDaemon']);
  assert.ok(!w.calls.includes('isRunning'), 'no need to ask whether it runs');
  assert.deepEqual(w.writes, [{ themeId: 'night-harbor', appliedAt: NOW.toISOString(), restored: false }]);
  assert.deepEqual(w.notes, []);
});

test('Grok Bot answers and our helper already runs: the helper is left alone', async () => {
  const w = world({ debug: 'grokbot', panel: 'ours' });
  assert.equal(await w.run(), EXIT.ok);
  assert.deepEqual(actions(w), ['bringToFront']);
  assert.equal(w.writes.length, 1);
});

test('a program other than Grok Bot on the debug port: told who it is, nothing touched', async () => {
  const w = world({ debug: 'other', reportedAs: 'Edg/142.0' });
  assert.equal(await w.run(), EXIT.notGrokBot);
  assert.deepEqual(actions(w), []);
  assert.ok(!w.calls.some((c) => c.startsWith('panelOwner')));
  assert.deepEqual(w.writes, []);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /调试口.*被别的程序占着.*Edg\/142\.0/);
});

test('app not running: started with the debug port right away, no confirm box', async () => {
  const w = world({ running: false });
  assert.equal(await w.run(), EXIT.ok);
  assert.deepEqual(actions(w), ['relaunch:night-harbor', 'startDaemon']);
  assert.deepEqual(w.confirms, []);
  assert.equal(w.writes.length, 1);
});

test('app running without the debug port, user says yes: confirm first, then the full relaunch', async () => {
  const w = world({ running: true, answer: true });
  assert.equal(await w.run(), EXIT.ok);
  assert.deepEqual(actions(w), ['confirm', 'relaunch:night-harbor', 'startDaemon']);
  assert.deepEqual(w.confirms, [LAUNCH_MESSAGES.confirmRelaunch]);
  assert.match(w.confirms[0], /Grok Bot 已经开着，但不是带壁纸的/);
  assert.match(w.confirms[0], /正在生成的回答会中断，没发出去的输入可能会丢/);
  assert.equal(w.writes.length, 1);
});

for (const [label, answer] of [
  ['says no', false],
  ['lets the box time out (the platform returns false)', false],
  ['closes the box (anything but true)', undefined],
]) {
  test(`app running without the debug port, user ${label}: nothing quit or started, no state written, exit ok`, async () => {
    const w = world({ running: true, answer });
    assert.equal(await w.run(), EXIT.ok);
    assert.deepEqual(actions(w), ['confirm']);
    assert.deepEqual(w.writes, []);
    assert.deepEqual(w.notes, []);
  });
}

test('relaunch fails: the reason goes into a dialog as one sentence, no stack, nothing else happens', async () => {
  const reason = '没能打开 Grok Bot，请手动打开它。原因：spawn D:\\grok\\Grok Bot.exe ENOENT';
  const w = world({ running: false, relaunchError: new UserError(reason) });
  assert.equal(await w.run(), EXIT.error);
  assert.equal(w.notes.length, 1);
  assert.ok(w.notes[0].startsWith(reason), 'the dialog opens with the reason');
  assert.match(w.notes[0], /再双击一次「Grok Bot（带壁纸）」/, 'and says what to do from the icon, not from a terminal');
  assert.doesNotMatch(w.notes[0], /\n\s+at /);
  assert.deepEqual(actions(w), ['relaunch:night-harbor']);
  assert.deepEqual(w.writes, []);

  const foreign = world({ running: false, relaunchError: new NotGrokBotError(19222, 'Edg/1') });
  assert.equal(await foreign.run(), EXIT.notGrokBot);
  assert.match(foreign.notes[0], /不是 Grok Bot.*Edg\/1/);

  const odd = world({ running: false, relaunchError: new TypeError('boom') });
  assert.equal(await odd.run(), EXIT.error);
  assert.equal(odd.notes.length, 1);
  assert.match(odd.notes[0], /出了意料之外的问题：boom/);
  assert.doesNotMatch(odd.notes[0], /\n\s+at /);
});

test('panel port held by another program: told so before Grok Bot is touched, no request sent to it', async () => {
  for (const setup of [{ running: true, answer: true }, { debug: 'grokbot' }, { running: false }]) {
    const w = world({ ...setup, panel: 'other' });
    assert.equal(await w.run(), EXIT.error);
    assert.deepEqual(actions(w), [], JSON.stringify(setup));
    assert.deepEqual(w.writes, []);
    assert.equal(w.notes.length, 1);
    assert.match(w.notes[0], /后台小助手要用的端口（127\.0\.0\.1:19223）被别的程序占着/);
  }
});

test('panel port taken while Grok Bot was being reopened: told so, the helper is not started', async () => {
  const w = world({ running: false });
  let looks = 0;
  const code = await w.run({ panelOwner: async () => (++looks === 1 ? 'free' : 'other') });
  assert.equal(code, EXIT.error);
  assert.deepEqual(actions(w), ['relaunch:night-harbor']);
  assert.match(w.notes[0], /被别的程序占着/);
});

test('the helper does not come up: said in a dialog', async () => {
  const w = world({ debug: 'grokbot', panelAfterStart: 'free' });
  assert.equal(await w.run(), EXIT.error);
  assert.match(w.notes[0], /后台小助手没起来/);
  const broken = world({ debug: 'grokbot', startError: new Error('拒绝访问') });
  assert.equal(await broken.run(), EXIT.error);
  assert.match(broken.notes[0], /后台小助手没起来：拒绝访问/);
});

test('no theme at all: said in a dialog before anything is touched', async () => {
  const w = world({ running: true, answer: true, themes: [] });
  assert.equal(await w.run(), EXIT.error);
  assert.deepEqual(actions(w), []);
  assert.match(w.notes[0], /没有找到任何可用的壁纸/);
});

test('the wallpaper picked is the one handed to the relaunch checks and written for the helper', async () => {
  const last = { themeId: 'paper-light', appliedAt: '2026-11-14T00:00:00.000Z', restored: true };
  const w = world({ running: false, lastApplied: last });
  assert.equal(await w.run(), EXIT.ok);
  assert.deepEqual(actions(w), ['relaunch:paper-light', 'startDaemon']);
  assert.deepEqual(w.writes, [{ themeId: 'paper-light', appliedAt: NOW.toISOString(), restored: false }]);
});

test('the same theme already on and not restored is not rewritten, so open windows are not redrawn', async () => {
  const last = { themeId: 'paper-light', appliedAt: '2026-11-14T00:00:00.000Z', restored: false };
  const w = world({ debug: 'grokbot', panel: 'ours', lastApplied: last });
  assert.equal(await w.run(), EXIT.ok);
  assert.deepEqual(w.writes, []);
});

test('pickTheme: the four ways a wallpaper is chosen', () => {
  const custom = { id: 'custom' };
  const withCustom = [custom, ...THEMES];
  assert.equal(pickTheme({ themeId: 'paper-light', restored: false }, withCustom).id, 'paper-light', 'a record wins');
  assert.equal(pickTheme({ themeId: 'paper-light', restored: true }, THEMES).id, 'paper-light', 'even a restored record is put back on');
  assert.equal(pickTheme(null, withCustom).id, 'custom', 'no record: the user picture first');
  assert.equal(pickTheme(null, THEMES).id, 'night-harbor', 'no record, no picture: the first shipped theme');
  assert.equal(pickTheme({ themeId: 'deleted-pack', restored: false }, withCustom).id, 'custom', 'a deleted theme counts as no record');
  assert.equal(pickTheme({ themeId: 'deleted-pack', restored: false }, THEMES).id, 'night-harbor');
  assert.equal(pickTheme(null, []), null);
});

test('a notification that cannot be shown does not turn into a crash', async () => {
  const w = world({ exe: null });
  const code = await w.run({ notify: async () => { throw new Error('no desktop'); } });
  assert.equal(code, EXIT.error);
});
