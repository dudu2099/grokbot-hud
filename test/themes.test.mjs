import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadThemes, thumbDataUrl, wallpaperDataUrl } from '../src/themes.mjs';
import { PACKS_DIR, ROOT, runCli, tempDir } from './helpers.mjs';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

async function pack(root, folder, json, files = { 'wallpaper.png': PNG_HEAD }) {
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'theme.json'), JSON.stringify(json));
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
}

const base = (id, extra = {}) => ({ id, name: id, wallpaper: 'wallpaper.png', appearance: 'dark', ...extra });

test('one broken pack per rule is reported while valid packs still load', async () => {
  const root = await tempDir('themes');
  await cp(join(PACKS_DIR, 'night-harbor'), join(root, 'night-harbor'), { recursive: true });
  await cp(join(ROOT, 'test', 'fixtures', 'themes', 'broken-pack'), join(root, 'broken-pack'), { recursive: true });
  await pack(root, 'default-opacity', base('default-opacity'));
  await pack(root, 'bad-opacity', base('bad-opacity', { opacity: 1.5 }));
  await pack(root, 'low-opacity', base('low-opacity', { opacity: 0.1 }));
  await pack(root, 'id-mismatch', base('something-else'));
  await pack(root, 'bad-appearance', base('bad-appearance', { appearance: 'dim' }));
  await pack(root, 'missing-file', base('missing-file', { wallpaper: 'nope.png' }));
  await pack(root, 'wrong-type', base('wrong-type', { wallpaper: 'wallpaper.gif' }), { 'wallpaper.gif': PNG_HEAD });
  await pack(root, 'fake-png', base('fake-png'), { 'wallpaper.png': JPEG_HEAD });
  await pack(root, 'oversize', base('oversize'), {
    'wallpaper.png': Buffer.concat([PNG_HEAD, Buffer.alloc(4 * 1024 * 1024)]),
  });
  await pack(root, 'Bad_Folder', base('Bad_Folder'));
  await mkdir(join(root, 'no-json'));

  const { themes, broken } = await loadThemes(root);

  assert.deepEqual(themes.map((t) => t.id), ['default-opacity', 'night-harbor']);
  assert.deepEqual(
    broken.map((b) => b.id).sort(),
    ['Bad_Folder', 'bad-appearance', 'bad-opacity', 'broken-pack', 'fake-png', 'id-mismatch', 'low-opacity', 'missing-file', 'no-json', 'oversize', 'wrong-type'],
  );
  assert.ok(broken.every((b) => typeof b.reason === 'string' && b.reason.length > 0), 'every broken pack says why');
  assert.equal(themes[0].opacity, 0.9, 'missing opacity falls back to 0.9');
});

test('a loaded theme carries its wallpaper as a data URL of the real file', async () => {
  const { themes } = await loadThemes(PACKS_DIR);
  const night = themes.find((t) => t.id === 'night-harbor');
  const url = await wallpaperDataUrl(night);
  const prefix = 'data:image/png;base64,';
  assert.ok(url.startsWith(prefix));
  assert.deepEqual(Buffer.from(url.slice(prefix.length), 'base64'), await readFile(join(PACKS_DIR, 'night-harbor', 'wallpaper.png')));
});

test('a thumb is optional, but one that is named must be a real image inside the pack', async () => {
  const root = await tempDir('thumbs');
  const withThumb = { 'wallpaper.png': PNG_HEAD, 'thumb.jpg': JPEG_HEAD };
  await pack(root, 'no-thumb', base('no-thumb'));
  await pack(root, 'good-thumb', base('good-thumb', { thumb: 'thumb.jpg' }), withThumb);
  await pack(root, 'thumb-path', base('thumb-path', { thumb: '../good-thumb/thumb.jpg' }));
  await pack(root, 'thumb-missing', base('thumb-missing', { thumb: 'thumb.png' }));
  await pack(root, 'thumb-gif', base('thumb-gif', { thumb: 'thumb.gif' }), { 'wallpaper.png': PNG_HEAD, 'thumb.gif': PNG_HEAD });
  await pack(root, 'thumb-fake', base('thumb-fake', { thumb: 'thumb.png' }), { 'wallpaper.png': PNG_HEAD, 'thumb.png': JPEG_HEAD });
  await pack(root, 'thumb-huge', base('thumb-huge', { thumb: 'thumb.jpg' }), {
    'wallpaper.png': PNG_HEAD,
    'thumb.jpg': Buffer.concat([JPEG_HEAD, Buffer.alloc(256 * 1024)]),
  });

  const { themes, broken } = await loadThemes(root);

  assert.deepEqual(themes.map((t) => t.id), ['good-thumb', 'no-thumb']);
  assert.deepEqual(broken.map((b) => b.id).sort(), ['thumb-fake', 'thumb-gif', 'thumb-huge', 'thumb-missing', 'thumb-path']);
  const [good, none] = themes;
  assert.equal(good.thumbPath, join(root, 'good-thumb', 'thumb.jpg'));
  assert.equal(await thumbDataUrl(good), `data:image/jpeg;base64,${JPEG_HEAD.toString('base64')}`);
  assert.equal(none.thumbPath, null);
  assert.equal(await thumbDataUrl(none), null);
});

test('list prints every valid pack and no broken ones', async () => {
  const { code, stdout } = await runCli(['list'], { GROKBOT_DATA_DIR: await tempDir('list') });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    themes: [
      { id: 'night-harbor', name: '夜港（占位）', appearance: 'dark', opacity: 0.9 },
      { id: 'paper-light', name: '素笺（占位）', appearance: 'light', opacity: 0.85 },
    ],
    broken: [],
  });
});
