import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MARK } from '../src/overlay.mjs';
import { parsePanelPayload } from '../src/panel.mjs';
import { DEFAULT_USAGE, openStore } from '../src/store.mjs';
import {
  createUsageKeeper,
  idleDecision,
  parseUsageText,
  readUsage,
  USAGE,
  USAGE_REASONS,
  usageDelay,
  usageLimits,
  usagePageExpression,
  usageTiming,
  usageView,
} from '../src/usage.mjs';
import { runCli, tempDir } from './helpers.mjs';

test('the usage figure is read only from a leaf whose whole text is "N% 已用" or "N% used"', () => {
  const good = [
    ['97% 已用', 97],
    ['97%已用', 97],
    ['  97 %  已用 ', 97],
    ['0% used', 0],
    ['100% USED', 100],
    ['5%Used', 5],
    ['100 % 已用', 100],
  ];
  for (const [text, value] of good) assert.equal(parseUsageText(text), value, text);
  const bad = [
    '101% 已用',
    '1000% 已用',
    '-1% 已用',
    '97.5% 已用',
    '97% 已用 本周',
    '约 97% 已用',
    'Premium 97% 已用',
    'Premium97% 已用',
    '你已用完每周用量限额的 90%',
    '97%',
    '97 已用',
    '% 已用',
    '97% 已经用了',
    '97% usedup',
    '本周 97% 已用，下周一重置',
    '',
    null,
    97,
  ];
  for (const text of bad) assert.equal(parseUsageText(text), null, String(text));
});

// A pretend page and debug protocol for one read. It tracks the temporary sheet, whose menu is open, and every Escape.
function world({ typing = false, hidden = false, covered = false, coveredAtClick = covered, idleMs = 1e9, userMenu = null, button = true, prepareButton = button, opensWith = 97, escapesNeeded = 1, failAt = null } = {}) {
  const w = { sheet: false, menu: userMenu ? 'user' : null, percent: userMenu?.percent ?? null, clicks: 0, escapes: 0, userClosed: false, calls: [] };
  const step = (name) => {
    w.calls.push(name);
    if (failAt === name) throw new Error('调试连接已断开');
  };
  w.page = {
    peek: async () => (step('peek'), { typing, hidden, covered, idleMs, menuOpen: w.menu !== null, percent: w.menu ? w.percent : null, button }),
    prepare: async () => (step('prepare'), (w.sheet = true), prepareButton ? { x: 63, y: 1358, covered: coveredAtClick } : null),
    waitPercent: async () => (step('wait'), w.menu === 'ours' ? w.percent : null),
    waitGone: async () => (step('gone'), w.menu === null),
    finish: async () => {
      w.calls.push('finish');
      w.sheet = false;
      if (failAt === 'finish') throw new Error('调试连接已断开');
    },
  };
  w.input = {
    click: async () => {
      step('click');
      w.clicks++;
      w.menu = 'ours';
      w.percent = opensWith;
    },
    escape: async () => {
      step('escape');
      w.escapes++;
      if (w.menu === 'user') w.userClosed = true;
      if (w.escapes >= escapesNeeded) w.menu = null;
    },
  };
  w.read = (options = {}) => readUsage({ enabled: async () => options.enabled ?? true, page: w.page, input: w.input, requireIdleMs: options.requireIdleMs ?? 0 });
  return w;
}

const settled = (w, { escapes, clicks }) => {
  assert.equal(w.sheet, false, 'the temporary sheet is gone at the end');
  assert.equal(w.escapes, escapes, 'Escape pressed exactly as often as needed');
  assert.equal(w.clicks, clicks, 'clicks');
  assert.equal(w.userClosed, false, "the user's own menu was not closed");
};

test('read: the happy path clicks once, reads, presses Escape once and cleans up', async () => {
  const w = world();
  assert.deepEqual(await w.read(), { outcome: 'ok', percent: 97, source: 'opened' });
  settled(w, { escapes: 1, clicks: 1 });
  assert.deepEqual(w.calls, ['peek', 'prepare', 'click', 'wait', 'escape', 'gone', 'finish']);
});

