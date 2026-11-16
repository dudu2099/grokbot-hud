import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { evaluate, listTargets, openSession } from '../src/cdp.mjs';
import { MARK } from '../src/overlay.mjs';
import { PORTS } from '../src/ports.mjs';

const [outArg] = process.argv.slice(2);
if (!outArg) {
  console.error('用法：node scripts/verify-shot.mjs <输出.png>');
  process.exit(1);
}

const probe = `(() => {
  const layers = document.querySelectorAll('[${MARK.attr}="layer"]').length;
  const mixed = [...document.querySelectorAll('[style*="color-mix"]')].length;
  return {
    layers,
    token: window['${MARK.key}']?.token ?? null,
    translucentPanels: mixed,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    viewport: [innerWidth, innerHeight],
  };
})()`;

const targets = await listTargets(PORTS.debug);
if (targets.length === 0) {
  console.error('调试口开着，但没有窗口可截。');
  process.exit(1);
}

const report = [];
for (const [index, target] of targets.entries()) {
  const session = await openSession(target.wsUrl, PORTS.debug);
  try {
    const state = await evaluate(session, probe);
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    const out = resolve(targets.length === 1 ? outArg : outArg.replace(/\.png$/i, `-${index + 1}.png`));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(data, 'base64'));
    report.push({ window: index + 1, out, ...state });
  } finally {
    await session.close();
  }
}
console.log(JSON.stringify(report, null, 2));
