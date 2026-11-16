// always on / off: the orchestration with an in-memory set of shortcuts, the shortcut that Windows gets, the backup
// file, and the command through the real entry script. Nothing here reads or writes a real shortcut.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { alwaysStatus, createAlwaysKeeper, FIELDS, keepOn, sameFields, sha256, turnOff, turnOn } from '../src/always.mjs';
import { EXIT, UserError } from '../src/errors.mjs';
import { alwaysOnShortcut, shortcutAppTargets } from '../src/platform/win32.mjs';
import { openStore } from '../src/store.mjs';
import { NO_SHORTCUT_DIR, runCli, tempDir } from './helpers.mjs';

const EXE = 'D:\\Apps\\Grok Bot\\Grok Bot.exe';
const START = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
const DESKTOP = 'E:\\OneDrive\\桌面';
const TASKBAR = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar';
const DIRS = [START, DESKTOP, TASKBAR];

const link = (over = {}) => ({
  TargetPath: EXE,
  Arguments: '',
  WorkingDirectory: 'D:\\Apps\\Grok Bot',
  IconLocation: ',0',
  Description: 'Grok Bot',
  WindowStyle: 1,
  Hotkey: '',
  ...over,
});

// A fake disk: each shortcut is its bytes, and its fields are what the bytes say (so writing the bytes back restores them).
function fakeDisk(initial) {
  const files = new Map(Object.entries(initial).map(([path, fields]) => [path, Buffer.from(JSON.stringify(fields))]));
  let saves = 0;
  const fieldsOf = (path) => JSON.parse(files.get(path).toString().split('#')[0]);
  return {
    files,
    fieldsOf,
    scan: async () => ({ dirs: DIRS, links: [...files.keys()].map((path) => ({ path, fields: fieldsOf(path) })) }),
    read: async (paths) => paths.map((path) => (files.has(path) ? { path, exists: true, fields: fieldsOf(path) } : { path, exists: false, fields: null })),
    // Saving through the shell rewrites unrelated bytes too, which a byte-for-byte restore must undo.
    write: async (path, fields) => {
      saves += 1;
      files.set(path, Buffer.from(`${JSON.stringify(fields)}#saved-${saves}`));
      return fieldsOf(path);
    },
    io: {
      readBytes: async (path) => {
        if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files.get(path);
      },
      writeBytes: async (path, bytes) => files.set(path, Buffer.from(bytes)),
    },
    get saves() {
      return saves;
    },
  };
}

function fakeStore({ failWrite = false } = {}) {
  let saved = null;
  return {
    get saved() {
      return saved;
    },
    readAlwaysBackup: async () => (saved ? structuredClone(saved) : null),
    writeAlwaysBackup: async (value) => {
      if (failWrite) throw new Error('磁盘满了');
      saved = structuredClone(value);
    },
    removeAlwaysBackup: async () => {
      saved = null;
    },
  };
}

// What a changed shortcut looks like in these tests: anything recognisably different from the original.
const plan = (original) => ({ fields: { ...original, TargetPath: 'C:\\Windows\\System32\\conhost.exe', Arguments: `--headless … start "" "${original.TargetPath}"` } });

const on = (disk, store, over = {}) => turnOn({ exe: EXE, store, scan: disk.scan, plan, write: disk.write, files: disk.io, now: () => new Date('2026-11-15T00:00:00Z'), ...over });
const off = (disk, store) => turnOff({ store, dirs: async () => DIRS, read: disk.read, files: disk.io });

