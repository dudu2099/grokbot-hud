import { createHash } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { EXIT, UserError } from './errors.mjs';

// "always on": the user's own Grok Bot shortcuts (Start menu, desktop, taskbar) are changed to open it with the
// wallpaper, and "always off" puts every one of them back. The rule everything here follows: no shortcut is touched
// before its original is safely in the backup, and the backup is only deleted once every shortcut is back.
//
// A shortcut's state is its seven fields (see FIELDS). The backup also keeps the original .lnk file byte for byte, so
// putting one back writes those bytes and checks the file hash, rather than re-saving the fields.

export const FIELDS = Object.freeze(['TargetPath', 'Arguments', 'WorkingDirectory', 'IconLocation', 'Description', 'WindowStyle', 'Hotkey']);
// Our own extra icon targets conhost, so it never matches the exe anyway; its name is ruled out as well, to be sure.
const OWN_LAUNCHER = 'grok bot（带壁纸）.lnk';

const lower = (text) => String(text ?? '').toLowerCase();
export const samePath = (a, b) => lower(a) === lower(b);

// Windows paths compare without case; everything else must match exactly.
const sameField = (field, a, b) => (field === 'TargetPath' ? samePath(a[field], b[field]) : String(a[field] ?? '') === String(b[field] ?? ''));
export const sameFields = (a, b) => Boolean(a && b) && FIELDS.every((field) => sameField(field, a, b));
const differentFields = (a, b) => FIELDS.filter((field) => !a || !b || !sameField(field, a, b));

export function insideDirs(path, dirs) {
  const target = lower(path);
  return dirs.some((dir) => target.startsWith(`${lower(dir).replace(/[\\/]+$/, '')}\\`));
}