test('read: switched off touches nothing in the page', async () => {
  const w = world();
  assert.deepEqual(await w.read({ enabled: false }), { outcome: 'skipped', reason: USAGE_REASONS.off });
  settled(w, { escapes: 0, clicks: 0 });
  assert.deepEqual(w.calls, []);
});

test('read: while the user is typing nothing is clicked', async () => {
  const w = world({ typing: true });
  assert.deepEqual(await w.read(), { outcome: 'skipped', reason: USAGE_REASONS.typing });
  settled(w, { escapes: 0, clicks: 0 });
  assert.deepEqual(w.calls, ['peek']);
});

test('read: a window that is covered or minimized is left alone', async () => {
  const w = world({ hidden: true });
  assert.deepEqual(await w.read(), { outcome: 'skipped', reason: USAGE_REASONS.hidden });
  settled(w, { escapes: 0, clicks: 0 });
  assert.deepEqual(w.calls, ['peek']);
});

test('read: an account button with something on top of it is never clicked', async () => {
  const w = world({ covered: true });
  assert.deepEqual(await w.read(), { outcome: 'skipped', reason: USAGE_REASONS.covered });
  settled(w, { escapes: 0, clicks: 0 });
  assert.deepEqual(w.calls, ['peek']);
  // Covered only by the time of the click (a dialog opened in between): still no click, and the sheet is taken away.
  const late = world({ coveredAtClick: true });
  assert.deepEqual(await late.read(), { outcome: 'skipped', reason: USAGE_REASONS.covered });
  settled(late, { escapes: 0, clicks: 0 });
  assert.deepEqual(late.calls, ['peek', 'prepare', 'finish']);
});

test('read: a recent key or pointer move counts as busy when idleness is required', async () => {
  const w = world({ idleMs: 5000 });
  assert.deepEqual(await w.read({ requireIdleMs: 20000 }), { outcome: 'skipped', reason: USAGE_REASONS.busy });
  settled(w, { escapes: 0, clicks: 0 });
});

test("read: a menu the user opened with the figure in it: taken, not clicked, not closed", async () => {
  const w = world({ userMenu: { percent: 64 } });
  assert.deepEqual(await w.read(), { outcome: 'ok', percent: 64, source: 'user-menu' });
  settled(w, { escapes: 0, clicks: 0 });
  assert.equal(w.menu, 'user', 'still open');
});

test("read: a menu the user opened without the figure: left alone, nothing read", async () => {
  const w = world({ userMenu: { percent: null } });
  assert.deepEqual(await w.read(), { outcome: 'skipped', reason: USAGE_REASONS.menuOpen });
  settled(w, { escapes: 0, clicks: 0 });
  assert.equal(w.menu, 'user');
});

test('read: no account button means no click and a reason', async () => {
  const w = world({ button: false });
  assert.deepEqual(await w.read(), { outcome: 'failed', reason: USAGE_REASONS.noButton });
  settled(w, { escapes: 0, clicks: 0 });
  const gone = world({ prepareButton: false });
  assert.deepEqual(await gone.read(), { outcome: 'failed', reason: USAGE_REASONS.noButton });
  settled(gone, { escapes: 0, clicks: 0 });
  assert.ok(gone.calls.includes('finish'), 'the sheet prepare put on is taken off again');
});

test('read: the menu opens without the figure within the wait: closed with one Escape, a failure', async () => {
  const w = world({ opensWith: null });
  assert.deepEqual(await w.read(), { outcome: 'failed', reason: USAGE_REASONS.noNumber });
  settled(w, { escapes: 1, clicks: 1 });
  assert.equal(w.menu, null);
});

test('read: one Escape not enough: a second one, and the figure still counts', async () => {
  const w = world({ escapesNeeded: 2 });
  assert.deepEqual(await w.read(), { outcome: 'ok', percent: 97, source: 'opened' });
  settled(w, { escapes: 2, clicks: 1 });
});

test('read: two Escapes not enough: give up, a failure, no third Escape', async () => {
  const w = world({ escapesNeeded: 3 });
  assert.deepEqual(await w.read(), { outcome: 'failed', reason: USAGE_REASONS.stuck });
  settled(w, { escapes: 2, clicks: 1 });
});

