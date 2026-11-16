// 显示用量：本工具里唯一的例外。
//
// 别的地方一律不认 Grok Bot 的具体界面、不读页面里的文字，只读大小和颜色。这个文件是唯一的例外，也只在这里：
//   - 唯一认 Grok Bot 某个具体界面的地方：左下角那个 button[aria-haspopup="menu"]（账户按钮）和它弹出的 [role="menu"]。
//   - 唯一读页面文字的地方：只读那个菜单里「一个叶子节点的全部文字正好是『97% 已用』或『97% used』」的那一个数。
//     菜单里别的项（套餐名、邮箱、设置……）不读出页面、不传、不存、不打日志。
//   - 唯一替用户点东西的地方：用调试协议对账户按钮发一次真实点击打开菜单，读完发一次 Escape 关上。
//     点之前给页面加一张临时样式表，让菜单透明且不挡鼠标；它无论如何都会被撤掉，另有一个页面里的定时器兜底。
//   - 不调应用自己的用量接口，不读它的网络请求和本地存储：那等于拿用户的登录身份做事。
// 别的文件只通过这里导出的函数用这件事。这里坏了（官方改了菜单）只会让用量不显示，不影响壁纸和面板的其它部分。

import { setTimeout as realSleep } from 'node:timers/promises';
import { evaluate } from './cdp.mjs';

export const USAGE = Object.freeze({
  // 自动读数的间隔，以及只在用户闲着时读：没在输入，并且这么久没有键盘和鼠标的动静。
  intervalMs: 10 * 60 * 1000,
  idleMs: 20 * 1000,
  // 用户忙着时推后多久再看一眼。
  busyRetryMs: 30 * 1000,
  // 窗口刚接上时：界面还没画出来（找不到账户按钮）或正在输入，就隔这么久再试，最多这么多次。
  firstRetryMs: 2000,
  firstTries: 6,
  // 别的窗口刚读到过（这么久以内），新接上的窗口就不再点一次。
  freshMs: 60 * 1000,
  // 连续失败这么多次之后，间隔开始翻倍，最长拉到这么久。
  backoffAfter: 3,
  maxBackoffMs: 4 * 60 * 60 * 1000,
  // 点开之后等数字最多多久；Escape 之后等菜单消失最多多久。
  openWaitMs: 2000,
  closeWaitMs: 1000,
  pollMs: 50,
  // 临时样式表加上去的同时，页面里设一个这么久之后自己撤掉它的定时器。正常一次读数不超过 5 秒。
  failsafeMs: 8000,
  // 「正在输入」：焦点在输入框里，并且这么久以内按过键。光看焦点不行：真应用的输入框平时就一直占着焦点，
  // 那样会每次都被当成在输入、永远读不到（真机上撞到的）。
  typingMs: 8000,
  // 显示：达到这两个数分别转琥珀色和红色；超过这么久没更新就算旧数字。
  warnAt: 80,
  dangerAt: 95,
  staleMs: 30 * 60 * 1000,
  colors: Object.freeze({ warn: '#e6a23c', danger: '#d9534f' }),
});

// 认数字的规则：一个叶子节点 trim 之后的全部文字。多一个字都不认。
export const USAGE_TEXT = Object.freeze({ pattern: '^(\\d{1,3})\\s*%\\s*(?:已用|used)$', flags: 'i' });
const USAGE_RE = new RegExp(USAGE_TEXT.pattern, USAGE_TEXT.flags);

