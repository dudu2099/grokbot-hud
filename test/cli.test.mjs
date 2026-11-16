import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../src/store.mjs';
import { runCli, tempDir } from './helpers.mjs';

const SHORTCUT = 'Grok Bot 换壁纸.lnk';

test('apply with an unknown theme exits 1 and names the available themes', async () => {
  const { code, stderr } = await runCli(['apply', 'no-such-theme', '--no-daemon'], { GROKBOT_DATA_DIR: await tempDir('cli') });
  assert.equal(code, 1);
  assert.match(stderr, /night-harbor/);
});

test('apply with an image path but no --image is an unknown theme that points at --image', async () => {
  const { code, stderr } = await runCli(['apply', 'C:\\pics\\me.png', '--no-daemon'], { GROKBOT_DATA_DIR: await tempDir('cli') });
  assert.equal(code, 1);
  assert.match(stderr, /apply --image/);
});

test('apply exits 2 when the debug port is closed and --relaunch is absent, writing no state', async () => {
  const dir = await tempDir('cli');
  const { code, stderr } = await runCli(['apply', 'night-harbor', '--no-daemon'], { GROKBOT_DATA_DIR: dir });
  assert.equal(code, 2);
  assert.match(stderr, /--relaunch/);
  assert.equal(await openStore(dir).readLastApplied(), null);
});

test('restore with the debug port closed exits 1 and does not claim restored', async () => {
  const dir = await tempDir('cli');
  const record = { themeId: 'night-harbor', appliedAt: '2026-11-14T08:00:00.000Z', restored: false };
  await openStore(dir).writeLastApplied(record);
  const { code } = await runCli(['restore'], { GROKBOT_DATA_DIR: dir });
  assert.equal(code, 1);
  assert.deepEqual(await openStore(dir).readLastApplied(), record);
});

test('watch and panel exit 1 with a clear message when the panel port is already taken', async (t) => {
  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  t.after(() => squatter.close());
  const port = String(squatter.address().port);
  for (const command of ['watch', 'panel']) {
    const { code, stderr } = await runCli([command], { GROKBOT_PANEL_PORT: port, GROKBOT_DATA_DIR: await tempDir('cli') });
    assert.equal(code, 1, command);
    assert.match(stderr, new RegExp(`127\\.0\\.0\\.1:${port} 已被占用`), command);
  }
});

test('autostart with anything but on or off exits 1', async () => {
  const { code } = await runCli(['autostart', 'maybe']);
  assert.equal(code, 1);
});

test('autostart on writes the login shortcut, status sees it, and off removes it', { skip: process.platform !== 'win32' }, async () => {
  const startup = await tempDir('startup');
  const env = { GROKBOT_STARTUP_DIR: startup, GROKBOT_DATA_DIR: await tempDir('cli') };

  let r = await runCli(['autostart', 'on'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { autostart: true });
  assert.ok(existsSync(join(startup, SHORTCUT)));
  r = await runCli(['status'], env);
  assert.equal(JSON.parse(r.stdout).autostart, true);

  r = await runCli(['autostart', 'off'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { autostart: false, daemon: { running: false, stopped: false, error: null } });
  assert.ok(!existsSync(join(startup, SHORTCUT)));
});