test('read: the debug connection failing at any step never throws and always reaches the clean-up', async () => {
  const cases = [
    { failAt: 'peek', escapes: 0, clicks: 0, finish: false },
    { failAt: 'prepare', escapes: 0, clicks: 0, finish: true },
    { failAt: 'click', escapes: 0, clicks: 0, finish: true },
    { failAt: 'wait', escapes: 1, clicks: 1, finish: true },
    { failAt: 'escape', escapes: 0, clicks: 1, finish: true },
    { failAt: 'gone', escapes: 1, clicks: 1, finish: true },
    { failAt: 'finish', escapes: 1, clicks: 1, finish: true },
  ];
  for (const { failAt, escapes, clicks, finish } of cases) {
    const w = world({ failAt });
    const result = await w.read();
    assert.equal(result.outcome, 'failed', failAt);
    assert.equal(result.reason, USAGE_REASONS.error('调试连接已断开'), failAt);
    settled(w, { escapes, clicks });
    assert.equal(w.calls.includes('finish'), finish, `${failAt}: finish called`);
  }
});

test('idle: typing always blocks; recent activity blocks only when idleness is asked for', () => {
  assert.equal(idleDecision({ typing: true, idleMs: 1e9 }, 0), USAGE_REASONS.typing);
  assert.equal(idleDecision({ typing: false, idleMs: 0 }, 0), null);
  assert.equal(idleDecision({ typing: false, idleMs: 19999 }, 20000), USAGE_REASONS.busy);
  assert.equal(idleDecision({ typing: false, idleMs: 20000 }, 20000), null);
  assert.equal(idleDecision({ typing: false }, 20000), USAGE_REASONS.busy, 'an unknown idle time is not idle');
});

test('backoff: the interval stays at 10 minutes for two failures, then doubles up to 4 hours', () => {
  assert.equal(USAGE.intervalMs, 600000);
  assert.equal(usageDelay(0), 600000);
  assert.equal(usageDelay(2), 600000);
  assert.equal(usageDelay(3), 1200000);
  assert.equal(usageDelay(4), 2400000);
  assert.equal(usageDelay(5), 4800000);
  assert.equal(usageDelay(50), USAGE.maxBackoffMs);
});

test('test timings can only shorten the waits', () => {
  assert.equal(usageTiming({ GROKBOT_TEST_USAGE_INTERVAL_MS: '3000' }).intervalMs, 3000);
  assert.equal(usageTiming({ GROKBOT_TEST_USAGE_INTERVAL_MS: '99999999' }).intervalMs, USAGE.intervalMs);
  assert.equal(usageTiming({ GROKBOT_TEST_USAGE_IDLE_MS: 'abc' }).idleMs, USAGE.idleMs);
  assert.equal(usageTiming({}).idleMs, 20000);
});

test('view: three colors at 80 and 95, a stale mark after 30 minutes, nothing when off or never read', () => {
  const limits = usageLimits();
  const at = Date.parse('2026-11-15T08:00:00.000Z');
  const state = (percent, enabled = true) => ({ enabled, percent, readAt: '2026-11-15T08:00:00.000Z' });
  assert.equal(usageView(state(79), at, limits).tone, 'normal');
  assert.equal(usageView(state(80), at, limits).tone, 'warn');
  assert.equal(usageView(state(94), at, limits).tone, 'warn');
  assert.equal(usageView(state(95), at, limits).tone, 'danger');
  assert.equal(usageView(state(100), at, limits).tone, 'danger');
  assert.equal(usageView(state(0), at, limits).tone, 'normal');

  const fresh = usageView(state(97), at + 30 * 60000, limits);
  assert.equal(fresh.stale, false, 'exactly 30 minutes is not stale yet');
  assert.equal(fresh.label, '用量 97%');
  assert.equal(fresh.title, 'Grok Bot 用量 97%，30 分钟前读到');
  const stale = usageView(state(97), at + 31 * 60000, limits);
  assert.equal(stale.stale, true);
  assert.equal(stale.label, '用量 97%（31 分钟前）');
  assert.equal(usageView(state(97), at + 5 * 3600000, limits).label, '用量 97%（5 小时前）');
  assert.equal(usageView(state(97), at + 10000, limits).title, 'Grok Bot 用量 97%，刚刚读到');

  assert.equal(usageView(state(97, false), at, limits), null, 'switched off');
  assert.equal(usageView({ enabled: true, percent: null, readAt: null }, at, limits), null, 'never read');
  assert.equal(usageView(null, at, limits), null);
  assert.equal(usageView({ enabled: true, percent: 101, readAt: '2026-11-15T08:00:00.000Z' }, at, limits), null);
  assert.equal(usageView({ enabled: true, percent: 50, readAt: 'yesterday' }, at, limits), null);
});

