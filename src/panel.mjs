import { applyExpression, MARK, pageCall } from './overlay.mjs';
import { parsePanelState, parseStrength } from './store.mjs';
import { WALLPAPER_LIMIT } from './themes.mjs';
import { usageLimits, usageView } from './usage.mjs';

export const PANEL_BINDING = '__grokbotThemesSend';

const THEME_ID = /^[a-z0-9-]+$/;
// The picked file travels as one base64 string. Measured on the stand-in: a 12 MB binding payload arrives whole.
export const UPLOAD = Object.freeze({ maxBytes: WALLPAPER_LIMIT, maxName: 255, maxData: Math.ceil(WALLPAPER_LIMIT / 3) * 4 + 4 });
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const uploadMessage = (raw) =>
  typeof raw.name === 'string' &&
  raw.name.length > 0 &&
  raw.name.length <= UPLOAD.maxName &&
  typeof raw.data === 'string' &&
  raw.data.length <= UPLOAD.maxData &&
  raw.data.length % 4 === 0 &&
  BASE64.test(raw.data)
    ? { type: 'upload', name: raw.name, data: raw.data }
    : null;

// Page -> daemon messages, one parser per tag. Anything else is dropped at this boundary.
const MESSAGES = {
  apply: (raw) => (typeof raw.themeId === 'string' && THEME_ID.test(raw.themeId) ? { type: 'apply', themeId: raw.themeId } : null),
  restore: () => ({ type: 'restore' }),
  panel: (raw) => {
    const state = parsePanelState(raw);
    return state && { type: 'panel', ...state };
  },
  strength: (raw) => {
    const value = parseStrength(raw.value);
    return value === null ? null : { type: 'strength', value };
  },
  upload: uploadMessage,
  // The usage figure the page saw in a menu the user opened, and the panel's "显示用量" switch.
  usage: (raw) => (Number.isInteger(raw.percent) && raw.percent >= 0 && raw.percent <= 100 ? { type: 'usage', percent: raw.percent } : null),
  'usage-toggle': (raw) => (typeof raw.enabled === 'boolean' ? { type: 'usage-toggle', enabled: raw.enabled } : null),
};

export function parsePanelMessage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.hasOwn(MESSAGES, raw.type) ? MESSAGES[raw.type](raw) : null;
}

export function parsePanelPayload(text) {
  try {
    return parsePanelMessage(JSON.parse(text));
  } catch {
    return null;
  }
}