test('only shortcuts whose target is exactly the Grok Bot exe count, in any case and in subfolders', async () => {
  const disk = fakeDisk({
    [`${START}\\Grok Bot.lnk`]: link(),
    [`${START}\\工具 (测试) & 其他\\Grok Bot.lnk`]: link({ TargetPath: EXE.toUpperCase() }),
    [`${DESKTOP}\\Grok Bot.lnk`]: link({ Arguments: '--lang=zh' }),
    [`${DESKTOP}\\记事本.lnk`]: link({ TargetPath: 'C:\\Windows\\notepad.exe' }),
    [`${DESKTOP}\\Grok Bot（带壁纸）.lnk`]: link({ TargetPath: 'C:\\Windows\\System32\\conhost.exe', Arguments: '--headless x launch' }),
    // Named like ours but pointing at the exe would count; ours by name is ruled out on purpose.
    [`${TASKBAR}\\Grok Bot（带壁纸）.lnk`]: link(),
  });
  const store = fakeStore();
  const { code, report } = await on(disk, store);
  assert.equal(code, EXIT.ok);
  assert.deepEqual(report.changed.sort(), [`${START}\\Grok Bot.lnk`, `${START}\\工具 (测试) & 其他\\Grok Bot.lnk`, `${DESKTOP}\\Grok Bot.lnk`].sort());
  assert.equal(disk.fieldsOf(`${DESKTOP}\\记事本.lnk`).TargetPath, 'C:\\Windows\\notepad.exe');
  assert.equal(disk.fieldsOf(`${TASKBAR}\\Grok Bot（带壁纸）.lnk`).TargetPath, EXE);
  assert.equal(store.saved.entries.length, 3);
});

test('a shortcut already in the changed state is not taken for an original', async () => {
  const disk = fakeDisk({ [`${DESKTOP}\\Grok Bot.lnk`]: link() });
  const store = fakeStore();
  await on(disk, store);
  const second = await on(disk, store);
  assert.deepEqual(second.report.changed, []);
  assert.deepEqual(second.report.already, [`${DESKTOP}\\Grok Bot.lnk`]);
});

test('no Grok Bot shortcut anywhere: a UserError, nothing written, no backup', async () => {
  const disk = fakeDisk({ [`${DESKTOP}\\记事本.lnk`]: link({ TargetPath: 'C:\\Windows\\notepad.exe' }) });
  const store = fakeStore();
  await assert.rejects(on(disk, store), (error) => error instanceof UserError && /没有找到指向 Grok Bot/.test(error.message));
  assert.equal(disk.saves, 0);
  assert.equal(store.saved, null);
});

test('when the backup cannot be written, no shortcut is touched', async () => {
  const disk = fakeDisk({ [`${DESKTOP}\\Grok Bot.lnk`]: link(), [`${START}\\Grok Bot.lnk`]: link() });
  const before = new Map(disk.files);
  const store = fakeStore({ failWrite: true });
  await assert.rejects(on(disk, store), (error) => error instanceof UserError && /备份没写成功.*一个图标都没有改/.test(error.message));
  assert.equal(disk.saves, 0);
  for (const [path, bytes] of before) assert.ok(disk.files.get(path).equals(bytes), path);
});

test('on twice: the backup still holds the very first original, bytes and all', async () => {
  const path = `${DESKTOP}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [path]: link({ Arguments: '--profile=work' }) });
  const firstBytes = Buffer.from(disk.files.get(path));
  const store = fakeStore();
  await on(disk, store);
  const after1 = structuredClone(store.saved);
  await on(disk, store);
  assert.deepEqual(store.saved, after1, 'the second on did not rewrite the backup');
  const [entry] = store.saved.entries;
  assert.ok(sameFields(entry.original, link({ Arguments: '--profile=work' })));
  assert.equal(entry.originalSha256, sha256(firstBytes));
  assert.ok(Buffer.from(entry.originalBytes, 'base64').equals(firstBytes));
});

test('on again picks up a new original shortcut and keeps the old entries', async () => {
  const disk = fakeDisk({ [`${DESKTOP}\\Grok Bot.lnk`]: link() });
  const store = fakeStore();
  await on(disk, store);
  const firstEntry = structuredClone(store.saved.entries[0]);
  disk.files.set(`${TASKBAR}\\Grok Bot.lnk`, Buffer.from(JSON.stringify(link())));
  const { report } = await on(disk, store);
  assert.deepEqual(report.changed, [`${TASKBAR}\\Grok Bot.lnk`]);
  assert.deepEqual(report.already, [`${DESKTOP}\\Grok Bot.lnk`]);
  assert.deepEqual(store.saved.entries[0], firstEntry);
  assert.equal(store.saved.entries.length, 2);
});

test('a shortcut that does not read back as written (cut-off arguments) is put back byte for byte and reported', async () => {
  const good = `${DESKTOP}\\Grok Bot.lnk`;
  const bad = `${START}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [good]: link(), [bad]: link({ Description: '开始菜单里的' }) });
  const badBytes = Buffer.from(disk.files.get(bad));
  const store = fakeStore();
  const write = async (path, fields) => {
    const back = await disk.write(path, fields);
    return path === bad ? { ...back, Arguments: back.Arguments.slice(0, 20) } : back;
  };
  const { code, report } = await on(disk, store, { write });
  assert.equal(code, EXIT.error);
  assert.deepEqual(report.changed, [good]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].restored, true);
  assert.match(report.failed[0].reason, /Arguments，参数可能被截断了/);
  assert.ok(disk.files.get(bad).equals(badBytes), 'the failed one is back to its original bytes');
  assert.deepEqual(store.saved.entries.map((entry) => entry.path), [good], 'its backup entry was dropped once it was back');
});

