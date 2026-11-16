import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { UserError } from './errors.mjs';
import { checkImageBytes, loadThemes } from './themes.mjs';

// The user's own picture lives in one slot under the data folder, never next to the shipped themes.
export const CUSTOM_ID = 'custom';
export const CUSTOM_NAME = '我的图片';
const SLOT = 'custom';
const META = 'custom.json';
const WALLPAPER = /^wallpaper\.(jpg|png|webp)$/;
const MAX_NAME_LENGTH = 255;

export const customDir = (dataDir) => join(dataDir, SLOT);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Throws a UserError with the reason; the bytes are only written once every check has passed.
export function checkCustomImage(name, bytes) {
  try {
    // Photos often end in .jpeg; it is the same format as .jpg.
    return checkImageBytes(name.replace(/\.jpeg$/i, '.jpg'), bytes.length, bytes.subarray(0, 12));
  } catch (error) {
    throw new UserError(`这张图不能用：${error.message}`);
  }
}

// Puts the picture in the slot, replacing any earlier one. The source file is only read.
export async function importCustomImage(dataDir, { name, bytes }) {
  const originalName = basename(String(name)).slice(0, MAX_NAME_LENGTH) || 'image';
  const { ext } = checkCustomImage(originalName, bytes);
  const dir = customDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = `wallpaper${ext}`;
  const stamp = `${process.pid}.${Date.now()}`;
  await writeFile(join(dir, `${file}.${stamp}.tmp`), bytes, { mode: 0o600 });
  await rename(join(dir, `${file}.${stamp}.tmp`), join(dir, file));
  const meta = { file, originalName, importedAt: new Date().toISOString(), bytes: bytes.length, sha256: sha256(bytes) };
  await writeFile(join(dir, `${META}.${stamp}.tmp`), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  await rename(join(dir, `${META}.${stamp}.tmp`), join(dir, META));
  for (const entry of await readdir(dir)) {
    if (WALLPAPER.test(entry) && entry !== file) await rm(join(dir, entry), { force: true });
  }
  return meta;
}

export async function importCustomImageFile(dataDir, path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw new UserError(`找不到图片文件：${path}`);
    if (error.code === 'EISDIR') throw new UserError(`这是一个文件夹，不是图片：${path}`);
    throw new UserError(`读不了图片文件 ${path}：${error.message}`);
  }
  return importCustomImage(dataDir, { name: basename(path), bytes });
}

// Same shape as a shipped theme. A missing or damaged slot reads as "no picture yet".
export async function loadCustomTheme(dataDir) {
  const dir = customDir(dataDir);
  let meta;
  try {
    meta = JSON.parse(await readFile(join(dir, META), 'utf8'));
  } catch {
    return null;
  }
  if (meta === null || typeof meta !== 'object' || typeof meta.file !== 'string' || !WALLPAPER.test(meta.file)) return null;
  const wallpaperPath = join(dir, meta.file);
  let mime;
  try {
    const handle = await open(wallpaperPath, 'r');
    try {
      const { size } = await handle.stat();
      const head = Buffer.alloc(12);
      await handle.read(head, 0, 12, 0);
      ({ mime } = checkImageBytes(meta.file, size, head));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  return {
    id: CUSTOM_ID,
    name: CUSTOM_NAME,
    wallpaper: meta.file,
    // The user's picture is shown as it is; how much of it shows through is the strength slider's job.
    opacity: 1,
    appearance: 'auto',
    accent: undefined,
    credit: undefined,
    mime,
    thumb: null,
    thumbMime: null,
    dir,
    wallpaperPath,
    thumbPath: null,
    custom: { originalName: typeof meta.originalName === 'string' ? meta.originalName : meta.file, importedAt: meta.importedAt ?? null },
  };
}

// The user's own theme packs live in the data folder, outside the repository: <data>/themes/<id>/, same layout as a
// shipped pack. A file named hide-builtin next to them leaves the shipped samples out of the list.
export const LOCAL_THEMES = 'themes';
export const HIDE_SHIPPED = 'hide-builtin';
export const localThemesDir = (dataDir) => join(dataDir, LOCAL_THEMES);

async function loadLocalThemes(dataDir) {
  const root = localThemesDir(dataDir);
  try {
    const found = await loadThemes(root);
    const hideShipped = found.themes.length > 0 && (await stat(join(root, HIDE_SHIPPED)).then(() => true, () => false));
    return { ...found, hideShipped };
  } catch {
    // No such folder: the user has no packs of their own.
    return { themes: [], broken: [], hideShipped: false };
  }
}

// Everything apply, watch and the panel can switch to: the user's picture first, then their own packs, then the shipped samples.
export async function loadApplicableThemes(dataDir) {
  const shippedAll = await loadThemes();
  const local = await loadLocalThemes(dataDir);
  const custom = await loadCustomTheme(dataDir);
  const notReserved = (theme) => theme.id !== CUSTOM_ID;
  const mine = local.themes.filter(notReserved);
  const taken = new Set(mine.map((theme) => theme.id));
  // A pack of the user's with the same id as a shipped one stands in for it.
  const shipped = local.hideShipped ? [] : shippedAll.themes.filter((theme) => notReserved(theme) && !taken.has(theme.id));
  const reserved = [...shippedAll.themes, ...local.themes].some((theme) => !notReserved(theme))
    ? [{ id: CUSTOM_ID, reason: `id "${CUSTOM_ID}" 留给「${CUSTOM_NAME}」，主题包不能用` }]
    : [];
  return { themes: [...(custom ? [custom] : []), ...mine, ...shipped], broken: [...shippedAll.broken, ...local.broken, ...reserved] };
}