// Runs inside the page. Serialized with Function.prototype.toString, so it must not close over module scope.
// It only builds and reads its own nodes; app DOM is never touched.
// usageViewFn is usage.mjs's usageView, passed in as source: what the ring and the header figure show.
export function panelMount(config, mark, usageViewFn) {
  // badge: how far the usage figure sticks out past the ball; the ball keeps that much extra clear of the window edge.
  const SIZE = { width: 232, fab: 40, margin: 8, top: 56, right: 16, dragSlop: 4, badge: { right: 14, bottom: 9 } };
  const FALLBACK_ACCENT = '#7c8cff';
  const TAG = { dark: '深', light: '浅', auto: '自选' };
  const BUSY_TIMEOUT_MS = 30000;
  const ACCEPT = 'image/jpeg,image/png,image/webp';
  const PICKABLE = /\.(jpe?g|png|webp)$/i;
  const megabytes = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
  const CSS = `
    :host { all: initial; }
    /* A window whose title bar is a drag region would otherwise swallow clicks and drags on the panel. */
    [data-part="card"], [data-part="fab"] { -webkit-app-region: no-drag; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    [data-part="shell"] {
      --bg: rgba(250, 249, 246, 0.96); --fg: #1d1f24; --muted: rgba(29, 31, 36, 0.58);
      --line: rgba(0, 0, 0, 0.09); --hover: rgba(0, 0, 0, 0.05); --shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
      --track: rgba(0, 0, 0, 0.14);
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      color: var(--fg);
    }
    [data-part="shell"][data-mode="dark"] {
      --bg: rgba(24, 26, 32, 0.95); --fg: #eceef2; --muted: rgba(236, 238, 242, 0.6);
      --line: rgba(255, 255, 255, 0.1); --hover: rgba(255, 255, 255, 0.07); --shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
      --track: rgba(255, 255, 255, 0.2);
    }
    button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
    [data-part="card"] {
      position: fixed; width: ${SIZE.width}px; max-height: calc(100vh - ${SIZE.margin * 2}px);
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
      /* The blur is a nicety, not what keeps the card readable: when the app is flipped the panel sits under a filter and
         has no backdrop to blur, so whatever is behind it shows through sharp. The background does the covering. */
      backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4);
    }
    [data-part="header"] {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 9px 8px 5px 14px; cursor: grab; user-select: none; touch-action: none;
    }
    [data-part="title"] { flex: none; font-weight: 600; letter-spacing: 0.02em; }
    [data-part="usage"] {
      flex: 0 1 auto; min-width: 0; margin-left: auto; font-size: 11px; color: var(--usage); font-variant-numeric: tabular-nums;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    [data-part="usage"][data-stale] { opacity: 0.7; }
    [data-part="usage-row"] {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 6px 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); cursor: pointer;
    }
    [data-part="usage-switch"] { margin: 0; accent-color: var(--fg); cursor: pointer; }
    [data-part="collapse"] { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; color: var(--muted); }
    [data-part="collapse"]::before { content: ""; width: 10px; height: 1.5px; border-radius: 1px; background: currentColor; }
    [data-part="collapse"]:hover { background: var(--hover); color: var(--fg); }
    [data-part="list"] { display: flex; flex-direction: column; gap: 3px; padding: 2px 6px 6px; overflow-y: auto; }
    [data-part="item"] { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px 6px 6px; border-radius: 9px; text-align: left; }
    [data-part="item"]:hover { background: var(--hover); }
    [data-part="item"][aria-pressed="true"] {
      background: color-mix(in srgb, var(--accent) 16%, transparent); box-shadow: inset 0 0 0 1.5px var(--accent);
    }
    [data-part="thumb"] {
      flex: none; width: 52px; height: 34px; border-radius: 6px;
      background: center / cover no-repeat var(--accent); box-shadow: inset 0 0 0 1px var(--line);
    }
    [data-part="thumb"][data-swatch] { background-image: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 40%, #000)); }
    [data-part="name"] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [data-part="tag"] {
      flex: none; font-size: 11px; line-height: 17px; padding: 0 6px; border-radius: 9px;
      color: var(--muted); box-shadow: inset 0 0 0 1px var(--line);
    }
    [data-part="item"][aria-pressed="true"] [data-part="tag"] { color: var(--fg); }
    [data-part="note"] { padding: 0 14px 6px; font-size: 11px; color: #d9822b; }
    [data-part="pick"] {
      display: block; margin: 0 6px 4px; padding: 7px 8px; border-radius: 9px; text-align: center;
      box-shadow: inset 0 0 0 1px var(--line); font-weight: 500;
    }
    [data-part="pick"]:hover { background: var(--hover); }
    [data-part="pick"][aria-busy="true"] { color: var(--muted); cursor: progress; }
    [data-part="strength"] { padding: 6px 14px 4px; border-top: 1px solid var(--line); }
    [data-part="strength-head"] { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
    [data-part="strength-value"] { color: var(--fg); font-variant-numeric: tabular-nums; }
    [data-part="slider"] { display: block; width: 100%; margin: 4px 0 2px; accent-color: var(--fg); cursor: pointer; }
    [data-part="status"] { padding: 0 14px 6px; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
    [data-part="status"][data-tone="ok"] { color: #2f9e6b; }
    [data-part="status"][data-tone="error"] { color: #d9534f; }
    [data-part="footer"] { display: flex; justify-content: flex-end; padding: 5px 8px 8px; border-top: 1px solid var(--line); }
    [data-part="restore"] { font-size: 12px; color: var(--muted); padding: 4px 6px; border-radius: 6px; }
    [data-part="restore"]:hover { color: var(--fg); background: var(--hover); }
    [data-part="fab"] {
      position: fixed; width: ${SIZE.fab}px; height: ${SIZE.fab}px; border-radius: 50%;
      background: center / cover no-repeat var(--accent);
      box-shadow: 0 0 0 3px var(--bg), 0 0 0 4.5px var(--accent), var(--shadow);
      cursor: grab; touch-action: none;
    }
    /* Usage ring: just outside the ball, so the thumbnail stays whole. It replaces the thin accent ring while it is shown. */
    [data-part="fab"][data-usage] { box-shadow: 0 0 0 3px var(--bg), var(--shadow); }
    [data-part="ring"] {
      position: absolute; left: -7px; top: -7px; width: 54px; height: 54px; overflow: visible; pointer-events: none;
      transform: rotate(-90deg);
    }
    [data-part="ring"] circle { fill: none; stroke-width: 3; }
    [data-part="ring-track"] { stroke: var(--track); }
    [data-part="ring-arc"] { stroke: var(--usage); }
    [data-part="ring"][data-stale] [data-part="ring-arc"] { opacity: 0.4; }
    /* The figure itself, readable without hovering or expanding. It hangs off the lower right so the thumbnail stays visible. */
    [data-part="badge"] {
      position: absolute; right: -${SIZE.badge.right}px; bottom: -${SIZE.badge.bottom}px; padding: 1px 5px; border-radius: 8px;
      font-size: 10px; line-height: 14px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap;
      background: var(--usage); color: var(--badge-fg, #fff); box-shadow: 0 0 0 2px var(--bg);
    }
    [data-part="badge"][data-stale] { background: color-mix(in srgb, var(--usage) 55%, var(--bg)); }
  `;

  function mount() {
    for (const node of document.querySelectorAll(`[${mark.attr}="panel"]`)) node.remove();

    const host = document.createElement('grokbot-themes-panel');
    host.setAttribute(mark.attr, 'panel');
    host.style.cssText =
      'all:initial !important;display:block !important;position:fixed !important;left:0 !important;top:0 !important;' +
      'width:0 !important;height:0 !important;z-index:2147483647 !important;-webkit-app-region:no-drag !important;' +
      // When the overlay flips the app to the picture's side it publishes the filter here, and the panel flips itself back.
      'filter:var(--grokbot-themes-flip, none) !important;';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    const el = (tag, part, props = {}) => {
      const node = Object.assign(document.createElement(tag), props);
      node.dataset.part = part;
      return node;
    };
    const accentOf = (theme) => theme?.accent ?? FALLBACK_ACCENT;
    const current = config.themes.find((theme) => theme.id === config.current) ?? null;
    // The user's picture has no separate thumbnail; while it is on, the wallpaper layer already holds it.
    const wallpaperImage = document.querySelector(`[${mark.attr}="image"]`)?.style.backgroundImage ?? '';
    const thumbOf = (theme) => (theme?.thumb ? `url("${theme.thumb}")` : theme?.wallpaperThumb && theme.id === config.current ? wallpaperImage : '');

    const shell = el('div', 'shell');
    const card = el('section', 'card');
    card.setAttribute('aria-label', '换壁纸');
    const header = el('header', 'header');
    const collapse = el('button', 'collapse', { type: 'button', title: '收起' });
    collapse.setAttribute('aria-label', '收起换壁纸面板');
    const usageLabel = el('span', 'usage', { hidden: true });
    header.append(el('span', 'title', { textContent: '换壁纸' }), usageLabel, collapse);

    const list = el('div', 'list');
    for (const theme of config.themes) {
      const item = el('button', 'item', { type: 'button' });
      item.dataset.id = theme.id;
      item.setAttribute('aria-pressed', String(theme.id === config.current));
      item.style.setProperty('--accent', accentOf(theme));
      const thumb = el('span', 'thumb');
      if (thumbOf(theme)) thumb.style.backgroundImage = thumbOf(theme);
      else thumb.dataset.swatch = '';
      item.append(thumb, el('span', 'name', { textContent: theme.name }), el('span', 'tag', { textContent: TAG[theme.appearance] }));
      item.addEventListener('click', () => choose(theme.id));
      list.append(item);
    }

    const pick = el('button', 'pick', { type: 'button', textContent: '选择图片', title: 'jpg、png 或 webp，小于 4 MB' });
    const picker = el('input', 'picker', { type: 'file', accept: ACCEPT, hidden: true });
    picker.setAttribute('aria-hidden', 'true');
    picker.tabIndex = -1;

    const strengthBox = el('div', 'strength');
    const strengthValue = el('span', 'strength-value');
    const strengthHead = el('div', 'strength-head');
    strengthHead.append(el('span', 'strength-label', { textContent: '壁纸浓淡' }), strengthValue);
    const slider = el('input', 'slider', { type: 'range', min: '0', max: '100', step: '1' });
    slider.setAttribute('aria-label', '壁纸浓淡');
    strengthBox.append(strengthHead, slider);

    const status = el('div', 'status', { hidden: true });
    status.setAttribute('role', 'status');
    const note = el('div', 'note', { hidden: true });
    const footer = el('footer', 'footer');
    const restore = el('button', 'restore', { type: 'button', textContent: '恢复原样' });
    footer.append(restore);
    const usageRow = el('label', 'usage-row', { title: '从左下角的账户菜单里读 Grok Bot 的用量' });
    const usageSwitch = el('input', 'usage-switch', { type: 'checkbox' });
    usageSwitch.setAttribute('role', 'switch');
    usageRow.append(el('span', 'usage-row-label', { textContent: '显示用量' }), usageSwitch);
    card.append(header, pick, picker, list, strengthBox, usageRow, status, note, footer);

    const fab = el('button', 'fab', { type: 'button', title: '换壁纸' });
    fab.setAttribute('aria-label', '展开换壁纸面板');
    fab.style.setProperty('--accent', accentOf(current));
    if (thumbOf(current)) fab.style.backgroundImage = thumbOf(current);
    const SVG = 'http://www.w3.org/2000/svg';
    const ring = document.createElementNS(SVG, 'svg');
    ring.dataset.part = 'ring';
    ring.setAttribute('viewBox', '0 0 54 54');
    ring.setAttribute('aria-hidden', 'true');
    ring.setAttribute('hidden', '');
    const circle = (part) => {
      const node = document.createElementNS(SVG, 'circle');
      node.dataset.part = part;
      for (const [name, value] of [['cx', '27'], ['cy', '27'], ['r', '24.5'], ['pathLength', '100']]) node.setAttribute(name, value);
      return node;
    };
    const ringArc = circle('ring-arc');
    ring.append(circle('ring-track'), ringArc);
    const badge = el('span', 'badge', { hidden: true });
    badge.setAttribute('aria-hidden', 'true');
    fab.append(ring, badge);

    shell.style.setProperty('--accent', accentOf(current));
    shell.append(card, fab);
    root.append(shell);
    document.documentElement.append(host);

    let collapsed = config.state?.collapsed ?? false;
    let pos = config.state
      ? { x: config.state.x, y: config.state.y }
      : { x: innerWidth - SIZE.width - SIZE.right, y: SIZE.top };

    const clamp = (value, low, high) => Math.max(low, Math.min(value, Math.max(low, high)));
    function render() {
      card.hidden = collapsed;
      fab.hidden = !collapsed;
      const shown = collapsed ? fab : card;
      const { width, height } = shown.getBoundingClientRect();
      const spare = collapsed ? SIZE.badge : { right: 0, bottom: 0 };
      pos = {
        x: clamp(pos.x, SIZE.margin, innerWidth - width - SIZE.margin - spare.right),
        y: clamp(pos.y, SIZE.margin, innerHeight - height - SIZE.margin - spare.bottom),
      };
      shown.style.left = `${pos.x}px`;
      shown.style.top = `${pos.y}px`;
    }

    function syncMode() {
      const mode =
        window[mark.key]?.appAppearance ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      if (shell.dataset.mode !== mode) shell.dataset.mode = mode;
    }

    function send(message) {
      const deliver = window[config.binding];
      if (typeof deliver !== 'function') {
        note.textContent = '后台的 watch 没在运行，这里点了不会生效。';
        note.hidden = false;
        render();
        return false;
      }
      note.hidden = true;
      deliver(JSON.stringify(message));
      return true;
    }

    const report = () => send({ type: 'panel', x: Math.round(pos.x), y: Math.round(pos.y), collapsed });

    function choose(id) {
      if (!send({ type: 'apply', themeId: id })) return;
      for (const item of list.children) item.setAttribute('aria-pressed', String(item.dataset.id === id));
    }

    function setCollapsed(next) {
      collapsed = next;
      render();
      report();
    }

    // Returns a reader that says whether the last press on this handle was a drag, so the click that follows can be ignored.
    function draggable(handle, ignoreSelector) {
      let dragged = false;
      handle.addEventListener('pointerdown', (event) => {
        dragged = false;
        if (event.button !== 0 || (ignoreSelector && event.target.closest(ignoreSelector))) return;
        const start = { px: event.clientX, py: event.clientY, x: pos.x, y: pos.y };
        let moved = false;
        handle.setPointerCapture(event.pointerId);
        const move = (next) => {
          const dx = next.clientX - start.px;
          const dy = next.clientY - start.py;
          if (!moved && Math.hypot(dx, dy) < SIZE.dragSlop) return;
          moved = true;
          pos = { x: start.x + dx, y: start.y + dy };
          render();
        };
        const end = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', end);
          handle.removeEventListener('pointercancel', end);
          if (!moved) return;
          dragged = true;
          report();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
      });
      return () => {
        const was = dragged;
        dragged = false;
        return was;
      };
    }

    draggable(header, 'button');
    const fabWasDragged = draggable(fab, null);
    collapse.addEventListener('click', () => setCollapsed(true));
    fab.addEventListener('click', () => {
      if (!fabWasDragged()) setCollapsed(false);
    });
    restore.addEventListener('click', () => send({ type: 'restore' }));

    let busyTimer = 0;
    function showStatus(tone, text) {
      clearTimeout(busyTimer);
      status.dataset.tone = tone;
      status.textContent = text;
      status.hidden = false;
      pick.setAttribute('aria-busy', String(tone === 'busy'));
      if (tone === 'busy') busyTimer = setTimeout(() => showStatus('error', '后台没有回应，图片没换上。'), BUSY_TIMEOUT_MS);
      render();
    }
    // watch answers an upload through this hook. It only sets text in this panel's own shadow root.
    Object.defineProperty(window, `${mark.key}Notice`, {
      configurable: true,
      value: (tone, text) => host.isConnected && ['ok', 'error', 'busy'].includes(tone) && showStatus(tone, String(text)),
    });

    pick.addEventListener('click', () => {
      if (pick.getAttribute('aria-busy') !== 'true') picker.click();
    });
    // Only the file the user picked is read here, never anything of the page.
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      if (!PICKABLE.test(file.name)) return showStatus('error', `「${file.name}」不是 jpg、png 或 webp 图片。`);
      if (file.size >= config.uploadLimit) {
        return showStatus('error', `「${file.name}」有 ${megabytes(file.size)}，超过了 ${config.uploadLimit / 1048576} MB 的上限，没有换。`);
      }
      showStatus('busy', `正在读取「${file.name}」…`);
      const reader = new FileReader();
      reader.onerror = () => showStatus('error', `读不了「${file.name}」。`);
      reader.onload = () => {
        const data = String(reader.result).slice(String(reader.result).indexOf(',') + 1);
        if (!send({ type: 'upload', name: file.name, data })) return showStatus('error', '后台的 watch 没在运行，图片没换上。');
        showStatus('busy', `正在换上「${file.name}」…`);
      };
      reader.readAsDataURL(file);
    });

    // Moving the slider changes the veil in place; letting go is what gets saved and sent to the other windows.
    const effectiveStrength = () => window[mark.key]?.inspect?.().strength ?? config.strength ?? 72;
    let sliding = false;
    const showStrength = (value) => {
      slider.value = String(value);
      strengthValue.textContent = String(value);
    };
    slider.addEventListener('pointerup', () => (sliding = false));
    slider.addEventListener('input', () => {
      sliding = true;
      const value = Number(slider.value);
      strengthValue.textContent = String(value);
      window[mark.key]?.setStrength?.(value);
    });
    slider.addEventListener('change', () => {
      sliding = false;
      send({ type: 'strength', value: Number(slider.value) });
    });
    showStrength(effectiveStrength());

    // Usage: drawn from the stored state only. Nothing read yet, or switched off: no ring and no figure.
    const viewOf = typeof usageViewFn === 'function' ? usageViewFn : () => null;
    let usageState = config.usage ?? null;
    let usageShown = '';
    function renderUsage() {
      usageSwitch.checked = usageState?.enabled !== false;
      const view = viewOf(usageState, Date.now(), config.usageLimits);
      const key = JSON.stringify(view);
      if (key === usageShown) return;
      usageShown = key;
      if (!view) {
        usageLabel.hidden = true;
        ring.setAttribute('hidden', '');
        badge.hidden = true;
        delete fab.dataset.usage;
        fab.title = '换壁纸';
        return;
      }
      shell.style.setProperty('--usage', view.tone === 'normal' ? 'var(--accent)' : config.usageLimits.colors[view.tone]);
      usageLabel.textContent = view.label;
      usageLabel.title = view.title;
      usageLabel.hidden = false;
      usageLabel.toggleAttribute('data-stale', view.stale);
      ringArc.setAttribute('stroke-dasharray', `${view.percent} 100`);
      ring.toggleAttribute('data-stale', view.stale);
      ring.dataset.tone = view.tone;
      ring.removeAttribute('hidden');
      badge.textContent = `${view.percent}%`;
      badge.toggleAttribute('data-stale', view.stale);
      badge.hidden = false;
      // Dark figures on a light badge, white on a dark one: the accent can be any colour.
      const [r, g, b] = (getComputedStyle(badge).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
      const scale = getComputedStyle(badge).backgroundColor.startsWith('rgb') ? 255 : 1;
      const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / scale;
      badge.style.setProperty('--badge-fg', brightness > 0.6 ? '#1b1d22' : '#fff');
      fab.dataset.usage = view.tone;
      fab.title = `换壁纸 · ${view.title}`;
    }
    usageSwitch.addEventListener('change', () => {
      const enabled = usageSwitch.checked;
      if (!send({ type: 'usage-toggle', enabled })) {
        usageSwitch.checked = !enabled;
        return;
      }
      usageState = { ...(usageState ?? {}), enabled };
      renderUsage();
    });
    // watch pushes every new reading through this hook. It only changes this panel's own nodes.
    Object.defineProperty(window, `${mark.key}Usage`, {
      configurable: true,
      value: (state) => {
        if (!host.isConnected) return false;
        usageState = state;
        renderUsage();
        return true;
      },
    });
    renderUsage();

    // Listeners clean themselves up once restore or a remount has taken the host out of the page.
    const onResize = () => host.isConnected && render();
    const timer = setInterval(() => {
      if (host.isConnected) {
        // The default strength follows a light/dark match the overlay may only settle on later.
        if (!sliding) showStrength(effectiveStrength());
        renderUsage();
        return syncMode();
      }
      clearInterval(timer);
      removeEventListener('resize', onResize);
    }, 1000);
    addEventListener('resize', onResize);

    syncMode();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
    return { deferred: true };
  }
  mount();
  return { deferred: false };
}

