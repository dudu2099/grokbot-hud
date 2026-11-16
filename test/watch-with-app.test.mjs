// watch --with-app's exit rule on a fake clock: one observation per 2-second look at the debug port.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPresence, WITH_APP, withAppTiming } from '../src/watch.mjs';

const TICK = 2000;

// Feeds `seen(t)` every tick until `untilMs`; returns the time of the first exit reason, or null.
function run({ withApp = true, seen, untilMs }) {
  let t = 0;
  const observe = appPresence({ withApp, now: () => t });
  for (; t <= untilMs; t += TICK) {
    const reason = observe(seen(t));
    if (reason) return { at: t, reason };
  }
  return null;
}

test('the constants are the agreed 30 s and 60 s', () => {
  assert.deepEqual({ ...WITH_APP }, { goneMs: 30000, graceMs: 60000 });
});

test('seen, then gone: leaves once the port has been silent for 30 s, not before', () => {
  const out = run({ seen: (t) => t < 10000, untilMs: 120000 });
  // Last seen at 8000; the first look at or after 38000 is 38000.
  assert.equal(out.at, 38000);
  assert.match(out.reason, /30 秒没有应答/);
});

test('a short blink of the port does not end it: the 30 s restart from the last answer', () => {
  const out = run({ seen: (t) => t < 10000 || (t >= 30000 && t < 32000), untilMs: 200000 });
  assert.equal(out.at, 60000);
});

test('never seen: leaves at the 60 s grace, not before', () => {
  const out = run({ seen: () => false, untilMs: 200000 });
  assert.equal(out.at, 60000);
  assert.match(out.reason, /60 秒内一直没见到 Grok Bot/);
});

test('seen late but inside the grace: the gone rule takes over from then on', () => {
  const out = run({ seen: (t) => t >= 50000 && t < 52000, untilMs: 200000 });
  assert.equal(out.at, 80000);
});

test('the app there all along: never leaves', () => {
  assert.equal(run({ seen: () => true, untilMs: 24 * 3600 * 1000 }), null);
});

test('without --with-app: never leaves, whatever the port does', () => {
  assert.equal(run({ withApp: false, seen: () => false, untilMs: 24 * 3600 * 1000 }), null);
  assert.equal(run({ withApp: false, seen: (t) => t < 10000, untilMs: 24 * 3600 * 1000 }), null);
});

test('the test-only variables can shorten the waits but never lengthen them', () => {
  assert.deepEqual(withAppTiming({}), { goneMs: 30000, graceMs: 60000 });
  assert.deepEqual(withAppTiming({ GROKBOT_TEST_APP_GONE_MS: '3000', GROKBOT_TEST_APP_GRACE_MS: '6000' }), { goneMs: 3000, graceMs: 6000 });
  assert.deepEqual(withAppTiming({ GROKBOT_TEST_APP_GONE_MS: '999999', GROKBOT_TEST_APP_GRACE_MS: 'x' }), { goneMs: 30000, graceMs: 60000 });
});
