import { open, readdir, readFile, realpath } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// GROKBOT_THEMES_DIR exists for tests only, so they run against throwaway packs instead of the shipped ones.
export const THEMES_DIR = process.env.GROKBOT_THEMES_DIR || fileURLToPath(new URL('../themes/', import.meta.url));

const ID_PATTERN = /^[a-z0-9-]+$/;
const ACCENT_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const APPEARANCES = new Set(['dark', 'light']);
const OPACITY = { min: 0.15, max: 1, fallback: 0.9 };
const IMAGE_LIMITS = { wallpaper: 4 * 1024 * 1024, thumb: 256 * 1024 };

const IMAGE_TYPES = {
  '.jpg': { mime: 'image/jpeg', matches: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  '.png': { mime: 'image/png', matches: (head) => head.toString('latin1', 1, 4) === 'PNG' && head[0] === 0x89 },
  '.webp': {
    mime: 'image/webp',
    matches: (head) => head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP',
  },
};

const fail = (reason) => {
  throw new Error(reason);
};

function parseThemeJson(folder, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('theme.json 必须是一个 JSON 对象');
  if (raw.id !== folder) fail(`id "${raw.id}" 必须和文件夹名 "${folder}" 一致`);
  if (typeof raw.name !== 'string' || raw.name.trim() === '') fail('name 不能为空');
  if (!APPEARANCES.has(raw.appearance)) fail('appearance 只能是 "dark" 或 "light"');

  const opacity = raw.opacity ?? OPACITY.fallback;
  if (typeof opacity !== 'number' || !(opacity >= OPACITY.min && opacity <= OPACITY.max)) {
    fail(`opacity 必须是 ${OPACITY.min} 到 ${OPACITY.max} 之间的数字`);
  }
  if (raw.accent !== undefined && !(typeof raw.accent === 'string' && ACCENT_PATTERN.test(raw.accent))) {
    fail('accent 必须是 #rgb 或 #rrggbb 颜色');
  }
  if (raw.credit !== undefined && typeof raw.credit !== 'string') fail('credit 必须是字符串');

  const wallpaper = parseImageName('wallpaper', raw.wallpaper);
  const thumb = raw.thumb === undefined ? null : parseImageName('thumb', raw.thumb);

  return {
    id: raw.id,
    name: raw.name,
    wallpaper: wallpaper.file,
    opacity,
    appearance: raw.appearance,
    accent: raw.accent,
    credit: raw.credit,
    mime: wallpaper.mime,
    thumb: thumb?.file ?? null,
    thumbMime: thumb?.mime ?? null,
  };
}

function parseImageName(field, file) {
  if (typeof file !== 'string' || /[\\/]/.test(file) || file.startsWith('.')) {
    fail(`${field} 必须是主题文件夹里的文件名，不能带路径`);
  }
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) fail(`${field} 只能是 .jpg、.png 或 .webp`);
  return { file, mime: type.mime };
}

export const formatSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

export const WALLPAPER_LIMIT = IMAGE_LIMITS.wallpaper;

// One rule for every image this tool shows, shipped or picked by the user: a known type, a matching file header, under the size limit.
// Returns the type, or throws with a reason a user can act on.
export function checkImageBytes(name, size, head, limit = IMAGE_LIMITS.wallpaper) {
  const ext = extname(name).toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) fail(`${name} 不是 .jpg、.png 或 .webp 图片`);
  if (size === 0) fail(`${name} 是空文件`);
  if (size >= limit) fail(`${name} 有 ${formatSize(size)}，必须小于 ${formatSize(limit)}`);
  if (!type.matches(head)) fail(`${name} 的内容和扩展名对不上，不是真的 ${ext.slice(1)} 图片`);
  return { ext, mime: type.mime };
}

async function checkImage(dir, field, name) {
  let real;
  try {
    real = await realpath(join(dir, name));
  } catch {
    fail(`找不到 ${field} 文件 ${name}`);
  }
  if (!real.startsWith((await realpath(dir)) + sep)) fail(`${field} 文件必须真实位于主题文件夹里`);

  const file = await open(real, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile()) fail(`${name} 不是文件`);
    const head = Buffer.alloc(12);
    await file.read(head, 0, 12, 0);
    checkImageBytes(name, stats.size, head, IMAGE_LIMITS[field]);
  } finally {
    await file.close();
  }
  return real;
}

async function loadTheme(root, folder) {
  if (!ID_PATTERN.test(folder)) fail('文件夹名只能用小写字母、数字和连字符');
  const dir = join(root, folder);
  let text;
  try {
    text = await readFile(join(dir, 'theme.json'), 'utf8');
  } catch {
    fail('缺少 theme.json');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('theme.json 不是合法 JSON');
  }
  const theme = parseThemeJson(folder, raw);
  return {
    ...theme,
    dir,
    wallpaperPath: await checkImage(dir, 'wallpaper', theme.wallpaper),
    thumbPath: theme.thumb === null ? null : await checkImage(dir, 'thumb', theme.thumb),
  };
}

export async function loadThemes(root = THEMES_DIR) {
  const entries = await readdir(root, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const themes = [];
  const broken = [];
  for (const folder of folders) {
    try {
      themes.push(await loadTheme(root, folder));
    } catch (error) {
      broken.push({ id: folder, reason: error.message });
    }
  }
  return { themes, broken };
}

const dataUrl = async (mime, path) => `data:${mime};base64,${(await readFile(path)).toString('base64')}`;

export const wallpaperDataUrl = (theme) => dataUrl(theme.mime, theme.wallpaperPath);

export const thumbDataUrl = async (theme) => (theme.thumbPath === null ? null : dataUrl(theme.thumbMime, theme.thumbPath));
