import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKS_DIR, runCli, tempDir } from './helpers.mjs';

process.env.GROKBOT_THEMES_DIR = PACKS_DIR;
const { checkCustomImage, customDir, importCustomImage, loadApplicableThemes, loadCustomTheme } = await import('../src/custom.mjs');
const { UserError } = await import('../src/errors.mjs');
const { openStore } = await import('../src/store.mjs');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(64, 3)]);
const LIMIT = 4 * 1024 * 1024;

const rejects = (name, bytes, pattern) => {
  assert.throws(() => checkCustomImage(name, bytes), (error) => error instanceof UserError && pattern.test(error.message), name);
};

test('the user picture passes the same checks as a shipped wallpaper', () => {
  assert.deepEqual(checkCustomImage('a.png', PNG), { ext: '.png', mime: 'image/png' });
  assert.deepEqual(checkCustomImage('B.JPG', JPEG), { ext: '.jpg', mime: 'image/jpeg' });
  assert.deepEqual(checkCustomImage('photo.jpeg', JPEG), { ext: '.jpg', mime: 'image/jpeg' });
  assert.deepEqual(checkCustomImage('c.webp', WEBP), { ext: '.webp', mime: 'image/webp' });

  rejects('anim.gif', PNG, /不是 \.jpg、\.png 或 \.webp/);
  rejects('noext', PNG, /不是 \.jpg、\.png 或 \.webp/);
  rejects('fake.png', JPEG, /内容和扩展名对不上/);
  rejects('fake.jpg', WEBP, /内容和扩展名对不上/);
  rejects('fake.webp', PNG, /内容和扩展名对不上/);
  rejects('empty.png', Buffer.alloc(0), /空文件/);
  rejects('huge.png', Buffer.concat([PNG, Buffer.alloc(LIMIT)]), /必须小于 4\.0 MB/);
  assert.doesNotThrow(() => checkCustomImage('just-under.png', Buffer.concat([PNG, Buffer.alloc(LIMIT - PNG.length - 1)])));
});

test('importing fills the one slot, replaces the previous picture and records where it came from', async () => {
  const dir = await tempDir('custom');
  assert.equal(await loadCustomTheme(dir), null, 'no slot yet');

  const first = await importCustomImage(dir, { name: 'C:\\pics\\holiday.png', bytes: PNG });
  assert.equal(first.originalName, 'holiday.png');
  assert.equal(first.sha256, createHash('sha256').update(PNG).digest('hex'));
  let theme = await loadCustomTheme(dir);
  assert.equal(theme.id, 'custom');
  assert.equal(theme.name, '我的图片');
  assert.equal(theme.appearance, 'auto');
  assert.equal(theme.mime, 'image/png');
  assert.deepEqual(await readFile(theme.wallpaperPath), PNG);

  await importCustomImage(dir, { name: 'me.webp', bytes: WEBP });
  assert.deepEqual((await readdir(customDir(dir))).sort(), ['custom.json', 'wallpaper.webp'], 'old picture and temp files are gone');
  theme = await loadCustomTheme(dir);
  assert.equal(theme.mime, 'image/webp');
  assert.equal(theme.custom.originalName, 'me.webp');

  await assert.rejects(importCustomImage(dir, { name: 'bad.png', bytes: JPEG }), UserError);
  assert.equal((await loadCustomTheme(dir)).mime, 'image/webp', 'a refused picture leaves the slot alone');
});

test('the slot joins the applicable themes first, and a damaged slot reads as no picture', async () => {
  const dir = await tempDir('custom-merge');
  assert.deepEqual((await loadApplicableThemes(dir)).themes.map((t) => t.id), ['night-harbor', 'paper-light']);
  await importCustomImage(dir, { name: 'x.jpg', bytes: JPEG });
  assert.deepEqual((await loadApplicableThemes(dir)).themes.map((t) => t.id), ['custom', 'night-harbor', 'paper-light']);

  await writeFile(join(customDir(dir), 'custom.json'), '{"file": "../../etc/passwd"}');
  assert.equal(await loadCustomTheme(dir), null);
  await writeFile(join(customDir(dir), 'custom.json'), '{"file": "wallpaper.png"}');
  assert.equal(await loadCustomTheme(dir), null, 'meta pointing at a file that is not there');
  await writeFile(join(customDir(dir), 'custom.json'), 'not json');
  assert.equal(await loadCustomTheme(dir), null);
});

