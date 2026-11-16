import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { UserError } from '../src/errors.mjs';
import { openStore } from '../src/store.mjs';
import { runCli, tempDir } from './helpers.mjs';

test('last-applied round trips and restore flips only the restored flag', async () => {
  const dir = join(await tempDir('store'), 'nested', 'data');
  const store = openStore(dir);
  assert.equal(await store.readLastApplied(), null, 'missing file reads as null');

  const record = { themeId: 'night-harbor', appliedAt: '2026-11-14T08:00:00.000Z', restored: false };
  await store.writeLastApplied(record);
  assert.deepEqual(await store.readLastApplied(), record);

  await store.markRestored();
  assert.deepEqual(await store.readLastApplied(), { ...record, restored: true });
  assert.deepEqual(await readdir(dir), ['last-applied.json'], 'no temp files left behind');
});

test('markRestored without a prior apply writes nothing', async () => {
  const dir = await tempDir('store-empty');
  assert.equal(await openStore(dir).markRestored(), null);
  assert.deepEqual(await readdir(dir), []);
});

test('a corrupt state file is reported, not silently replaced', async () => {
  const dir = await tempDir('store-corrupt');
  await writeFile(join(dir, 'last-applied.json'), '{"themeId": 3');
  await assert.rejects(openStore(dir).readLastApplied(), UserError);
});

test('panel state round trips, and a damaged panel file reads as no saved position', async () => {
  const dir = await tempDir('store-panel');
  const store = openStore(dir);
  assert.equal(await store.readPanel(), null);
  await store.writePanel({ x: 300, y: 40, collapsed: true });
  assert.deepEqual(await store.readPanel(), { x: 300, y: 40, collapsed: true });
  await assert.rejects(store.writePanel({ x: 'left', y: 40, collapsed: true }));
  assert.deepEqual(await store.readPanel(), { x: 300, y: 40, collapsed: true }, 'a rejected write leaves the file alone');

  await writeFile(join(dir, 'panel.json'), '{"x": 3');
  assert.equal(await store.readPanel(), null);
  await writeFile(join(dir, 'panel.json'), '{"x": 3, "y": 4}');
  assert.equal(await store.readPanel(), null);
});

test('status reports the stored last-applied record under GROKBOT_DATA_DIR', async () => {
  const dir = await tempDir('store-status');
  const record = { themeId: 'paper-light', appliedAt: '2026-11-14T09:30:00.000Z', restored: true };
  await openStore(dir).writeLastApplied(record);

  const { code, stdout } = await runCli(['status'], { GROKBOT_DATA_DIR: dir });
  assert.equal(code, 0);
  const status = JSON.parse(stdout);
  assert.deepEqual(status.lastApplied, record);
  assert.equal(status.debug, 'closed', 'closed test port reads as debug closed');
  assert.deepEqual(
    Object.keys(status).sort(),
    ['alwaysOn', 'appPath', 'autostart','debug', 'debugReportedAs', 'lastApplied', 'launcher', 'panel', 'panelPortTakenByOther', 'platform', 'ports', 'running', 'usage'],
  );
});
