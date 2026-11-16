import { CUSTOM_ID, CUSTOM_NAME, importCustomImage, loadApplicableThemes } from './custom.mjs';
import { evaluate, identifyDebug, listTargets, notGrokBotMessage, openSession, usableDebug } from './cdp.mjs';
import { UserError } from './errors.mjs';
import { restoreExpression } from './overlay.mjs';
import {
  PANEL_BINDING,
  panelNoticeExpression,
  panelUnmountExpression,
  panelUsageExpression,
  parsePanelPayload,
  themedExpression,
  themedNewDocumentScript,
  UPLOAD,
} from './panel.mjs';
import { servePanel } from './panel-server.mjs';
import { HOST, PORTS } from './ports.mjs';
import { appliedToken } from './store.mjs';
import { thumbDataUrl, wallpaperDataUrl } from './themes.mjs';
import { createUsageKeeper } from './usage.mjs';

const TICK_MS = 2000;

// watch --with-app (started by the "with wallpaper" icon) goes away with Grok Bot instead of staying resident.
export const WITH_APP = Object.freeze({
  // Grok Bot's debug port silent this long after it was seen: the app is gone, so is the helper.
  goneMs: 30000,
  // Grok Bot never seen this long after start: the helper gives up.
  graceMs: 60000,
});

// Test-only: the self-tests may shorten (never lengthen) the two waits so they do not sit for a minute.
export function withAppTiming(env = process.env) {
  const shorter = (raw, fallback) => {
    const value = Number(raw);
    return raw && Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  };
  return { goneMs: shorter(env.GROKBOT_TEST_APP_GONE_MS, WITH_APP.goneMs), graceMs: shorter(env.GROKBOT_TEST_APP_GRACE_MS, WITH_APP.graceMs) };
}

// Fed one observation per look at the debug port; says when a --with-app helper should leave.
// Returns null while it should stay, or the reason (one Chinese sentence) once it should exit.
// Without withApp the helper never leaves on its own, exactly as before.
export function appPresence({ withApp = true, now = Date.now, timing = WITH_APP } = {}) {
  if (!withApp) return () => null;
  const started = now();
  let lastSeen = null;
  return function observe(appAnswers) {
    const t = now();
    if (appAnswers) {
      lastSeen = t;
      return null;
    }
    if (lastSeen === null) {
      return t - started >= timing.graceMs ? `启动 ${Math.round(timing.graceMs / 1000)} 秒内一直没见到 Grok Bot，小助手退出。` : null;
    }
    return t - lastSeen >= timing.goneMs ? `Grok Bot 的调试口已经 ${Math.round(timing.goneMs / 1000)} 秒没有应答，应用多半已经关了，小助手跟着退出。` : null;
  };
}

const storeKey = (lastApplied, strength) => JSON.stringify([lastApplied, strength]);

// What every window should show, derived from the store alone: { kind: 'clean' } or { kind: 'themed', script, now }.
async function buildProgram(store, lastApplied, strength) {
  if (lastApplied === null || lastApplied.restored) return { kind: 'clean' };
  const { themes } = await loadApplicableThemes(store.dir);
  const theme = themes.find((candidate) => candidate.id === lastApplied.themeId);
  if (!theme) return { kind: 'clean' };
  const overlay = {
    dataUrl: await wallpaperDataUrl(theme),
    opacity: theme.opacity,
    appearance: theme.appearance,
    token: appliedToken(lastApplied),
    strength,
  };
  const panel = {
    themes: await Promise.all(
      themes.map(async (t) => ({
        id: t.id,
        name: t.name,
        appearance: t.appearance,
        accent: t.accent ?? null,
        thumb: await thumbDataUrl(t),
        wallpaperThumb: t.id === CUSTOM_ID,
      })),
    ),
    current: theme.id,
    binding: PANEL_BINDING,
    state: await store.readPanel(),
    strength,
    uploadLimit: UPLOAD.maxBytes,
    usage: panelUsageState(await store.readUsage()),
  };
  return { kind: 'themed', script: themedNewDocumentScript(overlay, panel), now: themedExpression(overlay, panel) };
}

// Only what the panel draws; the failure reasons stay in the store for status.
const panelUsageState = ({ enabled, percent, readAt }) => ({ enabled, percent, readAt });

async function readSnapshot(store) {
  const [lastApplied, strength] = await Promise.all([store.readLastApplied(), store.readStrength()]);
  return { lastApplied, strength, key: storeKey(lastApplied, strength) };
}