test('a shortcut the platform refuses to change (unsafe characters) is left alone and said', async () => {
  const disk = fakeDisk({ [`${DESKTOP}\\Grok Bot.lnk`]: link({ Arguments: '--x="a b"' }) });
  const store = fakeStore();
  const { code, report } = await on(disk, store, { plan: alwaysOnShortcut });
  assert.equal(code, EXIT.error);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /引号/);
  assert.equal(disk.saves, 0);
  assert.equal(store.saved, null);
});

test('off: ours goes back byte for byte, a missing file is skipped, one changed by someone else is left, reported and kept in the backup', async () => {
  const ours = `${START}\\Grok Bot.lnk`;
  const gone = `${DESKTOP}\\Grok Bot.lnk`;
  const touched = `${TASKBAR}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [ours]: link(), [gone]: link(), [touched]: link() });
  const originals = new Map([...disk.files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const store = fakeStore();
  await on(disk, store);
  disk.files.delete(gone);
  const othersVersion = Buffer.from(JSON.stringify(link({ TargetPath: 'D:\\New\\Grok Bot.exe' })));
  disk.files.set(touched, othersVersion);

  const { code, report } = await off(disk, store);
  assert.equal(code, EXIT.error, 'not fully off');
  assert.deepEqual(report.restored, [ours]);
  assert.deepEqual(report.missing, [gone]);
  assert.deepEqual(report.changedByOthers.map((c) => c.path), [touched]);
  assert.ok(disk.files.get(ours).equals(originals.get(ours)));
  assert.ok(disk.files.get(touched).equals(othersVersion), 'the one changed by someone else was not touched');
  assert.ok(!disk.files.has(gone));
  assert.deepEqual(store.saved.entries.map((entry) => entry.path), [touched], 'only its original is kept');
  assert.equal(store.saved.entries[0].original.TargetPath, EXE);
  // Once that one is dealt with by hand (here: put back to the original), off finishes and the backup goes.
  disk.files.set(touched, Buffer.from(JSON.stringify(link())));
  const again = await off(disk, store);
  assert.equal(again.code, EXIT.ok);
  assert.deepEqual(again.report.alreadyOriginal, [touched]);
  assert.equal(store.saved, null);
});

test('off: everything back, so the backup is gone', async () => {
  const disk = fakeDisk({ [`${START}\\Grok Bot.lnk`]: link(), [`${DESKTOP}\\Grok Bot.lnk`]: link() });
  const originals = new Map([...disk.files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const store = fakeStore();
  await on(disk, store);
  const { code, report } = await off(disk, store);
  assert.equal(code, EXIT.ok);
  assert.equal(report.restored.length, 2);
  for (const [path, bytes] of originals) assert.ok(disk.files.get(path).equals(bytes), path);
  assert.equal(store.saved, null);
});

test('off: a shortcut that cannot be put back keeps the backup and fails with its original', async () => {
  const ok = `${START}\\Grok Bot.lnk`;
  const stuck = `${DESKTOP}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [ok]: link(), [stuck]: link({ Description: '桌面上的' }) });
  const store = fakeStore();
  await on(disk, store);
  const backup = structuredClone(store.saved);
  const writeBytes = disk.io.writeBytes;
  disk.io.writeBytes = async (path, bytes) => {
    if (path === stuck) throw new Error('拒绝访问');
    return writeBytes(path, bytes);
  };
  const { code, report } = await off(disk, store);
  assert.equal(code, EXIT.error);
  assert.deepEqual(report.restored, [ok]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].path, stuck);
  assert.match(report.failed[0].reason, /拒绝访问/);
  assert.equal(report.failed[0].original.Description, '桌面上的');
  assert.deepEqual(store.saved, { ...backup, off: true }, 'the backup keeps every entry, marked as switched off');
});