const baseName = (path) => lower(path.split(/[\\/]/).at(-1));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The real file effects; tests hand in their own.
export const FILES = {
  readBytes: (path) => readFile(path),
  // Same folder, then rename over the shortcut, so a crash leaves either the old file or the new one, never half.
  async writeBytes(path, bytes) {
    const tmp = `${path}.${process.pid}.${Date.now()}.restore-tmp`;
    await writeFile(tmp, bytes);
    try {
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  },
};

export const describeFields = (fields) =>
  FIELDS.map((field) => `      ${field}: ${fields?.[field] === '' || fields?.[field] === undefined ? '（空）' : fields[field]}`).join('\n');

// Puts the original bytes back and checks the hash. Returns null when it worked, otherwise the reason.
async function putBack(files, entry) {
  try {
    await files.writeBytes(entry.path, Buffer.from(entry.originalBytes, 'base64'));
    const now = sha256(await files.readBytes(entry.path));
    return now === entry.originalSha256 ? null : `写回之后文件哈希是 ${now}，不是原来的 ${entry.originalSha256}`;
  } catch (error) {
    return `写回失败：${error.message}`;
  }
}

// deps:
//   exe:      Grok Bot's exe; only shortcuts whose target is exactly this (any case) count as the user's own
//   scan:     async () => { dirs, links: [{ path, fields }] }   every .lnk in the searched folders
//   plan:     (original fields) => { fields } | { refuse: reason }   what the shortcut becomes (platform specific)
//   write:    async (path, fields) => fields read back fresh from the file
//   store:    { readAlwaysBackup, writeAlwaysBackup, removeAlwaysBackup }   (writeAlwaysBackup reads back and throws on any mismatch)
//   files:    { readBytes, writeBytes }   defaults to FILES;  now: () => Date
// Resolves to { code, report }.
export async function turnOn(deps) {
  const { exe, store } = deps;
  const files = deps.files ?? FILES;
  const now = deps.now ?? (() => new Date());
  const backup = await store.readAlwaysBackup();
  const entries = backup?.entries ?? [];
  const { dirs, links } = await deps.scan();
  const byPath = new Map(entries.map((entry) => [lower(entry.path), entry]));
  const report = { exe, dirs, changed: [], already: [], skipped: [], failed: [] };

  const work = [];
  for (const link of links) {
    if (baseName(link.path) === OWN_LAUNCHER) continue;
    const entry = byPath.get(lower(link.path));
    if (entry) {
      if (sameFields(link.fields, entry.applied)) report.already.push(link.path);
      else if (sameFields(link.fields, entry.original)) work.push({ path: link.path, entry });
      else if (samePath(link.fields.TargetPath, exe))
        report.skipped.push({ path: link.path, reason: '备份里记着它的原样，但它现在和原样、和改过的样子都不一样（可能被官方更新重写过），没有动它' });
      continue;
    }
    if (samePath(link.fields.TargetPath, exe)) work.push({ path: link.path, original: link.fields });
  }

  if (work.length === 0 && report.already.length === 0) {
    const why = report.skipped.map((s) => `\n  ${s.path}：${s.reason}`).join('');
    throw new UserError(
      `在这几个位置没有找到指向 Grok Bot（${exe}）的快捷方式，什么都没有改：\n${dirs.map((dir) => `  ${dir}`).join('\n')}${why}`,
    );
  }

  // Plan everything first; a shortcut that cannot be changed safely is left as it is.
  const planned = [];
  for (const item of work) {
    let entry = item.entry;
    if (!entry) {
      const bytes = await files.readBytes(item.path);
      entry = { path: item.path, original: item.original, originalSha256: sha256(bytes), originalBytes: bytes.toString('base64') };
    }
    const plan = deps.plan(entry.original);
    if (plan.refuse) {
      report.skipped.push({ path: item.path, reason: `没改：${plan.refuse}` });
      continue;
    }
    planned.push({ ...entry, applied: plan.fields, savedAt: entry.savedAt ?? now().toISOString() });
  }
  if (planned.length === 0) return { code: report.skipped.length && !report.already.length ? EXIT.error : EXIT.ok, report };

  // The backup goes first. If it cannot be written and read back, nothing is touched.
  const merged = new Map(entries.map((entry) => [lower(entry.path), entry]));
  for (const entry of planned) merged.set(lower(entry.path), entry);
  const next = { version: 1, entries: [...merged.values()] };
  try {
    await store.writeAlwaysBackup(next);
  } catch (error) {
    throw new UserError(`图标的备份没写成功（${error.message}），所以一个图标都没有改。`);
  }

  const dropped = new Set();
  for (const entry of planned) {
    let back = null;
    let reason = null;
    try {
      back = await deps.write(entry.path, entry.applied);
    } catch (error) {
      reason = `写入失败：${error.message}`;
    }
    if (!reason && sameFields(back, entry.applied)) {
      report.changed.push(entry.path);
      continue;
    }
    if (!reason) {
      const off = differentFields(back, entry.applied);
      reason = `写完读回来对不上（${off.join('、')}${off.includes('Arguments') ? '，参数可能被截断了' : ''}）`;
    }
    const putBackError = await putBack(files, entry);
    if (putBackError === null) {
      // Back to the original byte for byte, so its backup entry is no longer needed (unless it was there before).
      if (!byPath.has(lower(entry.path))) dropped.add(lower(entry.path));
      report.failed.push({ path: entry.path, reason, restored: true });
    } else {
      report.failed.push({ path: entry.path, reason: `${reason}；${putBackError}`, restored: false, original: entry.original });
    }
  }

  if (dropped.size) {
    const kept = next.entries.filter((entry) => !dropped.has(lower(entry.path)));
    try {
      if (kept.length) await store.writeAlwaysBackup({ version: 1, entries: kept });
      else await store.removeAlwaysBackup();
    } catch {
      // Harmless: those shortcuts are already back to the original, and off treats "same as the original" as done.
    }
  }
  return { code: report.failed.length ? EXIT.error : EXIT.ok, report };
}

// deps: dirs: async () => dirs;  read: async (paths) => [{ path, exists, fields }];  store;  files
export async function turnOff(deps) {
  const { store } = deps;
  const files = deps.files ?? FILES;
  const backup = await store.readAlwaysBackup();
  const report = { wasOn: backup !== null, restored: [], alreadyOriginal: [], missing: [], changedByOthers: [], failed: [] };
  if (!backup) return { code: EXIT.ok, report };
  // Said first, before any shortcut is touched: from here on the helper must not put a shortcut back on, even if this
  // run stops half way or leaves entries behind.
  if (!backup.off) await store.writeAlwaysBackup({ version: 1, off: true, entries: backup.entries });

  const dirs = await deps.dirs();
  const inside = backup.entries.filter((entry) => insideDirs(entry.path, dirs));
  const current = new Map((await deps.read(inside.map((entry) => entry.path))).map((row) => [lower(row.path), row]));

  for (const entry of backup.entries) {
    if (!insideDirs(entry.path, dirs)) {
      report.failed.push({ path: entry.path, reason: '它不在现在找图标的几个目录里（目录可能挪过），没有去碰它', original: entry.original });
      continue;
    }
    const row = current.get(lower(entry.path));
    if (!row?.exists) {
      report.missing.push(entry.path);
    } else if (sameFields(row.fields, entry.applied)) {
      const error = await putBack(files, entry);
      if (error === null) report.restored.push(entry.path);
      else report.failed.push({ path: entry.path, reason: error, original: entry.original });
    } else if (sameFields(row.fields, entry.original)) {
      report.alreadyOriginal.push(entry.path);
    } else {
      report.changedByOthers.push({ path: entry.path, now: row.fields, original: entry.original });
    }
  }

  // A failure keeps the whole backup. A shortcut someone else changed keeps its own entry, since the backup is then the
  // only record of how it looked; the switch is not fully off, so that is a non-zero exit too.
  if (report.failed.length) return { code: EXIT.error, report };
  if (report.changedByOthers.length) {
    const kept = backup.entries.filter((entry) => report.changedByOthers.some((c) => samePath(c.path, entry.path)));
    await store.writeAlwaysBackup({ version: 1, off: true, entries: kept });
    report.keptInBackup = kept.map((entry) => entry.path);
    return { code: EXIT.error, report };
  }
  await store.removeAlwaysBackup();
  return { code: EXIT.ok, report };
}

// For status: is the switch on, and how many shortcuts are in the changed state right now.
export async function alwaysStatus({ store, dirs, read }) {
  const backup = await store.readAlwaysBackup();
  if (!backup) return { on: false, shortcuts: 0, modified: 0 };
  if (backup.off) return { on: false, shortcuts: backup.entries.length, modified: 0, leftover: true };
  const inside = backup.entries.filter((entry) => insideDirs(entry.path, dirs));
  const rows = await read(inside.map((entry) => entry.path));
  const modified = rows.filter((row) => {
    const entry = inside.find((candidate) => samePath(candidate.path, row.path));
    return row.exists && sameFields(row.fields, entry?.applied);
  }).length;
  return { on: true, shortcuts: backup.entries.length, modified };
}

// Grok Bot rewrites its own Start menu shortcut every time it starts (measured: three seconds after launch, same seven
// fields as the original). While the switch is on, that shortcut is put back to the changed state. Only a shortcut that
// is already in the backup and reads exactly like its original is touched: one that looks like anything else was
// changed by someone, and is left alone. After always off nothing is touched.
// deps: store; dirs: async () => dirs; read: async (paths) => rows; write: async (path, fields) => fields read back; files
export async function keepOn(deps) {
  const { store } = deps;
  const files = deps.files ?? FILES;
  const backup = await store.readAlwaysBackup();
  const report = { on: Boolean(backup) && !backup.off, reapplied: [], failed: [] };
  if (!report.on) return report;
  const dirs = await deps.dirs();
  const inside = backup.entries.filter((entry) => insideDirs(entry.path, dirs));
  for (const row of await deps.read(inside.map((entry) => entry.path))) {
    const entry = inside.find((candidate) => samePath(candidate.path, row.path));
    if (!entry || !row.exists || !sameFields(row.fields, entry.original)) continue;
    let reason = null;
    try {
      const back = await deps.write(entry.path, entry.applied);
      if (!sameFields(back, entry.applied)) reason = `写完读回来对不上（${differentFields(back, entry.applied).join('、')}）`;
    } catch (error) {
      reason = `写入失败：${error.message}`;
    }
    if (reason === null) report.reapplied.push(entry.path);
    else report.failed.push({ path: entry.path, reason, restored: (await putBack(files, entry)) === null });
  }
  return report;
}

const mtimeOf = async (path) => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};