test("the user's own packs in the data folder come after their picture and before the shipped ones; hide-builtin leaves the shipped ones out", async () => {
  const dir = await tempDir('local-themes');
  const ids = async () => (await loadApplicableThemes(dir)).themes.map((t) => t.id);
  const pack = async (id, json = {}) => {
    const folder = join(dir, 'themes', id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'wallpaper.png'), PNG);
    await writeFile(join(folder, 'theme.json'), JSON.stringify({ id, name: id, wallpaper: 'wallpaper.png', appearance: 'dark', ...json }));
  };
  await pack('my-poster');
  assert.deepEqual(await ids(), ['my-poster', 'night-harbor', 'paper-light']);
  await importCustomImage(dir, { name: 'x.jpg', bytes: JPEG });
  assert.deepEqual(await ids(), ['custom', 'my-poster', 'night-harbor', 'paper-light']);

  // Same id as a shipped pack: the user's stands in for it.
  await pack('paper-light', { name: '我的纸' });
  let loaded = await loadApplicableThemes(dir);
  assert.deepEqual(loaded.themes.map((t) => t.id), ['custom', 'my-poster', 'paper-light', 'night-harbor']);
  assert.equal(loaded.themes.find((t) => t.id === 'paper-light').name, '我的纸');

  // A broken pack of the user's is reported, and one that takes the reserved id is refused.
  await mkdir(join(dir, 'themes', 'no-json'), { recursive: true });
  await pack('custom');
  loaded = await loadApplicableThemes(dir);
  assert.ok(loaded.broken.some((b) => b.id === 'no-json' && /theme\.json/.test(b.reason)), JSON.stringify(loaded.broken));
  assert.ok(loaded.broken.some((b) => b.id === 'custom'), JSON.stringify(loaded.broken));
  assert.equal(loaded.themes.filter((t) => t.id === 'custom').length, 1);

  await writeFile(join(dir, 'themes', 'hide-builtin'), '');
  assert.deepEqual(await ids(), ['custom', 'my-poster', 'paper-light']);
});

test('hide-builtin with no pack of the user’s own hides nothing', async () => {
  const dir = await tempDir('local-empty');
  await mkdir(join(dir, 'themes'), { recursive: true });
  await writeFile(join(dir, 'themes', 'hide-builtin'), '');
  assert.deepEqual((await loadApplicableThemes(dir)).themes.map((t) => t.id), ['night-harbor', 'paper-light']);
});

test('strength round trips, rejects bad values and a damaged file reads as never set', async () => {
  const dir = await tempDir('strength');
  const store = openStore(dir);
  assert.equal(await store.readStrength(), null);
  await store.writeStrength(0);
  assert.equal(await store.readStrength(), 0);
  await store.writeStrength(100);
  assert.equal(await store.readStrength(), 100);
  for (const bad of [-1, 101, 50.5, '50', null, NaN]) await assert.rejects(store.writeStrength(bad), String(bad));
  assert.equal(await store.readStrength(), 100, 'a refused write leaves the file alone');
  assert.ok(!(await readdir(dir)).some((name) => name.endsWith('.tmp')), 'no temp files left');

  for (const text of ['{"strength": 4', '{"strength": "40"}', '{"strength": 140}', '[]', 'null']) {
    await writeFile(join(dir, 'strength.json'), text);
    assert.equal(await store.readStrength(), null, text);
  }
});

test('apply --image with a file that is not there exits 1, says so, and writes nothing', async () => {
  const dir = await tempDir('cli-image');
  const missing = join(dir, 'nope', 'me.png');
  const { code, stderr } = await runCli(['apply', '--image', missing, '--no-daemon'], { GROKBOT_DATA_DIR: dir });
  assert.equal(code, 1);
  assert.match(stderr, /找不到图片文件/);
  assert.ok(stderr.includes(missing));
  assert.ok(!existsSync(customDir(dir)));
});

test('apply --image refuses a disguised file with the reason, and leaves the source alone', async () => {
  const dir = await tempDir('cli-image-bad');
  const source = join(dir, 'fake.png');
  await writeFile(source, JPEG);
  const { code, stderr } = await runCli(['apply', '--image', source, '--no-daemon'], { GROKBOT_DATA_DIR: join(dir, 'data') });
  assert.equal(code, 1);
  assert.match(stderr, /这张图不能用：fake\.png 的内容和扩展名对不上/);
  assert.deepEqual(await readFile(source), JPEG);
});

test('apply --image with the debug port closed keeps the picture in the slot and suggests apply custom --relaunch', async () => {
  const dir = await tempDir('cli-image-closed');
  const source = join(dir, 'mine.png');
  await writeFile(source, PNG);
  const data = join(dir, 'data');
  const { code, stderr } = await runCli(['apply', '--image', source, '--no-daemon'], { GROKBOT_DATA_DIR: data });
  assert.equal(code, 2);
  assert.match(stderr, /apply custom --relaunch/);
  assert.deepEqual(await readFile(source), PNG, 'source untouched');
  assert.deepEqual(await readFile((await loadCustomTheme(data)).wallpaperPath), PNG);
  assert.equal(await openStore(data).readLastApplied(), null);
});

test('apply rejects --strength outside 0-100, and --image together with a theme id', async () => {
  const dir = await tempDir('cli-strength');
  for (const value of ['101', '-5', 'abc', '40.5', '']) {
    const { code, stderr } = await runCli(['apply', 'night-harbor', `--strength=${value}`, '--no-daemon'], { GROKBOT_DATA_DIR: dir });
    assert.equal(code, 1, value);
    assert.match(stderr, /--strength 必须是 0 到 100 的整数/, value);
  }
  await mkdir(join(dir, 'x'), { recursive: true });
  const { code, stderr } = await runCli(['apply', 'night-harbor', '--image', join(dir, 'x', 'a.png')], { GROKBOT_DATA_DIR: dir });
  assert.equal(code, 1);
  assert.match(stderr, /二选一/);
  assert.equal(await openStore(dir).readStrength(), null);
});