export function parseUsageText(text) {
  if (typeof text !== 'string') return null;
  const match = USAGE_RE.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

// 临时样式表：菜单照样打开、能读到数字，用户看不见它闪，鼠标也穿过它。最后一条是给自测和主帅查的记号。
export const HIDE_MARK = '--grokbot-themes-usage-hiding';
const HIDE_CSS = `[role="menu"], [data-radix-popper-content-wrapper] { opacity: 0 !important; pointer-events: none !important; }
:root { ${HIDE_MARK}: 1; }`;

// Test-only: the self-tests may shorten (never lengthen) the waits so they do not sit for ten minutes.
export function usageTiming(env = process.env, base = USAGE) {
  const shorter = (raw, fallback) => {
    const value = Number(raw);
    return raw && Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  };
  return {
    ...base,
    intervalMs: shorter(env.GROKBOT_TEST_USAGE_INTERVAL_MS, base.intervalMs),
    idleMs: shorter(env.GROKBOT_TEST_USAGE_IDLE_MS, base.idleMs),
    busyRetryMs: shorter(env.GROKBOT_TEST_USAGE_RETRY_MS, base.busyRetryMs),
    freshMs: shorter(env.GROKBOT_TEST_USAGE_FRESH_MS, base.freshMs),
  };
}

export const USAGE_REASONS = Object.freeze({
  off: '功能关着',
  typing: '跳过：在输入',
  busy: '跳过：用户最近在操作',
  hidden: '跳过：窗口没显示在屏幕上',
  covered: '跳过：账户按钮被别的东西盖住了',
  menuOpen: '跳过：菜单已经开着，里面没有用量',
  windowBusy: '跳过：这个窗口正在读',
  noButton: '找不到账户按钮（左下角带菜单的按钮）',
  noNumber: '点开了账户菜单，但 2 秒内没等到「百分之几已用」',
  stuck: '按了两次 Escape 菜单还开着，放弃这次',
  error: (message) => `调试协议出错：${message}`,
});

// 闲不闲：正在输入就不读；要求闲着时，最近这么久内有键盘鼠标动静也不读。
export function idleDecision(look, requireIdleMs) {
  if (look.typing) return USAGE_REASONS.typing;
  if (requireIdleMs > 0 && !(look.idleMs >= requireIdleMs)) return USAGE_REASONS.busy;
  return null;
}

// 下一次自动读数在多久之后：连续失败若干次后翻倍拉长。
export function usageDelay(failures, timing = USAGE) {
  if (failures < timing.backoffAfter) return timing.intervalMs;
  return Math.min(timing.intervalMs * 2 ** (failures - timing.backoffAfter + 1), Math.max(timing.maxBackoffMs, timing.intervalMs));
}

const messageOf = (error) => (error && typeof error === 'object' && 'message' in error ? error.message : String(error));

// 读一次数。页面里的几步和调试协议的几步都是注入的，所以能用假的函数把每条岔路测全：
//   enabled: async () => boolean
//   page:  { peek() -> { typing, menuOpen, percent, button, idleMs }, prepare() -> { x, y } | null,
//            waitPercent() -> number | null, waitGone() -> boolean, finish() }
//   input: { click(x, y), escape() }
// 结果：{ outcome: 'ok', percent, source: 'opened' | 'user-menu' } | { outcome: 'skipped' | 'failed', reason }。从不抛错。
export async function readUsage({ enabled, page, input, requireIdleMs = 0 }) {
  const skipped = (reason) => ({ outcome: 'skipped', reason });
  const failed = (reason) => ({ outcome: 'failed', reason });
  let look;
  try {
    if (!(await enabled())) return skipped(USAGE_REASONS.off);
    look = await page.peek();
  } catch (error) {
    return failed(USAGE_REASONS.error(messageOf(error)));
  }
  // 窗口被盖住或最小化时没人看得到数字，页面里的定时器也会慢到一秒一跳，等待会拖到超时。
  if (look.hidden) return skipped(USAGE_REASONS.hidden);
  const busy = idleDecision(look, requireIdleMs);
  if (busy) return skipped(busy);
  // 用户自己开的菜单：不点、不关，有数就拿走。
  if (look.menuOpen) return look.percent === null ? skipped(USAGE_REASONS.menuOpen) : { outcome: 'ok', percent: look.percent, source: 'user-menu' };
  if (!look.button) return failed(USAGE_REASONS.noButton);
  // 弹窗、图片预览之类盖在按钮上时，点下去会点到它们身上，可能把用户的弹窗关掉。
  if (look.covered) return skipped(USAGE_REASONS.covered);

  let percent = null;
  let reason = null;
  let skip = null;
  let clicked = false;
  try {
    const at = await page.prepare();
    if (!at) reason = USAGE_REASONS.noButton;
    else if (at.covered) skip = USAGE_REASONS.covered;
    else {
      await input.click(at.x, at.y);
      clicked = true;
      percent = await page.waitPercent();
      if (percent === null) reason = USAGE_REASONS.noNumber;
    }
  } catch (error) {
    reason = USAGE_REASONS.error(messageOf(error));
  }
  // Escape 只在点击确实发出去之后才按，最多两次。
  if (clicked) {
    try {
      await input.escape();
      let gone = await page.waitGone();
      if (!gone) {
        await input.escape();
        gone = await page.waitGone();
      }
      if (!gone) reason = USAGE_REASONS.stuck;
    } catch (error) {
      reason ??= USAGE_REASONS.error(messageOf(error));
    }
  }
  // 无论前面哪一步出错，都撤掉临时样式表、还焦点。这一步本身失败了，页面里的定时器会撤。
  try {
    await page.finish();
  } catch (error) {
    reason ??= USAGE_REASONS.error(messageOf(error));
  }
  if (reason !== null) return failed(reason);
  if (skip !== null) return skipped(skip);
  return { outcome: 'ok', percent, source: 'opened' };
}

// Runs inside the page. Serialized with Function.prototype.toString, so it must not close over module scope.
// One function for every page-side step, so the account-menu rules live in one place:
//   install: remember when the user last pressed a key or moved the pointer (only the time), and notice a menu the user opened
//   peek / prepare / wait / gone / finish: the steps of one read; enable: switch the menu watching on or off
export function usagePage(op, cfg) {
  const existing = window[cfg.key];
  const state =
    (existing && typeof existing === 'object' && existing.seen instanceof WeakSet ? existing : null) ??
    (window[cfg.key] = { last: Date.now(), lastKey: 0, busy: false, enabled: false, sheet: null, timer: 0, focus: null, range: null, seen: new WeakSet(), installed: false, binding: null });
  const pattern = new RegExp(cfg.text.pattern, cfg.text.flags);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const menus = () => [...document.querySelectorAll('[role="menu"]')];
  // Only a leaf whose whole text is the usage figure; nothing else of the menu leaves this function.
  const numberIn = (root) => {
    for (const node of root.querySelectorAll('*')) {
      if (node.childElementCount !== 0) continue;
      const match = pattern.exec((node.textContent ?? '').trim());
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isInteger(value) && value >= 0 && value <= 100) return value;
    }
    return null;
  };
  const numberInMenus = () => {
    for (const menu of menus()) {
      const value = numberIn(menu);
      if (value !== null) return value;
    }
    return null;
  };
  const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image', 'hidden']);
  const deepActive = () => {
    let node = document.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    return node;
  };
  const inEditable = () => {
    const node = deepActive();
    if (!node || node === document.body) return false;
    if (node.isContentEditable) return true;
    if (node.tagName === 'TEXTAREA') return !node.readOnly && !node.disabled;
    if (node.tagName === 'INPUT') return !NOT_TEXT.has(String(node.type).toLowerCase()) && !node.readOnly && !node.disabled;
    return false;
  };
  // Focus resting in a text box is not typing; a key pressed there a moment ago is.
  const typing = () => inEditable() && Date.now() - (state.lastKey ?? state.last) < cfg.typingMs;
  // The bottom-most visible menu button in the left quarter and the bottom 15% of the window.
  const accountButton = () => {
    let best = null;
    for (const button of document.querySelectorAll('button[aria-haspopup="menu"]')) {
      const box = button.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || getComputedStyle(button).visibility === 'hidden') continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x > innerWidth * cfg.button.maxXRatio || y < innerHeight * cfg.button.minYRatio || y > innerHeight) continue;
      if (!best || box.bottom > best.bottom) best = { button, x, y, bottom: box.bottom };
    }
    // The click goes to whatever is on top at that point. Unless that is the button itself, something is covering it.
    if (best) {
      const top = document.elementFromPoint(best.x, best.y);
      best.covered = !(top && (top === best.button || best.button.contains(top)));
    }
    return best;
  };
  const dropSheet = () => {
    clearTimeout(state.timer);
    if (state.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== state.sheet);
    state.sheet = null;
    state.busy = false;
  };
  const inMenu = (node) => Boolean(node?.closest?.('[role="menu"]'));

  if (op === 'install') {
    state.enabled = cfg.enabled;
    state.binding = cfg.binding;
    if (state.installed) return true;
    state.installed = true;
    const touch = () => {
      if (!state.busy) state.last = Date.now();
    };
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel']) addEventListener(type, touch, { capture: true, passive: true });
    // Only the time of the last key press is kept, never which key.
    addEventListener('keydown', () => { if (!state.busy) state.lastKey = Date.now(); }, { capture: true, passive: true });
    // A menu the user opened: take the figure if it shows up, never press anything.
    const check = () => {
      if (!state.enabled || state.busy) return;
      for (const menu of menus()) {
        if (state.seen.has(menu)) continue;
        state.seen.add(menu);
        (async () => {
          for (let waited = 0; waited <= cfg.waitMs; waited += cfg.pollMs) {
            if (!menu.isConnected || state.busy || !state.enabled) return;
            const value = numberIn(menu);
            if (value !== null) {
              const send = window[state.binding];
              if (typeof send === 'function') send(JSON.stringify({ type: 'usage', percent: value }));
              return;
            }
            await pause(cfg.pollMs);
          }
        })();
      }
    };
    const observe = () => new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) observe();
    else document.addEventListener('DOMContentLoaded', observe, { once: true });
    return true;
  }
  if (op === 'enable') {
    state.enabled = cfg.enabled;
    return true;
  }
  if (op === 'peek') {
    const open = menus().length > 0;
    const account = accountButton();
    return { typing: typing(), hidden: document.visibilityState !== 'visible', menuOpen: open, percent: open ? numberInMenus() : null, button: account !== null, covered: account?.covered === true, idleMs: Date.now() - state.last };
  }
  if (op === 'prepare') {
    dropSheet();
    state.busy = true;
    state.focus = document.activeElement;
    // The caret too: giving focus back to a text box must not move where the user was writing.
    const selection = getSelection();
    state.range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cfg.hideCss);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    state.sheet = sheet;
    // Even if this connection dies before finish runs, the sheet goes away on its own.
    state.timer = setTimeout(dropSheet, cfg.failsafeMs);
    const found = accountButton();
    return found ? { x: found.x, y: found.y, covered: found.covered } : null;
  }
  if (op === 'wait') {
    return (async () => {
      // By the clock, not by counting polls: a window that gets covered mid-read has its timers slowed to one a second.
      for (const until = Date.now() + cfg.waitMs; ; ) {
        const value = numberInMenus();
        if (value !== null) return value;
        if (Date.now() >= until) return null;
        await pause(cfg.pollMs);
      }
    })();
  }
  if (op === 'gone') {
    return (async () => {
      for (const until = Date.now() + cfg.goneMs; ; ) {
        if (menus().length === 0) return true;
        if (Date.now() >= until) return false;
        await pause(cfg.pollMs);
      }
    })();
  }
  if (op === 'finish') {
    for (const menu of menus()) state.seen.add(menu);
    // Focus goes back only if it is still where the menu left it (the account button, the menu, or nowhere),
    // so a user who clicked somewhere meanwhile keeps their focus.
    const now = document.activeElement;
    const account = accountButton()?.button ?? null;
    const leftByMenu = !now || now === document.body || now === account || inMenu(now);
    const before = state.focus;
    let focusBack = false;
    if (leftByMenu) {
      if (before && before !== document.body && before.isConnected) {
        if (now !== before) before.focus({ preventScroll: true });
        focusBack = document.activeElement === before;
        const range = state.range;
        if (focusBack && range && before.isContentEditable && range.startContainer.isConnected && range.endContainer.isConnected && before.contains(range.startContainer)) {
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } else if (now && now !== document.body) {
        now.blur();
        focusBack = true;
      }
    }
    state.focus = null;
    state.range = null;
    dropSheet();
    return { focusBack };
  }
  return null;
}