test('off: a backup entry outside the folders searched now is not touched and keeps the backup', async () => {
  const path = `${DESKTOP}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [path]: link() });
  const store = fakeStore();
  await on(disk, store);
  const { code, report } = await turnOff({ store, dirs: async () => [START], read: disk.read, files: disk.io });
  assert.equal(code, EXIT.error);
  assert.match(report.failed[0].reason, /不在现在找图标的几个目录里/);
  assert.notEqual(store.saved, null);
});

test('off: an entry whose shortcut is still the original (a run that stopped half way) counts as done', async () => {
  const path = `${DESKTOP}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [path]: link() });
  const store = fakeStore();
  // The backup was written, then the run stopped before the shortcut was changed.
  const bytes = await disk.io.readBytes(path);
  await store.writeAlwaysBackup({ version: 1, entries: [{ path, original: link(), applied: plan(link()).fields, originalSha256: sha256(bytes), originalBytes: bytes.toString('base64'), savedAt: 'x' }] });
  const { code, report } = await off(disk, store);
  assert.equal(code, EXIT.ok);
  assert.deepEqual(report.alreadyOriginal, [path]);
  assert.equal(store.saved, null);
});

test('off with no backup is a success that changes nothing', async () => {
  const disk = fakeDisk({ [`${DESKTOP}\\Grok Bot.lnk`]: link() });
  const { code, report } = await off(disk, fakeStore());
  assert.equal(code, EXIT.ok);
  assert.equal(report.wasOn, false);
  assert.equal(disk.saves, 0);
});

// ---- the app rewrites its own shortcut; the helper changes it again ----

const keep = (disk, store) => keepOn({ store, dirs: async () => DIRS, read: disk.read, write: disk.write, files: disk.io });
const NOTHING = { on: false, reapplied: [], failed: [] };

test('keep: a shortcut the app wrote back to its original is changed again; one changed to something else is left alone', async () => {
  const rewritten = `${START}\\Grok Bot.lnk`;
  const fine = `${DESKTOP}\\Grok Bot.lnk`;
  const others = `${TASKBAR}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [rewritten]: link(), [fine]: link({ Description: '桌面上的' }), [others]: link() });
  const store = fakeStore();
  await on(disk, store);
  const backup = structuredClone(store.saved);
  const applied = disk.fieldsOf(rewritten);
  // The app saves the same fields again; the bytes are not the ones in the backup.
  disk.files.set(rewritten, Buffer.from(`${JSON.stringify(link())}#rewritten-by-the-app`));
  const othersVersion = Buffer.from(JSON.stringify(link({ TargetPath: 'D:\\New\\Grok Bot.exe' })));
  disk.files.set(others, othersVersion);
  const savesBefore = disk.saves;

  assert.deepEqual(await keep(disk, store), { on: true, reapplied: [rewritten], failed: [] });
  assert.ok(sameFields(disk.fieldsOf(rewritten), applied), 'back in the changed state');
  assert.equal(disk.saves, savesBefore + 1, 'only that one shortcut was written');
  assert.ok(disk.files.get(others).equals(othersVersion), 'the one changed by someone else was not touched');
  assert.deepEqual(store.saved, backup, 'the backup still holds the very first originals');
  assert.deepEqual(await keep(disk, store), { on: true, reapplied: [], failed: [] }, 'a second look changes nothing');
});