// If something keeps undoing the change, stop after this many rewrites in one run instead of fighting over the file.
export const KEEP_LIMIT = 5;

// The resident side of keepOn, looked at on every watch tick. Reading shortcuts costs a PowerShell start, so that only
// happens when the backup file or one of its shortcuts has a new modification time.
export function createAlwaysKeeper({ store, dirs, read, write, log, files = FILES, mtime = mtimeOf, limit = KEEP_LIMIT }) {
  let seen;
  let running = false;
  let rewrites = 0;
  let stopped = false;
  let lastError = null;
  let known = { at: undefined, paths: [] };

  async function signature() {
    const at = await mtime(store.alwaysBackupFile);
    if (at === null) return null;
    if (at !== known.at) known = { at, paths: ((await store.readAlwaysBackup())?.entries ?? []).map((entry) => entry.path) };
    return JSON.stringify([at, ...(await Promise.all(known.paths.map(mtime)))]);
  }

  return {
    async check() {
      if (running || stopped) return;
      running = true;
      try {
        const now = await signature();
        if (now === seen) return;
        if (now !== null) {
          const report = await keepOn({ store, dirs, read, write, files });
          for (const path of report.reapplied) log(`图标被写回了原样（Grok Bot 启动时会重写自己的开始菜单图标），已经重新改成带壁纸打开：${path}`);
          for (const failed of report.failed) log(`图标没能重新改成带壁纸打开：${failed.path}：${failed.reason}。${failed.restored ? '已恢复成原样。' : '也没能恢复成原样，备份还在。'}`);
          rewrites += report.reapplied.length + report.failed.length;
          if (rewrites >= limit) {
            stopped = true;
            log(`这一次运行里图标已经被改回去 ${rewrites} 次，像是有别的程序一直在改它，不再跟它抢。下次打开时再看。`);
          }
        }
        seen = await signature();
        lastError = null;
      } catch (error) {
        if (lastError !== error.message) log(`检查原有图标时出错：${error.message}`);
        lastError = error.message;
      } finally {
        running = false;
      }
    },
  };
}