const pageConfig = (extra = {}) => ({
  // Not __grokbotThemesUsage: that name is the panel's update hook.
  key: '__grokbotThemesUsageReader',
  text: USAGE_TEXT,
  hideCss: HIDE_CSS,
  button: { maxXRatio: 0.25, minYRatio: 0.85 },
  waitMs: USAGE.openWaitMs,
  goneMs: USAGE.closeWaitMs,
  pollMs: USAGE.pollMs,
  failsafeMs: USAGE.failsafeMs,
  typingMs: USAGE.typingMs,
  binding: null,
  enabled: true,
  ...extra,
});

export const usagePageExpression = (op, extra) => `(${usagePage})(${JSON.stringify(op)}, ${JSON.stringify(pageConfig(extra))})`;
export const usageInstallScript = (enabled, binding) => `if (window === window.top) ${usagePageExpression('install', { enabled, binding })};`;

// The real page steps and debug-protocol inputs for one window's session.
export function sessionSteps(session) {
  const run = (op) => evaluate(session, usagePageExpression(op));
  const mouse = (type, x, y, extra = {}) => session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  const key = (type) =>
    session.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  return {
    page: { peek: () => run('peek'), prepare: () => run('prepare'), waitPercent: () => run('wait'), waitGone: () => run('gone'), finish: () => run('finish') },
    input: {
      async click(x, y) {
        await mouse('mouseMoved', x, y, { button: 'none' });
        await mouse('mousePressed', x, y, { buttons: 1, clickCount: 1 });
        await mouse('mouseReleased', x, y, { buttons: 0, clickCount: 1 });
      },
      async escape() {
        await key('keyDown');
        await key('keyUp');
      },
    },
  };
}

