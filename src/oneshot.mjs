import { setTimeout as sleep } from 'node:timers/promises';
import { evaluateInEveryWindow } from './cdp.mjs';
import { applyExpression, inspectExpression, restoreExpression } from './overlay.mjs';
import { PORTS } from './ports.mjs';
import { appliedToken } from './store.mjs';
import { wallpaperDataUrl } from './themes.mjs';

const BOOT_SETTLE_MS = 2500;
// A picked picture has its brightness measured in the page after it loads; the first report comes back before that.
// A large picture can take a moment to decode, so the report is re-read until the tone is known or this runs out.
const TONE_SETTLE_MS = 3000;
// Right after a relaunch the window exists before the app has drawn anything, so the first report can show no panel at all.
// Seen on a real machine: 0 panels at launch, 7 three seconds later. "No panels" is only believed after this long.
const PANELS_SETTLE_MS = 8000;
const POLL_MS = 300;

// One CDP connection per window, closed right after. The overlay stays until the page reloads; watch is what makes it stick.
export async function applyOnce(theme, store) {
  const record = { themeId: theme.id, appliedAt: new Date().toISOString(), restored: false };
  const expression = applyExpression({
    dataUrl: await wallpaperDataUrl(theme),
    opacity: theme.opacity,
    appearance: theme.appearance,
    token: appliedToken(record),
    strength: await store.readStrength(),
  });
  const results = await evaluateInEveryWindow(PORTS.debug, expression);
  if (results.some((result) => result.ok)) await store.writeLastApplied(record);
  const booting = results.some((result) => result.ok && result.value.deferred);
  const measuring = (list) => list.some((result) => result.ok && result.value.imageTone === null);
  const bare = (list) => list.some((result) => result.ok) && !list.some((result) => result.ok && result.value.panels > 0);
  if (!booting && !measuring(results) && !bare(results)) return results;

  if (booting) await sleep(BOOT_SETTLE_MS);
  let latest = results;
  for (let waited = 0; waited < PANELS_SETTLE_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    const settled = new Map((await evaluateInEveryWindow(PORTS.debug, inspectExpression())).map((r) => [r.id, r]));
    latest = results.map((result) => {
      const later = settled.get(result.id);
      return result.ok && later?.ok && later.value ? { ...result, value: later.value } : result;
    });
    if ((!measuring(latest) || waited >= TONE_SETTLE_MS) && !bare(latest)) break;
  }
  return latest;
}

export async function restoreOnce(store) {
  const results = await evaluateInEveryWindow(PORTS.debug, restoreExpression());
  const clean = results.length > 0 && results.every((result) => result.ok && result.value.remaining === 0);
  if (clean) await store.markRestored();
  return { clean, results };
}

export const windowReport = (result) =>
  result.ok
    ? { id: result.id, type: result.type, ok: true, ...result.value }
    : { id: result.id, type: result.type, ok: false, error: result.error };