test('the usage state file round trips; missing or damaged reads as switched on with nothing read', async () => {
  const dir = await tempDir('store-usage');
  const store = openStore(dir);
  assert.deepEqual(await store.readUsage(), DEFAULT_USAGE);
  const full = {
    enabled: false,
    percent: 97,
    readAt: '2026-11-15T08:00:00.000Z',
    lastError: { reason: USAGE_REASONS.noNumber, at: '2026-11-15T07:50:00.000Z' },
    lastAttempt: { outcome: 'ok', reason: null, at: '2026-11-15T08:00:00.000Z' },
  };
  await store.writeUsage(full);
  assert.deepEqual(await store.readUsage(), full);
  await assert.rejects(store.writeUsage({ percent: 3 }));
  assert.deepEqual(await store.readUsage(), full, 'a rejected write leaves the file alone');

  for (const text of ['{"enabled": tru', '[]', '{"percent": 50}', 'null', '{"enabled": "yes"}']) {
    await writeFile(join(dir, 'usage.json'), text);
    assert.deepEqual(await store.readUsage(), DEFAULT_USAGE, text);
  }
  await writeFile(join(dir, 'usage.json'), JSON.stringify({ enabled: true, percent: 140, readAt: '2026-11-15T08:00:00.000Z', lastError: 'x' }));
  assert.deepEqual(await store.readUsage(), DEFAULT_USAGE, 'an out-of-range figure and a malformed error are dropped');
});

test('panel messages: usage figure and the show-usage switch', () => {
  assert.deepEqual(parsePanelPayload(JSON.stringify({ type: 'usage', percent: 97, text: 'Premium' })), { type: 'usage', percent: 97 });
  assert.deepEqual(parsePanelPayload(JSON.stringify({ type: 'usage-toggle', enabled: false })), { type: 'usage-toggle', enabled: false });
  for (const raw of [{ type: 'usage', percent: 101 }, { type: 'usage', percent: '97' }, { type: 'usage', percent: 9.5 }, { type: 'usage-toggle', enabled: 'no' }]) {
    assert.equal(parsePanelPayload(JSON.stringify(raw)), null, JSON.stringify(raw));
  }
});

// A session that only answers what the keeper itself sends (registering its page script and installing it).
const fakeSession = () => ({ sent: [], async send(method) { this.sent.push(method); return method === 'Runtime.evaluate' ? { result: { value: true } } : { identifier: 'S1' }; } });
const waitUntil = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return check();
};

test('keeper: the first read after attach lands in the store and in the panels; a repeated failure is logged once', async () => {
  const dir = await tempDir('usage-keeper');
  const store = openStore(dir);
  const logs = [];
  const pushed = [];
  let w = world({ opensWith: 61 });
  const timing = { ...USAGE, firstRetryMs: 5 };
  const keeper = createUsageKeeper({ store, log: (line) => logs.push(line), binding: 'b', onChange: (s) => pushed.push(s.percent), timing, steps: () => w, sleep: async () => {} });
  await keeper.attach('W1', fakeSession());
  assert.ok(await waitUntil(async () => (await store.readUsage()).percent === 61));
  assert.equal(w.sheet, false);
  assert.ok(pushed.includes(61), 'panels told about 61');
  assert.ok(logs.some((line) => line.includes('读到 61%')));

  // Three failures in a row: one log line, failure count 3, figure cleared, reason kept for status.
  w = world({ opensWith: null });
  for (let i = 0; i < 3; i++) {
    await writeFile(join(dir, 'usage.json'), JSON.stringify({ ...(await store.readUsage()), readAt: '2026-01-01T00:00:00.000Z' }));
    keeper.detach('W1');
    await keeper.attach('W1', fakeSession());
    await waitUntil(async () => keeper.failures === i + 1);
  }
  assert.equal(keeper.failures, 3);
  assert.equal(logs.filter((line) => line.includes(USAGE_REASONS.noNumber)).length, 1, 'the same failure is logged once');
  const state = await store.readUsage();
  assert.equal(state.percent, null, 'no figure shown after a failure');
  assert.equal(state.lastError.reason, USAGE_REASONS.noNumber);
  assert.ok(usageDelay(keeper.failures, timing) > timing.intervalMs, 'the next automatic read is pushed out');
  keeper.stop();
});

