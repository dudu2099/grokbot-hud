import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ENTRY = join(ROOT, 'scripts', 'grokbot-wallpaper.mjs');
export const CLOSED_PORT = '19399';
export const CLOSED_PANEL_PORT = '19398';
export const PACKS_DIR = join(ROOT, 'test', 'fixtures', 'packs');
const NO_STARTUP_DIR = join(tmpdir(), 'gbt-test-startup-never-created');
export const NO_DESKTOP_DIR = join(tmpdir(), 'gbt-test-desktop-never-created');
// Where always on looks for the user's Grok Bot shortcuts: never the real Start menu, desktop or taskbar.
export const NO_SHORTCUT_DIR = join(tmpdir(), 'gbt-test-shortcuts-never-created');
// Safety net: even a bug that reached the relaunch path could not find, close or start the real Grok Bot.
const NO_APP = join(tmpdir(), 'gbt-test-no-such-app', 'Grok Bot.exe');

const created = [];
process.once('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

export async function tempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `gbt-${label}-`));
  created.push(dir);
  return dir;
}

// Runs the real entry script. nodeArgs go before it, e.g. a preload that takes a global away.
export function runCli(args, env = {}, nodeArgs = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...nodeArgs, ENTRY, ...args],
      {
        env: {
          ...process.env,
          GROKBOT_DEBUG_PORT: CLOSED_PORT,
          GROKBOT_PANEL_PORT: CLOSED_PANEL_PORT,
          GROKBOT_THEMES_DIR: PACKS_DIR,
          GROKBOT_STARTUP_DIR: NO_STARTUP_DIR,
          // Never the real desktop, and never a real dialog box.
          GROKBOT_DESKTOP_DIR: NO_DESKTOP_DIR,
          GROKBOT_SHORTCUT_DIRS: NO_SHORTCUT_DIR,
          GROKBOT_NO_DIALOG: '1',
          GROKBOT_ALLOW_STANDIN: '1',
          GROKBOT_APP_PATH: NO_APP,
          ...env,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}
