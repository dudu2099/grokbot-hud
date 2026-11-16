import { fileURLToPath } from 'node:url';

// Autostart and the detached daemon both run this repo's own entry script with the node that is running now.
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ENTRY_SCRIPT = fileURLToPath(new URL('../../scripts/grokbot-wallpaper.mjs', import.meta.url));