// Runs inside the page. Takes the panel out and leaves the wallpaper, for when watch stops and the panel would go dead.
export function panelUnmount(mark) {
  const nodes = document.querySelectorAll(`[${mark.attr}="panel"]`);
  for (const node of nodes) node.remove();
  delete window[`${mark.key}Notice`];
  delete window[`${mark.key}Usage`];
  return nodes.length;
}

// Runs inside the page. Shows watch's answer to an upload in the panel of the window that sent it.
export function panelNotice(tone, text, mark) {
  const notice = window[`${mark.key}Notice`];
  return typeof notice === 'function' ? Boolean(notice(tone, text)) : false;
}

export const panelNoticeExpression = (tone, text) => pageCall(panelNotice, tone, text, MARK);

// Runs inside the page. Hands a new usage state to the panel of this window, if it has one.
export function panelUsage(state, mark) {
  const hook = window[`${mark.key}Usage`];
  return typeof hook === 'function' ? Boolean(hook(state)) : false;
}

export const panelUsageExpression = (state) => pageCall(panelUsage, state, MARK);

const mountExpression = (panel) =>
  `(${panelMount})(${JSON.stringify({ usageLimits: usageLimits(), ...panel })}, ${JSON.stringify(MARK)}, ${usageView})`;

// Overlay first: a fresh overlayApply clears every marked node, the panel host included.
export const themedExpression = (overlay, panel) =>
  `(() => { const report = ${applyExpression(overlay)}; ${mountExpression(panel)}; return report; })()`;

// New-document scripts run in every frame of the window; only the top document gets a wallpaper and a panel.
export const themedNewDocumentScript = (overlay, panel) => `if (window === window.top) ${themedExpression(overlay, panel)};`;

export const panelUnmountExpression = () => pageCall(panelUnmount, MARK);