test('keep: nothing is touched without a backup, and nothing after always off left an entry behind', async () => {
  const touched = `${TASKBAR}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [`${START}\\Grok Bot.lnk`]: link(), [touched]: link() });
  const store = fakeStore();
  assert.deepEqual(await keep(disk, store), NOTHING);
  await on(disk, store);
  disk.files.set(touched, Buffer.from(JSON.stringify(link({ TargetPath: 'D:\\New\\Grok Bot.exe' }))));
  assert.equal((await off(disk, store)).code, EXIT.error, 'one entry stays behind');
  assert.equal(store.saved.off, true);
  // Later that shortcut reads like the original again (the app rewrote it). The user said off: it stays as it is.
  disk.files.set(touched, Buffer.from(JSON.stringify(link())));
  const saves = disk.saves;
  assert.deepEqual(await keep(disk, store), NOTHING);
  assert.equal(disk.saves, saves);
  assert.deepEqual(await alwaysStatus({ store, dirs: DIRS, read: disk.read }), { on: false, shortcuts: 1, modified: 0, leftover: true });
  // always on again switches it back on.
  assert.equal((await on(disk, store)).code, EXIT.ok);
  assert.equal(store.saved.off, undefined);
  assert.equal((await keep(disk, store)).on, true);
});

test('keep: an off that stopped half way still counts as off', async () => {
  const stuck = `${DESKTOP}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [`${START}\\Grok Bot.lnk`]: link(), [stuck]: link() });
  const store = fakeStore();
  await on(disk, store);
  const writeBytes = disk.io.writeBytes;
  disk.io.writeBytes = async (path, bytes) => {
    if (path === stuck) throw new Error('拒绝访问');
    return writeBytes(path, bytes);
  };
  assert.equal((await off(disk, store)).code, EXIT.error);
  const saves = disk.saves;
  assert.deepEqual(await keep(disk, store), NOTHING, 'the restored one is not changed back');
  assert.equal(disk.saves, saves);
});

test('keep: a write that does not read back right puts the original bytes back and says so', async () => {
  const path = `${START}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [path]: link() });
  const store = fakeStore();
  await on(disk, store);
  const original = Buffer.from(store.saved.entries[0].originalBytes, 'base64');
  disk.files.set(path, Buffer.from(`${JSON.stringify(link())}#rewritten-by-the-app`));
  const report = await keepOn({ store, dirs: async () => DIRS, read: disk.read, files: disk.io, write: async (_, fields) => ({ ...fields, Arguments: 'cut' }) });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, /Arguments/);
  assert.equal(report.failed[0].restored, true);
  assert.ok(disk.files.get(path).equals(original));
});

test('keeper: shortcuts are only read when a modification time changed, and it stops fighting after the limit', async () => {
  const path = `${START}\\Grok Bot.lnk`;
  const disk = fakeDisk({ [path]: link() });
  const store = Object.assign(fakeStore(), { alwaysBackupFile: 'backup.json' });
  const times = new Map();
  let reads = 0;
  const log = [];
  const keeper = createAlwaysKeeper({
    store,
    log: (line) => log.push(line),
    dirs: async () => DIRS,
    files: disk.io,
    mtime: async (file) => times.get(file) ?? null,
    read: async (paths) => (reads++, disk.read(paths)),
    write: async (file, fields) => (times.set(file, (times.get(file) ?? 0) + 1), disk.write(file, fields)),
    limit: 2,
  });
  await keeper.check();
  assert.equal(reads, 0, 'no backup file: nothing is read');
  await on(disk, store);
  times.set('backup.json', 1);
  times.set(path, 1);
  await keeper.check();
  assert.equal(reads, 1, 'first look with the switch on reads once');
  await keeper.check();
  await keeper.check();
  assert.equal(reads, 1, 'nothing changed: not read again');
  const appRewrites = () => {
    disk.files.set(path, Buffer.from(`${JSON.stringify(link())}#app`));
    times.set(path, times.get(path) + 1);
  };
  appRewrites();
  await keeper.check();
  assert.equal(reads, 2);
  assert.match(disk.fieldsOf(path).TargetPath, /conhost/);
  assert.equal(log.length, 1);
  appRewrites();
  await keeper.check();
  assert.match(log.at(-1), /不再跟它抢/);
  appRewrites();
  await keeper.check();
  assert.equal(disk.fieldsOf(path).TargetPath, EXE, 'after the limit the shortcut is left the way the other program wants it');
});

