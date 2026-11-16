import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UserError } from './errors.mjs';

const LAST_APPLIED = 'last-applied.json';
const PANEL = 'panel.json';
const STRENGTH = 'strength.json';
const ALWAYS_BACKUP = 'always-on-backup.json';
const USAGE_FILE = 'usage.json';

const isFieldRecord = (raw) => raw !== null && typeof raw === 'object' && typeof raw.TargetPath === 'string' && typeof raw.Arguments === 'string';

// off: true marks what always off could not put back: a record only, the switch is off.
// { version: 1, off?: true, entries: [{ path, original, originalSha256, originalBytes (base64 of the .lnk file), applied, savedAt }] }
export function isAlwaysBackup(raw) {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    raw.version === 1 &&
    (raw.off === undefined || raw.off === true) &&
    Array.isArray(raw.entries) &&
    raw.entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        isFieldRecord(entry.original) &&
        isFieldRecord(entry.applied) &&
        typeof entry.originalSha256 === 'string' &&
        typeof entry.originalBytes === 'string' &&
        entry.originalBytes.length > 0,
    )
  );
}

export const resolveDataDir = (platform) => process.env.GROKBOT_DATA_DIR || platform.dataDir();

// The page overlay uses this token to tell "same apply again" from "a new apply", so the CLI and watch must agree on it.
export const appliedToken = (record) => `${record.themeId}@${record.appliedAt}`;

export function parsePanelState(raw) {
  const valid =
    raw !== null &&
    typeof raw === 'object' &&
    Number.isFinite(raw.x) &&
    Number.isFinite(raw.y) &&
    typeof raw.collapsed === 'boolean';
  return valid ? { x: raw.x, y: raw.y, collapsed: raw.collapsed } : null;
}

// 0 keeps the app's panels solid, 100 clears them completely. Only a value the user set is stored.
export const parseStrength = (raw) => (Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : null);

// Show usage: on unless the user switched it off. percent/readAt are the last figure read (null: none to show);
// lastError is the most recent failure, lastAttempt the most recent try of any kind.
export const DEFAULT_USAGE = Object.freeze({ enabled: true, percent: null, readAt: null, lastError: null, lastAttempt: null });
const isTime = (raw) => typeof raw === 'string' && Number.isFinite(Date.parse(raw));
const OUTCOMES = new Set(['ok', 'skipped', 'failed']);

export function parseUsageState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.enabled !== 'boolean') return null;
  const percent = Number.isInteger(raw.percent) && raw.percent >= 0 && raw.percent <= 100 && isTime(raw.readAt) ? raw.percent : null;
  const lastError =
    raw.lastError && typeof raw.lastError.reason === 'string' && isTime(raw.lastError.at) ? { reason: raw.lastError.reason, at: raw.lastError.at } : null;
  const attempt = raw.lastAttempt;
  const lastAttempt =
    attempt && OUTCOMES.has(attempt.outcome) && (attempt.reason === null || typeof attempt.reason === 'string') && isTime(attempt.at)
      ? { outcome: attempt.outcome, reason: attempt.reason, at: attempt.at }
      : null;
  return { enabled: raw.enabled, percent, readAt: percent === null ? null : raw.readAt, lastError, lastAttempt };
}
function parseLastApplied(raw, file) {
  const valid =
    raw !== null &&
    typeof raw === 'object' &&
    typeof raw.themeId === 'string' &&
    typeof raw.appliedAt === 'string' &&
    typeof raw.restored === 'boolean';
  if (!valid) throw new UserError(`状态文件格式不对：${file}。可以删掉它再试。`);
  return { themeId: raw.themeId, appliedAt: raw.appliedAt, restored: raw.restored };
}

async function readJson(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError(`状态文件不是合法 JSON：${file}。可以删掉它再试。`);
  }
}

async function writeJsonAtomic(dir, name, value) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export function openStore(dir) {
  const lastAppliedFile = join(dir, LAST_APPLIED);

  async function readLastApplied() {
    const raw = await readJson(lastAppliedFile);
    return raw === null ? null : parseLastApplied(raw, lastAppliedFile);
  }

  async function writeLastApplied(record) {
    await writeJsonAtomic(dir, LAST_APPLIED, parseLastApplied(record, lastAppliedFile));
  }

  async function markRestored() {
    const current = await readLastApplied();
    if (current === null) return null;
    const next = { ...current, restored: true };
    await writeLastApplied(next);
    return next;
  }

  // Panel position is a convenience: a damaged file falls back to the default corner instead of blocking the theme.
  async function readPanel() {
    try {
      return parsePanelState(await readJson(join(dir, PANEL)));
    } catch (error) {
      if (error instanceof UserError) return null;
      throw error;
    }
  }

  async function writePanel(record) {
    const state = parsePanelState(record);
    if (state === null) throw new Error(`面板状态格式不对：${JSON.stringify(record)}`);
    await writeJsonAtomic(dir, PANEL, state);
  }

  // Like the panel position, a damaged strength file means "never set", so the default for the theme applies.
  async function readStrength() {
    try {
      return parseStrength((await readJson(join(dir, STRENGTH)))?.strength);
    } catch (error) {
      if (error instanceof UserError) return null;
      throw error;
    }
  }

  async function writeStrength(value) {
    const strength = parseStrength(value);
    if (strength === null) throw new Error(`壁纸浓淡必须是 0 到 100 的整数：${JSON.stringify(value)}`);
    await writeJsonAtomic(dir, STRENGTH, { strength });
  }

  // A missing or damaged usage file means the defaults: switched on, nothing read yet.
  async function readUsage() {
    try {
      return parseUsageState(await readJson(join(dir, USAGE_FILE))) ?? { ...DEFAULT_USAGE };
    } catch (error) {
      if (error instanceof UserError) return { ...DEFAULT_USAGE };
      throw error;
    }
  }

  async function writeUsage(value) {
    const state = parseUsageState(value);
    if (state === null) throw new Error(`用量状态格式不对：${JSON.stringify(value)}`);
    await writeJsonAtomic(dir, USAGE_FILE, state);
    return state;
  }

  // The originals of the user's shortcuts that always on changed. Unlike the panel position, a damaged file is an
  // error that stops everything: guessing here could lose the only record of how an icon looked.
  const backupFile = join(dir, ALWAYS_BACKUP);

  async function readAlwaysBackup() {
    const raw = await readJson(backupFile);
    if (raw === null) return null;
    if (!isAlwaysBackup(raw)) {
      throw new UserError(`图标备份文件格式不对：${backupFile}。没有动任何图标。不要删它：里面记着图标原来的样子，请先打开看一下。`);
    }
    return raw;
  }

  // Written atomically and read back; anything that does not read back the same throws, and the caller must not touch an icon.
  async function writeAlwaysBackup(value) {
    if (!isAlwaysBackup(value)) throw new Error('要写的图标备份格式不对');
    await writeJsonAtomic(dir, ALWAYS_BACKUP, value);
    const back = await readJson(backupFile);
    if (JSON.stringify(back) !== JSON.stringify(value)) throw new Error(`图标备份写完读回来对不上：${backupFile}`);
  }

  async function removeAlwaysBackup() {
    await rm(backupFile, { force: true });
  }

  return {
    dir,
    readLastApplied,
    writeLastApplied,
    markRestored,
    readPanel,
    writePanel,
    readStrength,
    writeStrength,
    readUsage,
    writeUsage,
    alwaysBackupFile: backupFile,
    readAlwaysBackup,
    writeAlwaysBackup,
    removeAlwaysBackup,
  };
}