test('keeper: a window waiting for its account button is retried without counting failures, and switched off reads nothing', async () => {
  const dir = await tempDir('usage-keeper-off');
  const store = openStore(dir);
  let looks = 0;
  const w = world();
  const peek = w.page.peek;
  w.page.peek = async () => (++looks < 3 ? { typing: false, idleMs: 0, menuOpen: false, percent: null, button: false } : peek());
  const keeper = createUsageKeeper({ store, log: () => {}, binding: 'b', timing: { ...USAGE, firstRetryMs: 1 }, steps: () => w, sleep: async () => {} });
  await keeper.attach('W1', fakeSession());
  assert.ok(await waitUntil(async () => (await store.readUsage()).percent === 97));
  assert.equal(keeper.failures, 0);
  assert.equal(w.clicks, 1);

  await keeper.setEnabled(false);
  assert.equal((await store.readUsage()).enabled, false);
  await writeFile(join(dir, 'usage.json'), JSON.stringify({ ...(await store.readUsage()), readAt: '2026-01-01T00:00:00.000Z' }));
  keeper.detach('W1');
  await keeper.attach('W1', fakeSession());
  await keeper.userSaw(12);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.clicks, 1, 'no click while switched off');
  assert.notEqual((await store.readUsage()).percent, 12, "a figure from the user's menu is ignored while off");
  keeper.stop();
});

test('keeper: switched on from outside, the pages are told even when a reading lands before the next look', async () => {
  const dir = await tempDir('usage-keeper-sync');
  const store = openStore(dir);
  const told = [];
  const session = {
    async send(method, params) {
      const enable = /"enable", (\{.*\})\)$/.exec(params?.expression ?? '');
      if (enable) told.push(JSON.parse(enable[1]).enabled);
      return method === 'Runtime.evaluate' ? { result: { value: true } } : { identifier: 'S1' };
    },
  };
  const keeper = createUsageKeeper({ store, log: () => {}, binding: 'b', steps: () => world(), sleep: async () => {} });
  await store.writeUsage({ ...DEFAULT_USAGE, enabled: false });
  await keeper.attach('W1', session);
  await keeper.sync();
  assert.deepEqual(told, [false]);
  // As `usage on` would, then a figure from the user's menu before watch's next look.
  await store.writeUsage({ ...(await store.readUsage()), enabled: true });
  await keeper.userSaw(50);
  await keeper.sync();
  assert.deepEqual(told, [false, true], 'the pages heard about the switch');
  await keeper.sync();
  assert.deepEqual(told, [false, true], 'and only once');
  keeper.stop();
});

test("the page-side reader keeps its state under a name the panel's update hook does not use", () => {
  const key = JSON.parse(/, (\{.*\})\)$/.exec(usagePageExpression('peek'))[1]).key;
  assert.notEqual(key, `${MARK.key}Usage`);
  assert.ok(key.startsWith(MARK.key));
});

test('CLI usage on/off writes the switch and status reports it', async () => {
  const dir = await tempDir('usage-cli');
  let r = await runCli(['usage', 'off'], { GROKBOT_DATA_DIR: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).usage.enabled, false);
  assert.equal(JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8')).enabled, false);
  r = await runCli(['status'], { GROKBOT_DATA_DIR: dir });
  assert.deepEqual(JSON.parse(r.stdout).usage, { ...DEFAULT_USAGE, enabled: false });
  r = await runCli(['usage', 'on'], { GROKBOT_DATA_DIR: dir });
  assert.equal(JSON.parse(r.stdout).usage.enabled, true);
  r = await runCli(['usage', 'maybe'], { GROKBOT_DATA_DIR: dir });
  assert.notEqual(r.code, 0);
});