// ---- the shortcut Windows gets ----

test('the Windows shortcut keeps everything but target, arguments and (when empty) the icon, and falls back to the exe', () => {
  const original = link({ TargetPath: 'D:\\Apps (x86)\\Grok & Bot\\Grok Bot.exe', Arguments: '--lang=zh  --x', Hotkey: 'Ctrl+Alt+G', WindowStyle: 3 });
  const { fields, refuse } = alwaysOnShortcut(original);
  assert.equal(refuse, undefined);
  for (const field of ['WorkingDirectory', 'Description', 'WindowStyle', 'Hotkey']) assert.equal(fields[field], original[field], field);
  assert.match(fields.TargetPath, /\\System32\\conhost\.exe$/i);
  assert.equal(fields.IconLocation, 'D:\\Apps (x86)\\Grok & Bot\\Grok Bot.exe,0');
  assert.match(fields.Arguments, /^--headless \S*cmd\.exe \/d \/v:off \/c \( /);
  assert.ok(fields.Arguments.endsWith(' launch || start "" "D:\\Apps (x86)\\Grok & Bot\\Grok Bot.exe" --lang=zh --x )'), fields.Arguments);
  // Every quoted piece holds a space, so conhost passes it on exactly as written.
  for (const quoted of fields.Arguments.match(/"[^"]*"/g)) assert.ok(quoted === '""' || /\s/.test(quoted), quoted);
});

test('an icon location that is set is kept as it is', () => {
  const { fields } = alwaysOnShortcut(link({ IconLocation: 'D:\\Apps\\Grok Bot\\app.ico,2' }));
  assert.equal(fields.IconLocation, 'D:\\Apps\\Grok Bot\\app.ico,2');
});

test('characters that cmd or conhost would rewrite are refused instead of guessed at', () => {
  assert.match(alwaysOnShortcut(link({ TargetPath: 'D:\\100%\\Grok Bot.exe' })).refuse, /%/);
  assert.match(alwaysOnShortcut(link({ TargetPath: 'D:\\a&b\\GrokBot.exe' })).refuse, /没有空格/);
  assert.match(alwaysOnShortcut(link({ Arguments: '--a & calc' })).refuse, /引号或 & \( \) %/);
  assert.match(alwaysOnShortcut(link({ Arguments: '"--quoted"' })).refuse, /引号/);
  assert.equal(alwaysOnShortcut(link({ TargetPath: 'D:\\a(b)\\Grok Bot.exe' })).refuse, undefined, 'with a space the path is quoted, so ( ) are fine');
});

test('finding the app still works through a Start menu shortcut that always on changed', () => {
  const spaced = alwaysOnShortcut(link()).fields;
  const bare = alwaysOnShortcut(link({ TargetPath: 'D:\\GrokBot\\GrokBot.exe' })).fields;
  const launcher = { target: 'C:\\Windows\\System32\\conhost.exe', args: '--headless "node" "entry" launch' };
  assert.deepEqual(
    shortcutAppTargets([{ target: spaced.TargetPath, args: spaced.Arguments }, { target: bare.TargetPath, args: bare.Arguments }, launcher, { target: EXE, args: '' }]),
    [EXE, 'D:\\GrokBot\\GrokBot.exe', EXE],
  );
});

test('every field always on reads or writes is in FIELDS', () => {
  assert.deepEqual(Object.keys(link()).sort(), [...FIELDS].sort());
});

// ---- the backup file ----

test('the backup file is written atomically, read back, and a damaged one stops everything', async () => {
  const dir = await tempDir('always-store');
  const store = openStore(dir);
  assert.equal(await store.readAlwaysBackup(), null);
  const value = { version: 1, entries: [{ path: 'C:\\x.lnk', original: link(), applied: link({ TargetPath: 'c' }), originalSha256: 'ab', originalBytes: 'AA==', savedAt: 'now' }] };
  await store.writeAlwaysBackup(value);
  assert.deepEqual(await store.readAlwaysBackup(), value);
  await assert.rejects(store.writeAlwaysBackup({ version: 1, entries: [{ path: 'x' }] }), /格式不对/);
  assert.deepEqual(await store.readAlwaysBackup(), value, 'a bad write left the old backup alone');
  await writeFile(store.alwaysBackupFile, '{"version":1,"entries":[{}]}');
  await assert.rejects(store.readAlwaysBackup(), (error) => error instanceof UserError && /不要删它/.test(error.message));
  await store.removeAlwaysBackup();
  assert.ok(!existsSync(store.alwaysBackupFile));
});

// ---- the command ----

test('always on finding no Grok Bot shortcut exits 1, says where it looked, and writes no backup', { skip: process.platform !== 'win32' }, async () => {
  const data = await tempDir('always-cli');
  const shortcuts = await tempDir('always-cli-links');
  const app = join(shortcuts, 'Grok Bot.exe');
  await writeFile(app, 'not a program');
  const { code, stderr } = await runCli(['always', 'on'], { GROKBOT_DATA_DIR: data, GROKBOT_SHORTCUT_DIRS: shortcuts, GROKBOT_APP_PATH: app });
  assert.equal(code, 1);
  assert.match(stderr, /没有找到指向 Grok Bot/);
  assert.ok(stderr.includes(shortcuts));
  assert.ok(!existsSync(join(data, 'always-on-backup.json')));
});

test('always on with no Grok Bot exe changes nothing; a bad mode is refused', async () => {
  const data = await tempDir('always-cli');
  const r = await runCli(['always', 'on'], { GROKBOT_DATA_DIR: data });
  if (process.platform === 'win32') {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /一个图标都没有改/);
  }
  assert.ok(!existsSync(join(data, 'always-on-backup.json')));
  assert.equal((await runCli(['always', 'maybe'])).code, 1);
});

test('status reports the switch as off and never looks outside the test folders', async () => {
  const { code, stdout } = await runCli(['status'], { GROKBOT_DATA_DIR: await tempDir('always-cli') });
  assert.equal(code, 0);
  const { alwaysOn } = JSON.parse(stdout);
  if (process.platform === 'win32') assert.deepEqual(alwaysOn, { supported: true, on: false, shortcuts: 0, modified: 0 });
  assert.ok(!existsSync(NO_SHORTCUT_DIR));
});

// process.platform is set to darwin before the entry script loads, so the macOS adapter is the one in use.
const AS_MAC = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'darwin' });")}`;

test('on a Mac always on and off say the feature is Windows only and exit 1, touching nothing', async () => {
  const data = await tempDir('always-mac');
  for (const mode of ['on', 'off']) {
    const { code, stderr } = await runCli(['always', mode], { GROKBOT_DATA_DIR: data }, ['--import', AS_MAC]);
    assert.equal(code, 1, mode);
    assert.match(stderr, /这个功能目前只支持 Windows/, mode);
  }
  assert.ok(!existsSync(join(data, 'always-on-backup.json')));
  const status = await runCli(['status'], { GROKBOT_DATA_DIR: data }, ['--import', AS_MAC]);
  // status itself may fail on a fake Mac (no osascript); when it prints, the switch says unsupported.
  if (status.code === 0) assert.deepEqual(JSON.parse(status.stdout).alwaysOn, { supported: false });
});