// What the panel shows, from the stored state. Runs in the page too (passed in as source), so no module scope.
// null: draw nothing (never read, switched off, or nonsense). Never a 0 or a guessed figure.
export function usageView(state, nowMs, limits) {
  if (!state || state.enabled !== true) return null;
  const percent = state.percent;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return null;
  const readMs = Date.parse(state.readAt);
  if (!Number.isFinite(readMs)) return null;
  const age = Math.max(0, nowMs - readMs);
  const minutes = Math.floor(age / 60000);
  const stale = age > limits.staleMs;
  const tone = percent >= limits.dangerAt ? 'danger' : percent >= limits.warnAt ? 'warn' : 'normal';
  const ago = minutes < 1 ? '刚刚' : minutes < 120 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
  return {
    percent,
    tone,
    stale,
    minutes,
    label: stale ? `用量 ${percent}%（${ago}）` : `用量 ${percent}%`,
    title: `Grok Bot 用量 ${percent}%，${ago}读到`,
  };
}

export const usageLimits = (timing = USAGE) => ({ warnAt: timing.warnAt, dangerAt: timing.dangerAt, staleMs: timing.staleMs, colors: timing.colors });

// The resident part, one per watch. It decides when to read, in which window, and records what it got.
//   store: readUsage(), writeUsage(); onChange(state): every panel should show this; steps(session): sessionSteps by default
export function createUsageKeeper({ store, log, binding, onChange = () => {}, timing = usageTiming(), now = Date.now, steps = sessionSteps, sleep = realSleep }) {
  const windows = new Map();
  let failures = 0;
  let lastLogged = null;
  let lastAttemptKey = null;
  let timer = null;
  let stopped = false;
  let stateKey = null;
  let pageEnabled = null;

  const safeLog = (line) => {
    try {
      log(line);
    } catch {}
  };

  async function changed(state) {
    stateKey = JSON.stringify([state.enabled, state.percent, state.readAt]);
    try {
      await onChange(state);
    } catch (error) {
      safeLog(`用量：更新面板失败：${error.message}`);
    }
  }

  // Writes what this attempt found. A skip is only written when it differs from the last one, so busy retries do not churn the disk.
  async function record(result) {
    const at = new Date(now()).toISOString();
    const state = await store.readUsage();
    if (result.outcome === 'ok') {
      failures = 0;
      if (lastLogged !== `ok:${result.percent}`) safeLog(`用量：读到 ${result.percent}%${result.source === 'user-menu' ? '（用户自己打开的菜单）' : ''}`);
      lastLogged = `ok:${result.percent}`;
      lastAttemptKey = 'ok';
      const next = { ...state, percent: result.percent, readAt: at, lastAttempt: { outcome: 'ok', reason: null, at } };
      await store.writeUsage(next);
      await changed(next);
      return;
    }
    const key = `${result.outcome}:${result.reason}`;
    if (result.outcome === 'failed') {
      failures++;
      if (lastLogged !== key) safeLog(`用量：没读到，${result.reason}`);
      lastLogged = key;
      const next = { ...state, percent: null, readAt: null, lastError: { reason: result.reason, at }, lastAttempt: { outcome: 'failed', reason: result.reason, at } };
      await store.writeUsage(next);
      await changed(next);
    } else if (key !== lastAttemptKey) {
      await store.writeUsage({ ...state, lastAttempt: { outcome: 'skipped', reason: result.reason, at } });
    }
    lastAttemptKey = key;
  }

  async function readIn(id, requireIdleMs) {
    const entry = windows.get(id);
    if (!entry) return null;
    if (entry.busy) return { outcome: 'skipped', reason: USAGE_REASONS.windowBusy };
    entry.busy = true;
    let result;
    try {
      const { page, input } = steps(entry.session);
      result = await readUsage({ enabled: async () => (await store.readUsage()).enabled, page, input, requireIdleMs });
    } finally {
      entry.busy = false;
    }
    try {
      await record(result);
    } catch (error) {
      safeLog(`用量：记不下这次结果：${error.message}`);
    }
    return result;
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(periodic, ms);
  }

  // Every interval, in the first window that is idle. Busy or typing: look again a little later.
  async function periodic() {
    if (stopped) return;
    let busy = false;
    try {
      if ((await store.readUsage()).enabled) {
        for (const id of windows.keys()) {
          const result = await readIn(id, timing.idleMs);
          if (!result) continue;
          if (result.outcome === 'skipped') {
            busy = true;
            continue;
          }
          busy = false;
          break;
        }
      }
    } catch (error) {
      safeLog(`用量：自动读数出错：${error.message}`);
    }
    schedule(busy ? timing.busyRetryMs : usageDelay(failures, timing));
  }

  // Right after a window is attached: once the account button shows up, read without waiting for the user to go idle.
  async function first(id) {
    for (let attempt = 0; attempt < timing.firstTries && !stopped && windows.has(id); attempt++) {
      const state = await store.readUsage();
      if (!state.enabled) return;
      const fresh = state.readAt && now() - Date.parse(state.readAt) < timing.freshMs;
      if (fresh) return;
      const entry = windows.get(id);
      const { page, input } = steps(entry.session);
      if (entry.busy) return;
      // Not drawn yet (no account button) or typing: give it a moment, without counting it as a failure.
      let look;
      try {
        look = await page.peek();
      } catch {
        look = null;
      }
      const waiting = look && (look.typing || look.hidden || look.covered || (!look.button && !look.menuOpen));
      if (look && !waiting) {
        const result = await readIn(id, 0);
        if (result?.outcome === 'ok') schedule(usageDelay(0, timing));
        return;
      }
      if (attempt === timing.firstTries - 1) {
        const result = await readIn(id, 0);
        if (result?.outcome === 'ok') schedule(usageDelay(0, timing));
        // Still typing or still covered: look again soon instead of a whole interval later.
        else if (result?.outcome === 'skipped') schedule(timing.busyRetryMs);
        return;
      }
      await sleep(timing.firstRetryMs);
    }
  }

  async function setPage(enabled) {
    await Promise.all(
      [...windows.values()].map(async (entry) => {
        try {
          if (entry.scriptId !== null) await entry.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId });
          entry.scriptId = (await entry.session.send('Page.addScriptToEvaluateOnNewDocument', { source: usageInstallScript(enabled, binding) })).identifier;
          await evaluate(entry.session, usagePageExpression('enable', { enabled }));
        } catch {}
      }),
    );
  }

  return {
    async attach(id, session) {
      const entry = { session, busy: false, scriptId: null };
      windows.set(id, entry);
      try {
        const { enabled } = await store.readUsage();
        entry.scriptId = (await session.send('Page.addScriptToEvaluateOnNewDocument', { source: usageInstallScript(enabled, binding) })).identifier;
        await evaluate(session, usagePageExpression('install', { enabled, binding }));
        if (timer === null) schedule(usageDelay(failures, timing));
        first(id).catch((error) => safeLog(`用量：首次读数出错：${error.message}`));
      } catch (error) {
        safeLog(`用量：窗口 ${id} 装不上读数的小钩子：${error.message}`);
      }
    },
    detach(id) {
      windows.delete(id);
    },
    // A figure the page saw in a menu the user opened.
    async userSaw(percent) {
      try {
        if (!(await store.readUsage()).enabled) return;
        await record({ outcome: 'ok', percent, source: 'user-menu' });
        schedule(usageDelay(0, timing));
      } catch (error) {
        safeLog(`用量：记不下用户菜单里的数字：${error.message}`);
      }
    },
    async setEnabled(enabled) {
      try {
        const state = await store.readUsage();
        if (state.enabled === enabled) return;
        const next = { ...state, enabled };
        await store.writeUsage(next);
        await this.sync();
      } catch (error) {
        safeLog(`用量：开关没切换成：${error.message}`);
      }
    },
    // Picks up a switch flipped by the CLI (usage on/off) or by the panel; called on every watch tick.
    // What the pages were told is tracked on its own: a read that lands between the switch and this look updates the
    // panels, but must not hide the switch from the pages' menu watching.
    async sync() {
      try {
        const state = await store.readUsage();
        if (state.enabled !== pageEnabled) {
          const wasEnabled = pageEnabled;
          pageEnabled = state.enabled;
          await setPage(state.enabled);
          safeLog(state.enabled ? '用量：显示用量已打开' : '用量：显示用量已关闭，不再读数');
          if (state.enabled && wasEnabled === false) {
            failures = 0;
            for (const id of windows.keys()) first(id).catch(() => {});
            schedule(usageDelay(0, timing));
          }
        }
        if (JSON.stringify([state.enabled, state.percent, state.readAt]) === stateKey) return;
        await changed(state);
      } catch (error) {
        safeLog(`用量：读不了状态：${error.message}`);
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    get failures() {
      return failures;
    },
  };
}
