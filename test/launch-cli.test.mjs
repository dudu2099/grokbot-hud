// The launch and launcher commands through the real entry script. helpers.runCli points the app at a path that does
// not exist, the desktop at a temp path that is never created, and turns dialogs off, so nothing real is touched.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { popupScript } from '../src/platform/win32.mjs';
import { NO_DESKTOP_DIR, runCli, tempDir } from './helpers.mjs';

test('launch with no Grok Bot to be found exits 1, says so, and writes no state', async () => {
  const dir = await tempDir('launch-cli');
  const { code, stderr } = await runCli(['launch'], { GROKBOT_DATA_DIR: dir });
  assert.equal(code, 1);
  assert.match(stderr, /不存在，没法打开带壁纸的 Grok Bot，什么都没有动/);
  assert.ok(!existsSync(`${dir}/last-applied.json`));
});

test('launch takes no arguments', async () => {
  const { code, stderr } = await runCli(['launch', 'extra']);
  assert.equal(code, 1);
  assert.match(stderr, /用法/);
});

test('launcher on without Grok Bot builds nothing and says why', { skip: process.platform !== 'win32' && process.platform !== 'darwin' }, async () => {
  const { code, stderr } = await runCli(['launcher', 'on']);
  assert.equal(code, 1);
  assert.match(stderr, /没有建「Grok Bot（带壁纸）」图标/);
  assert.ok(!existsSync(NO_DESKTOP_DIR), 'the test desktop was never created');
});

test('launcher off with nothing installed is a success; a bad mode is refused', async () => {
  const off = await runCli(['launcher', 'off']);
  assert.equal(off.code, 0);
  assert.equal(JSON.parse(off.stdout).launcher.installed, false);
  const bad = await runCli(['launcher', 'maybe']);
  assert.equal(bad.code, 1);
});

test('the Windows dialog script quotes the text and uses Yes/No with a 60 s timeout for the confirm box', () => {
  const script = popupScript("关掉它'再开", 60, 4 + 32 + 4096);
  assert.equal(script, "(New-Object -ComObject WScript.Shell).Popup('关掉它''再开', 60, 'Grok Bot 换壁纸', 4132)");
});