// onIdentity(identity) is told what the debug port answered on every look (watch --with-app uses it).
// onTick: extra housekeeping per look that must not hold the wallpaper up; it is started and not waited for.
export function createDaemon({ store, log, onIdentity = () => {}, onTick = () => {} }) {
  // target id -> { session, scriptId }. A session's new-document script only lives while that session stays open.
  const windows = new Map();
  let syncedKey;
  // What the debug port last answered as, so a foreign program is reported once, not every tick.
  let lastDebugState = null;
  let chain = Promise.resolve();
  let timer = null;
  let stopped = false;
  // Show usage lives in its own module; nothing it does can stop the wallpaper or the rest of the panel.
  // A new figure is pushed to every panel at once, and the new-document scripts are re-registered so a reload shows it too.
  // Not awaited: this can be called from inside a tick, and the re-registration has to queue behind it.
  const usage = createUsageKeeper({
    store,
    log,
    binding: PANEL_BINDING,
    onChange: (state) => {
      serial(() => resync({ panelOnly: true })).catch((error) => log(`用量：面板脚本没更新：${error.message}`));
      for (const { session } of windows.values()) evaluate(session, panelUsageExpression(panelUsageState(state))).catch(() => {});
    },
  });

  // Ticks, panel messages and HTTP calls all run one at a time, so a window never has two scripts registered.
  function serial(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  async function show(entry, program, evaluateNow) {
    if (entry.scriptId !== null) {
      await entry.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId });
      entry.scriptId = null;
    }
    if (program.kind === 'themed') {
      entry.scriptId = (await entry.session.send('Page.addScriptToEvaluateOnNewDocument', { source: program.script })).identifier;
    }
    if (evaluateNow) await evaluate(entry.session, program.kind === 'themed' ? program.now : restoreExpression());
  }

  async function showEverywhere(program, evaluateNow) {
    await Promise.all(
      [...windows].map(([id, entry]) => show(entry, program, evaluateNow).catch((error) => log(`窗口 ${id} 同步失败：${error.message}`))),
    );
  }

  async function attach(target, program) {
    const session = await openSession(target.wsUrl, PORTS.debug);
    const entry = { session, scriptId: null };
    windows.set(target.id, entry);
    session.onClose(() => {
      if (windows.get(target.id) !== entry) return;
      windows.delete(target.id);
      usage.detach(target.id);
      log(`窗口 ${target.id} 已断开`);
    });
    session.on('Runtime.bindingCalled', ({ name, payload }) => {
      if (name !== PANEL_BINDING) return;
      const message = parsePanelPayload(payload);
      const notify = (tone, text) => evaluate(session, panelNoticeExpression(tone, text)).catch(() => {});
      if (message?.type === 'usage') return void usage.userSaw(message.percent);
      if (message?.type === 'usage-toggle') return void usage.setEnabled(message.enabled);
      if (message) dispatch(message, { notify }).catch((error) => log(`面板消息处理失败：${error.message}`));
    });
    // Without Runtime.enable (which would stream the page's console here) a binding is gone after a reload, so re-add it per document.
    session.on('Page.domContentEventFired', () => session.send('Runtime.addBinding', { name: PANEL_BINDING }).catch(() => {}));
    await session.send('Page.enable');
    await session.send('Runtime.addBinding', { name: PANEL_BINDING });
    await show(entry, program, true);
    log(`已接上窗口 ${target.id}`);
    await usage.attach(target.id, session);
  }

  async function tick() {
    const { lastApplied, strength, key } = await readSnapshot(store);
    const identity = await identifyDebug(PORTS.debug);
    onIdentity(identity);
    Promise.resolve()
      .then(onTick)
      .catch(() => {});
    await usage.sync();
    const seen = `${identity.state}:${identity.reportedAs}`;
    if (identity.state === 'other' && seen !== lastDebugState) log(`${notGrokBotMessage(PORTS.debug, identity.reportedAs)} watch 不会往里放任何东西。`);
    lastDebugState = seen;
    const targets = usableDebug(identity) ? await listTargets(PORTS.debug) : [];
    const fresh = targets.filter((target) => !windows.has(target.id));
    if (key === syncedKey && fresh.length === 0) return;
    const program = await buildProgram(store, lastApplied, strength);
    if (key !== syncedKey) await showEverywhere(program, true);
    syncedKey = key;
    await Promise.all(
      fresh.map((target) =>
        attach(target, program).catch((error) => {
          windows.get(target.id)?.session.close();
          windows.delete(target.id);
          log(`接不上窗口 ${target.id}：${error.message}`);
        }),
      ),
    );
  }

  async function resync({ panelOnly = false } = {}) {
    const { lastApplied, strength, key } = await readSnapshot(store);
    // A moved panel only needs the new-document script re-registered, unless the store also changed under us.
    const evaluateNow = !(panelOnly && key === syncedKey);
    syncedKey = key;
    await showEverywhere(await buildProgram(store, lastApplied, strength), evaluateNow);
  }

  const HANDLERS = {
    async apply({ themeId }) {
      const { themes } = await loadApplicableThemes(store.dir);
      if (!themes.some((theme) => theme.id === themeId)) return { ok: false, error: `没有叫 "${themeId}" 的主题` };
      await store.writeLastApplied({ themeId, appliedAt: new Date().toISOString(), restored: false });
      await resync();
      return { ok: true, themeId, windows: windows.size };
    },
    async restore() {
      await store.markRestored();
      await resync();
      return { ok: true, windows: windows.size };
    },
    async panel({ x, y, collapsed }) {
      await store.writePanel({ x, y, collapsed });
      await resync({ panelOnly: true });
      return { ok: true };
    },
    // The sending window already shows the new strength; the overlay in every window takes it in place, without a new layer.
    async strength({ value }) {
      await store.writeStrength(value);
      await resync();
      return { ok: true, strength: value };
    },
    // Same checks as apply --image; the slot is only written once they pass, so a refused file leaves the wallpaper as it was.
    async upload({ name, data }, { notify }) {
      const bytes = Buffer.from(data, 'base64');
      let meta;
      try {
        meta = await importCustomImage(store.dir, { name, bytes });
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        await notify('error', error.message);
        return { ok: false, error: error.message };
      }
      await store.writeLastApplied({ themeId: CUSTOM_ID, appliedAt: new Date().toISOString(), restored: false });
      await resync();
      log(`已换上${CUSTOM_NAME}：${meta.originalName}，${meta.bytes} 字节，sha256 ${meta.sha256}`);
      await notify('ok', `已换上「${meta.originalName}」。`);
      return { ok: true, themeId: CUSTOM_ID, bytes: meta.bytes, sha256: meta.sha256 };
    },
  };

  const NO_ORIGIN = { notify: async () => {} };

  function dispatch(message, origin = NO_ORIGIN) {
    return serial(() => HANDLERS[message.type](message, origin));
  }

  function loop() {
    if (stopped) return;
    serial(tick)
      .catch((error) => log(`检查失败：${error.message}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, TICK_MS);
      });
  }

  // The wallpaper stays until the next reload; the panel goes now, since nothing would answer its clicks.
  function stop() {
    stopped = true;
    clearTimeout(timer);
    usage.stop();
    return serial(async () => {
      await Promise.all(
        [...windows.values()].map(async ({ session }) => {
          await evaluate(session, panelUnmountExpression()).catch(() => {});
          await session.close();
        }),
      );
      windows.clear();
    });
  }

  return { dispatch, start: loop, stop };
}

// withApp: leave once Grok Bot is gone (see WITH_APP). Without it watch runs until it is told to stop, as before.
export async function runWatch({ store, log, withApp = false, timing = withAppTiming(), onTick }) {
  let stopServer = null;
  let observe = null;
  let leaving = false;
  const onIdentity = (identity) => {
    if (!observe || leaving) return;
    const reason = observe(usableDebug(identity));
    if (!reason) return;
    leaving = true;
    log(reason);
    // Not awaited: stopping waits for the current look to finish, and this runs inside it.
    stopServer?.();
  };
  const daemon = createDaemon({ store, log, onIdentity, onTick });
  await servePanel({
    store,
    log,
    dispatch: daemon.dispatch,
    onStart: (stop) => {
      stopServer = stop;
      observe = appPresence({ withApp, timing });
      log(`watch 已启动：每 ${TICK_MS / 1000} 秒看一次调试口 ${HOST}:${PORTS.debug}，不会启动、关闭或重启 Grok Bot。按 Ctrl+C 停止。`);
      if (withApp) log(`跟着应用走：Grok Bot 关掉 ${Math.round(timing.goneMs / 1000)} 秒后，或启动 ${Math.round(timing.graceMs / 1000)} 秒内没见到它，小助手自己退出。`);
      daemon.start();
    },
    onStop: daemon.stop,
  });
  log('watch 已停止');
}
