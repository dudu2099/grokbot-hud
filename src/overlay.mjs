export const MARK = Object.freeze({ key: '__grokbotThemes', attr: 'data-grokbot-themes' });

export const SCAN = Object.freeze({
  minWidthRatio: 0.22,
  minHeightRatio: 0.45,
  minAreaRatio: 0.16,
  minAlpha: 0.85,
  // Wallpaper strength, 0 to 100: how much of the app's panel color is taken away. Used until the user moves the slider.
  strength: { matched: 72 },
  // A picture counts as dark or light only when its mean brightness (0 to 255) is clearly on one side.
  // In between it goes with whatever mode the app is in.
  tone: { darkBelow: 105, lightAbove: 150, sample: 24 },
  // Thinning the panels cannot save dark text on a dark picture: thin enough to see the picture, the text is gone.
  // So when picture and app are on opposite sides, the app is flipped to the picture's side instead:
  // lightness inverted and hue turned back, which is what a dark mode looks like. Pictures inside the app are flipped back.
  // On the root element a filter does not capture fixed-position descendants, so the app's own layout is untouched.
  flipFilter: 'invert(1) hue-rotate(180deg)',
  flipBack: 'img, video, canvas, svg image, [style*="url("]',
  strip: { minWidthRatio: 0.12, minHeightPx: 24 },
  // A solid block on the app's own side of light/dark (a white card in a light app) is surface, not content.
  // One painted the other way (a dark bubble with white text in a light app) is left alone, or its text would sit on the wallpaper.
  sameSideBlock: { minWidthRatio: 0.12, minHeightPx: 24 },
  // A block holding one of these is the frame around something you type into, and stays solid.
  formFields: 'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  // A scan runs once the page has been quiet this long, and at the latest this long after the first change it has not looked at.
  // A streaming answer never goes quiet, so the second number is how often a long reply gets looked at.
  quietMs: 120,
  maxWaitMs: 500,
  // How many thinned panels the cheap light/dark re-check reads the text color of.
  modeProbes: 6,
  // Reading lane. A picture whose background is one flat color (a poster, a diagram) can have things drawn right where the
  // replies sit. The strip behind the replies is then painted over with that background color, fading out at both sides:
  // the text sits on clean background and the rest of the picture stays whole. Other pictures get no lane.
  lane: {
    // The picture is read at this size. Its top and bottom rows say what the background color is.
    sample: [64, 40],
    edgeRows: 2,
    // Per channel, how far a pixel may be from that color and still count as background.
    tolerance: 14,
    // Flat means: this share of the edge rows, and this share of the whole picture (a photo with black bars fails the second).
    minEdgeShare: 0.8,
    minWholeShare: 0.45,
    // And the background has to be one color, not a dark sky that merely stays within the tolerance: of the pixels counted
    // as background, this share sits within flatTolerance of it. Measured: a flat poster 0.96, a painted night sky 0.40.
    flatTolerance: 4,
    minFlatShare: 0.8,
    // A reply block starts at the column's left edge (within edgeSlackPx) and is narrower than the column by narrowerByPx.
    minBlockPx: 200,
    minBlockHeightPx: 16,
    edgeSlackPx: 12,
    narrowerByPx: 60,
    depth: 6,
    // The lane reaches padPx past the replies at full strength and is gone fadePx past them.
    padPx: 12,
    fadePx: 90,
    // After the lane moved, one more look this much later: a sidebar sliding shut is still moving when the scan runs.
    recheckMs: 350,
  },
  skip: [
    'input',
    'textarea',
    'select',
    'button',
    'dialog',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="menuitem"]',
    '[role="listbox"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="tooltip"]',
    '[popover]',
  ].join(', '),
});

// Any computed CSS color to [r, g, b] in 0..255 sRGB, or null when it cannot be read. Chrome reports oklch(), oklab(), lab(),
// lch() and color(display-p3 ...) as written, so they are converted here instead of being read as unknown.
// Runs inside the page too (passed in as source), so it must not close over module scope.
export function colorToRgb(color) {
  const text = String(color ?? '').trim().toLowerCase();
  const open = text.indexOf('(');
  if (open < 0 || !text.endsWith(')')) return null;
  const fn = text.slice(0, open);
  const parts = text.slice(open + 1, -1).split('/')[0].trim().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  const num = (raw, percentOf = 1) => {
    if (raw === undefined) return NaN;
    if (raw === 'none') return 0;
    if (raw.endsWith('%')) return (parseFloat(raw) / 100) * percentOf;
    if (raw.endsWith('deg')) return parseFloat(raw);
    if (raw.endsWith('rad')) return (parseFloat(raw) * 180) / Math.PI;
    if (raw.endsWith('turn')) return parseFloat(raw) * 360;
    if (raw.endsWith('grad')) return parseFloat(raw) * 0.9;
    return parseFloat(raw);
  };
  const encode = (linear) => {
    const c = Math.max(0, Math.min(1, linear));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  const decode = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const times = (m, v) => [0, 1, 2].map((row) => m[row * 3] * v[0] + m[row * 3 + 1] * v[1] + m[row * 3 + 2] * v[2]);
  const XYZ65_TO_LINEAR_SRGB = [3.2409699419045226, -1.537383177570094, -0.4986107602930034, -0.9692436362808796, 1.8759675015077202, 0.04155505740717559, 0.05563007969699366, -0.20397695888897652, 1.0569715142428786];
  const D50_TO_D65 = [0.9554734527042182, -0.023098536874261423, 0.0632593086610217, -0.028369706963208136, 1.0099954580058226, 0.021041398966943008, 0.012314001688319899, -0.020507696433477912, 1.3303659366080753];
  const LINEAR_P3_TO_XYZ65 = [0.4865709486482162, 0.26566769316909306, 0.1982172852343625, 0.2289745640697488, 0.6917385218365064, 0.079286914093745, 0, 0.04511338185890264, 1.043944368900976];
  const fromLinear = (rgb) => (rgb.some((v) => !Number.isFinite(v)) ? null : rgb.map(encode));
  const fromXyz65 = (xyz) => fromLinear(times(XYZ65_TO_LINEAR_SRGB, xyz));
  const fromOklab = (L, a, b) => {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return fromLinear([
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ]);
  };
  const fromLab = (L, a, b) => {
    const k = 24389 / 27;
    const e = 216 / 24389;
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const x = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
    const y = L > k * e ? fy ** 3 : L / k;
    const z = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
    return fromXyz65(times(D50_TO_D65, [x * 0.9642956764295677, y, z * 0.8251046025104602]));
  };
  const polar = (C, H) => [C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  if (fn === 'rgb' || fn === 'rgba') {
    const rgb = parts.slice(0, 3).map((p) => num(p, 255));
    return rgb.length === 3 && rgb.every(Number.isFinite) ? rgb.map((v) => Math.max(0, Math.min(255, v))) : null;
  }
  if (fn === 'oklab') return fromOklab(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4));
  if (fn === 'oklch') return fromOklab(num(parts[0], 1), ...polar(num(parts[1], 0.4), num(parts[2])));
  if (fn === 'lab') return fromLab(num(parts[0], 100), num(parts[1], 125), num(parts[2], 125));
  if (fn === 'lch') return fromLab(num(parts[0], 100), ...polar(num(parts[1], 150), num(parts[2])));
  if (fn === 'color') {
    const [space, ...rest] = parts;
    const v = rest.slice(0, 3).map((p) => num(p, 1));
    if (v.length !== 3 || !v.every(Number.isFinite)) return null;
    if (space === 'srgb') return v.map((c) => 255 * Math.max(0, Math.min(1, c)));
    if (space === 'srgb-linear') return fromLinear(v);
    if (space === 'display-p3') return fromXyz65(times(LINEAR_P3_TO_XYZ65, v.map(decode)));
    if (space === 'xyz' || space === 'xyz-d65') return fromXyz65(v);
    if (space === 'xyz-d50') return fromXyz65(times(D50_TO_D65, v));
  }
  return null;
}

// Runs inside the page. Serialized with Function.prototype.toString, so it must not close over module scope.
export function overlayApply(params, scan, mark, toRgb) {
  const requestedStrength = params.strength ?? null;
  // The CLI's one-shot apply and watch's sync of the same record carry the same token; re-applying would flash the page.
  // A strength change on the same record is done in place for the same reason.
  const current = window[mark.key];
  if (current && current.token === params.token) {
    if (current.strength !== requestedStrength) current.setStrength(requestedStrength);
    return current.inspect();
  }

  const BASE_COLOR = { dark: '#0e1116', light: '#f7f5f0' };

  function start() {
    window[mark.key]?.teardown();
    for (const node of document.querySelectorAll(`[${mark.attr}]`)) node.remove();

    const html = document.documentElement;
    const skip = `${scan.skip}, [${mark.attr}]`;
    // element -> { attr, before, wrote, written, remix, source, panel }. remix(percent) gives the props for another strength.
    const touched = new Map();
    // The big panels among them: their text color is what the cheap light/dark re-check reads.
    const panels = new Set();

    function touch(el, props, remix) {
      let record = touched.get(el);
      if (!record) {
        record = { attr: el.getAttribute('style'), before: {}, wrote: {}, written: null, remix: null, source: null };
        touched.set(el, record);
      }
      if (remix) record.remix = remix;
      for (const [name, value] of Object.entries(props)) {
        if (!(name in record.before)) {
          record.before[name] = [el.style.getPropertyValue(name), el.style.getPropertyPriority(name)];
        }
        el.style.setProperty(name, value, 'important');
        record.wrote[name] = el.style.getPropertyValue(name);
      }
      record.written = el.getAttribute('style');
      return record;
    }

    function untouch(el, record) {
      if (el.getAttribute('style') === record.written) {
        if (record.attr === null) el.removeAttribute('style');
        else el.setAttribute('style', record.attr);
        return;
      }
      for (const [name, [value, priority]] of Object.entries(record.before)) {
        if (el.style.getPropertyValue(name) !== record.wrote[name]) continue;
        if (value) el.style.setProperty(name, value, priority);
        else el.style.removeProperty(name);
      }
      if (record.attr === null && el.getAttribute('style') === '') el.removeAttribute('style');
    }

    const drifted = (el, record) =>
      Object.entries(record.wrote).some(
        ([name, value]) => el.style.getPropertyValue(name) !== value || el.style.getPropertyPriority(name) !== 'important',
      );

    function alphaOf(color) {
      if (!color || color === 'transparent') return 0;
      const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
      if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
      const parts = /^rgba?\(([^)]*)\)$/.exec(color)?.[1].split(',');
      return parts?.length === 4 ? Number(parts[3]) : 1;
    }

    const lumaCache = new Map();
    function luma(color) {
      if (!lumaCache.has(color)) {
        const rgb = toRgb(color);
        if (lumaCache.size > 256) lumaCache.clear();
        lumaCache.set(color, rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null);
      }
      return lumaCache.get(color);
    }

    const sideOf = (value) => (value >= 128 ? 'light' : 'dark');
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

    // The app's own mode is read off what it paints: light panels mean light mode, whatever the theme pack asks for.
    // Before any panel exists, dark text stands in for light panels.
    function appAppearance(panelColors) {
      const lumas = panelColors.map(luma).filter((value) => value !== null);
      if (lumas.length) return sideOf(mean(lumas));
      const text = luma(getComputedStyle(document.body ?? html).color);
      if (text === null) return params.appearance === 'auto' ? 'light' : params.appearance;
      return text < 128 ? 'light' : 'dark';
    }

    // The cheap re-check: our inline colors hide the app's backgrounds, but not its text color. Dark text on the body and
    // on the thinned panels means a light app. Reading a handful of computed colors costs next to nothing.
    function textSide() {
      const probes = [document.body ?? html, ...[...panels].filter((el) => el.isConnected).slice(0, scan.modeProbes)];
      const lumas = probes.map((el) => luma(getComputedStyle(el).color)).filter((value) => value !== null);
      return lumas.length ? (mean(lumas) < 128 ? 'light' : 'dark') : null;
    }

    const mixed = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
    const remixColor = (color) => (percent) => ({ 'background-color': mixed(color, percent) });
    const clear = () => ({ 'background-color': 'transparent' });

    // Inside a thinned element of the same color, something was invisible before; it goes clear so it stays invisible,
    // instead of keeping a solid patch or stacking a second veil.
    function sameColorAbove(el, color, picked) {
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        if ((touched.get(up)?.source ?? picked.get(up)) === color) return true;
      }
      return false;
    }

    // A bar or fade painted in the exact color of a panel we already thinned is the same surface, just too small to pass the panel test.
    function stripRemix(el, style, surfaces, picked) {
      const color = style.backgroundColor;
      const image = style.backgroundImage.includes('gradient(') ? style.backgroundImage : null;
      const colorHit = surfaces.has(color);
      const imageHit = image !== null && [...surfaces].some((surface) => image.includes(surface));
      if (!colorHit && !imageHit) return null;
      if (colorHit && style.backgroundImage === 'none' && sameColorAbove(el, color, picked)) return { remix: clear, source: color };
      return {
        source: colorHit && !imageHit ? color : null,
        remix: (percent) => {
          const props = {};
          if (colorHit) props['background-color'] = mixed(color, percent);
          if (imageHit) {
            let next = image;
            for (const surface of surfaces) next = next.replaceAll(surface, mixed(surface, percent));
            props['background-image'] = next;
          }
          return props;
        },
      };
    }

    // An opaque block on the app's own side of light/dark that does not frame a form field.
    // Returns a remix for it, or null to leave it alone.
    function sameSideBlock(el, style, appearance, picked) {
      if (style.backgroundImage !== 'none' || alphaOf(style.backgroundColor) < scan.minAlpha) return null;
      const value = luma(style.backgroundColor);
      if (value === null || sideOf(value) !== appearance) return null;
      if (el.querySelector(scan.formFields)) return null;
      return sameColorAbove(el, style.backgroundColor, picked) ? clear : remixColor(style.backgroundColor);
    }

    // One pass over `elements`: every element's box is read once. Big solid ones are panel hits; the rest that are big
    // enough to be a strip or a block are kept, with their box and style, for the second look once the panel colors are known.
    function examine(elements) {
      const viewWidth = innerWidth;
      const viewHeight = innerHeight;
      const hits = [];
      const candidates = [];
      for (const el of elements) {
        if (touched.has(el)) continue;
        const rect = el.getBoundingClientRect();
        const stripSized = rect.width >= viewWidth * scan.strip.minWidthRatio && rect.height >= scan.strip.minHeightPx;
        const panelSized =
          rect.width >= viewWidth * scan.minWidthRatio &&
          rect.height >= viewHeight * scan.minHeightRatio &&
          rect.width * rect.height >= viewWidth * viewHeight * scan.minAreaRatio;
        if (!stripSized && !panelSized) continue;
        if (el.isContentEditable || el.closest(skip)) continue;
        const style = getComputedStyle(el);
        if (style.visibility !== 'visible') continue;
        if (panelSized && style.backgroundImage === 'none' && alphaOf(style.backgroundColor) >= scan.minAlpha) {
          hits.push([el, style.backgroundColor]);
          continue;
        }
        if (stripSized) candidates.push([el, rect, style]);
      }
      return { hits, candidates };
    }

    function thinPanels(hits, percent) {
      for (const [el, color] of hits) {
        surfaces.add(color);
        panels.add(el);
        touch(el, { 'background-color': mixed(color, percent) }, remixColor(color)).source = color;
      }
    }

    function thinSmall(candidates, percent) {
      const viewWidth = innerWidth;
      const small = [];
      const picked = new Map();
      for (const [el, rect, style] of candidates) {
        if (touched.has(el)) continue;
        const strip = surfaces.size ? stripRemix(el, style, surfaces, picked) : null;
        const blockSized = rect.width >= viewWidth * scan.sameSideBlock.minWidthRatio && rect.height >= scan.sameSideBlock.minHeightPx;
        const block = !strip && blockSized ? sameSideBlock(el, style, state.appAppearance, picked) : null;
        const found = strip ?? (block && { remix: block, source: style.backgroundColor });
        if (!found) continue;
        small.push([el, found]);
        if (found.source) picked.set(el, found.source);
      }
      for (const [el, { remix, source }] of small) touch(el, remix(percent), remix).source = source;
    }

    // 'dark' or 'light' once known, 'mid' for a picture that is neither, null while a picked picture is still being measured.
    let imageTone = params.appearance === 'dark' || params.appearance === 'light' ? params.appearance : null;
    let flipSheet = null;

    function pixelsOf(picture, width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(picture, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    }

    // The picture's background color as 'rgb(r, g, b)' when it has one flat background, otherwise null.
    function flatBackground(picture) {
      const [width, height] = scan.lane.sample;
      const pixels = pixelsOf(picture, width, height);
      const at = (x, y) => [0, 1, 2].map((channel) => pixels[(y * width + x) * 4 + channel]);
      const edge = [];
      for (let row = 0; row < scan.lane.edgeRows; row++) for (let x = 0; x < width; x++) edge.push(at(x, row), at(x, height - 1 - row));
      const median = [0, 1, 2].map((channel) => edge.map((pixel) => pixel[channel]).sort((a, b) => a - b)[edge.length >> 1]);
      const isBackground = (pixel) => pixel.every((value, channel) => Math.abs(value - median[channel]) <= scan.lane.tolerance);
      const edgeHits = edge.filter(isBackground);
      if (edgeHits.length < edge.length * scan.lane.minEdgeShare) return null;
      const isFlat = (pixel) => pixel.every((value, channel) => Math.abs(value - median[channel]) <= scan.lane.flatTolerance);
      let whole = 0;
      let flatCount = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pixel = at(x, y);
          if (!isBackground(pixel)) continue;
          whole++;
          if (isFlat(pixel)) flatCount++;
        }
      }
      if (whole < width * height * scan.lane.minWholeShare) return null;
      if (flatCount < whole * scan.lane.minFlatShare) return null;
      return `rgb(${[0, 1, 2].map((channel) => Math.round(mean(edgeHits.map((pixel) => pixel[channel])))).join(', ')})`;
    }

    // Read once per picture: its tone, when the theme did not say, and whether its background is one flat color.
    function measurePicture() {
      const probe = new Image();
      probe.onload = () => {
        if (window[mark.key] !== state) return;
        if (imageTone === null) {
          const size = scan.tone.sample;
          const pixels = pixelsOf(probe, size, size);
          let sum = 0;
          for (let i = 0; i < pixels.length; i += 4) sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
          const brightness = sum / (pixels.length / 4);
          imageTone = brightness < scan.tone.darkBelow ? 'dark' : brightness > scan.tone.lightAbove ? 'light' : 'mid';
          settleSide();
        }
        flat = flatBackground(probe);
        updateLane(true);
      };
      probe.src = params.dataUrl;
    }

    // ---- reading lane: positions only, no text is read ----
    let flat = null;
    let laneColumn = null;
    let laneKey = '';
    let laneRight = 0;
    let laneTimer = 0;

    const scrollsDown = (el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 4;
    };

    // The column the conversation runs in: above the field the user types into there is a tall scrolling area, and inside
    // it the first thing narrower than the area itself.
    function findColumn() {
      const fields = [...document.querySelectorAll(scan.formFields)]
        .filter((el) => !el.closest(`[${mark.attr}]`))
        .map((el) => el.getBoundingClientRect())
        .filter((box) => box.width >= scan.lane.minBlockPx && box.height > 0);
      if (!fields.length) return null;
      const field = fields.sort((a, b) => b.bottom - a.bottom)[0];
      const y = Math.min(innerHeight * 0.4, field.top - 8);
      if (y <= 0) return null;
      const scroller = document
        .elementsFromPoint(field.left + field.width / 2, y)
        .find((el) => el !== html && el !== document.body && !el.closest(`[${mark.attr}]`) && el.getBoundingClientRect().height >= innerHeight * 0.5 && scrollsDown(el));
      if (!scroller) return null;
      const outer = scroller.getBoundingClientRect().width;
      for (let el = scroller, level = 0; level < scan.lane.depth && el.children.length; level++) {
        const next = [...el.children].sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
        const width = next.getBoundingClientRect().width;
        if (width < scan.lane.minBlockPx) break;
        if (width < outer - 8) return next;
        el = next;
      }
      return scroller;
    }

    // How far right the replies on screen reach, and whether there is anything on screen at all.
    function repliesIn(column, box) {
      let right = 0;
      let any = false;
      const walk = (el, level) => {
        for (const child of el.children) {
          const rect = child.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > innerHeight || rect.width < scan.lane.minBlockPx || rect.height < scan.lane.minBlockHeightPx) continue;
          any = true;
          if (Math.abs(rect.left - box.left) <= scan.lane.edgeSlackPx && rect.width <= box.width - scan.lane.narrowerByPx) right = Math.max(right, rect.right);
          if (level < scan.lane.depth) walk(child, level + 1);
        }
      };
      walk(column, 1);
      return { right, any };
    }

    // refind: look for the column again even if the one from last time is still there (first look, resize, new picture).
    function updateLane(refind = false) {
      clearTimeout(laneTimer);
      laneTimer = 0;
      let next = null;
      if (flat) {
        if (refind || !laneColumn?.isConnected || laneColumn.getBoundingClientRect().width < scan.lane.minBlockPx) laneColumn = findColumn();
        if (laneColumn) {
          const box = laneColumn.getBoundingClientRect();
          const key = `${innerWidth}:${Math.round(box.left)}:${Math.round(box.width)}`;
          if (key !== laneKey) {
            laneKey = key;
            laneRight = 0;
          }
          // Only ever wider within one layout, so scrolling past a short reply does not make the edge jump.
          const replies = repliesIn(laneColumn, box);
          laneRight = Math.max(laneRight, replies.right);
          const right = laneRight || (replies.any ? box.right : 0);
          if (right) next = { left: Math.round(box.left), right: Math.round(right), color: flat };
        }
      }
      if (JSON.stringify(next) === JSON.stringify(state.lane)) return;
      state.lane = next;
      if (next) {
        const { padPx, fadePx } = scan.lane;
        const mask = `linear-gradient(to right, transparent ${next.left - fadePx}px, #000 ${next.left - padPx}px, #000 ${next.right + padPx}px, transparent ${next.right + fadePx}px)`;
        lane.style.cssText = `position:absolute;inset:0;background:${next.color};-webkit-mask-image:${mask};mask-image:${mask};`;
      } else {
        lane.style.cssText = 'display:none;';
      }
      laneTimer = setTimeout(updateLane, scan.lane.recheckMs);
    }

    // Puts the app on the picture's side, or back on its own. Runs every time the app's own side has been worked out.
    function settleSide() {
      const side = imageTone === 'dark' || imageTone === 'light' ? imageTone : state.appAppearance;
      if (side) layer.style.backgroundColor = BASE_COLOR[side];
      const want = (imageTone === 'dark' || imageTone === 'light') && state.appAppearance !== null && imageTone !== state.appAppearance;
      state.imageTone = imageTone;
      if (want === state.flipped) return;
      state.flipped = want;
      if (want) {
        flipSheet = new CSSStyleSheet();
        const ours = `:root > [${mark.attr}]`;
        const media = scan.flipBack.split(',').map((part) => `${part.trim()}:not([${mark.attr}], [${mark.attr}] *)`).join(', ');
        flipSheet.replaceSync(`:root { filter: ${scan.flipFilter} !important; --grokbot-themes-flip: ${scan.flipFilter}; } ${ours}, ${media} { filter: ${scan.flipFilter} !important; }`);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, flipSheet];
      } else {
        dropFlip();
      }
    }

    function dropFlip() {
      if (flipSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== flipSheet);
      flipSheet = null;
    }

    const layer = document.createElement('div');
    layer.setAttribute(mark.attr, 'layer');
    const baseColor = BASE_COLOR[params.appearance] ?? BASE_COLOR.light;
    layer.style.cssText = `position:fixed;inset:0;z-index:-2147483647;pointer-events:none;background:${baseColor};`;
    const image = document.createElement('div');
    image.setAttribute(mark.attr, 'image');
    image.style.cssText = `position:absolute;inset:0;background:center / cover no-repeat url("${params.dataUrl}");opacity:${params.opacity};`;
    layer.append(image);
    // Inside the picture, so it shares the picture's opacity and the color matches.
    const lane = document.createElement('div');
    lane.setAttribute(mark.attr, 'lane');
    lane.style.cssText = 'display:none;';
    image.append(lane);

    const surfaces = new Set();
    let userStrength = requestedStrength;
    const state = {
      token: params.token,
      timer: 0,
      appAppearance: null,
      textSide: null,
      imageTone,
      flipped: false,
      // { left, right, color } while the strip behind the replies is painted over, otherwise null.
      lane: null,
      percent: null,
      strength: userStrength,
      setStrength,
      teardown,
      inspect: () => report(state, touched),
    };
    const percentFor = () => 100 - (userStrength ?? scan.strength.matched);

    // What the next scan has to look at. Added subtrees and elements whose class or style changed go here;
    // a full pass is only owed on the first scan, a resize, or a change of the app's light/dark mode.
    const pendingRoots = new Set();
    const changedAttributes = new Set();
    let fullOwed = true;
    let modeCheckOwed = false;
    let firstPendingAt = 0;

    // Quiet for quietMs, or maxWaitMs since the first change nobody has looked at yet, whichever comes first.
    function schedule() {
      const now = performance.now();
      if (!firstPendingAt) firstPendingAt = now;
      clearTimeout(state.timer);
      state.timer = setTimeout(scanNow, Math.max(0, Math.min(scan.quietMs, firstPendingAt + scan.maxWaitMs - now)));
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) if (node.nodeType === 1) pendingRoots.add(node);
        } else {
          pendingRoots.add(record.target);
          changedAttributes.add(record.target);
        }
      }
      schedule();
    });
    // An app switching its own light or dark mode shows up as an attribute on the root or a new stylesheet in <head>.
    // Neither forgets anything by itself: they only ask for the cheap re-check.
    const modeObserver = new MutationObserver(() => {
      modeCheckOwed = true;
      schedule();
    });
    const onResize = () => {
      fullOwed = true;
      schedule();
    };

    function forget() {
      for (const [el, record] of touched) untouch(el, record);
      touched.clear();
      panels.clear();
      surfaces.clear();
    }

    // Anything the app took back (its own inline color) or took away is let go, so the next look sees the app's real color.
    function dropDrifted() {
      for (const [el, record] of touched) {
        if (el.isConnected && !drifted(el, record)) continue;
        untouch(el, record);
        touched.delete(el);
        panels.delete(el);
      }
    }

    function settle() {
      observer.takeRecords();
      modeObserver.takeRecords();
    }

    function fullScan() {
      dropDrifted();
      const body = document.body;
      const { hits, candidates } = examine(body ? body.getElementsByTagName('*') : []);

      state.appAppearance = appAppearance([...surfaces, ...hits.map(([, color]) => color)]);
      const percent = percentFor();
      if (state.percent !== null && state.percent !== percent && touched.size) {
        state.percent = percent;
        forget();
        return fullScan();
      }
      state.percent = percent;

      if (!layer.isConnected) html.append(layer);
      // The app's side was just worked out again (first look, resize, or its own mode switch): the flip follows it.
      settleSide();
      if (!touched.has(html)) {
        touch(html, { 'background-color': 'transparent', 'background-image': 'none', 'color-scheme': state.appAppearance });
      }
      if (body && !touched.has(body)) touch(body, { 'background-color': 'transparent', 'background-image': 'none' });
      thinPanels(hits, percent);
      thinSmall(candidates, state.percent);
      state.textSide = textSide();
      updateLane(true);
      settle();
    }

    // Only what changed: each added subtree, and each element whose class or style changed, with its subtree.
    function partialScan(roots) {
      const body = document.body;
      dropDrifted();
      if (!body || !touched.has(body) || !layer.isConnected) return fullScan();
      const seen = new Set();
      const elements = [];
      for (const root of roots) {
        if (!root.isConnected || !body.contains(root) || root.closest(`[${mark.attr}]`)) continue;
        if (!seen.has(root)) {
          seen.add(root);
          elements.push(root);
        }
        for (const el of root.getElementsByTagName('*')) {
          if (seen.has(el)) continue;
          seen.add(el);
          elements.push(el);
        }
      }
      if (elements.length) {
        const { hits, candidates } = examine(elements);
        // A panel in a color not seen before can make strips elsewhere count as the same surface; only a full pass finds those.
        if (hits.some(([, color]) => !surfaces.has(color))) return fullScan();
        thinPanels(hits, state.percent);
        thinSmall(candidates, state.percent);
      }
      updateLane();
      settle();
    }

    function scanNow() {
      state.timer = 0;
      firstPendingAt = 0;
      const roots = [...pendingRoots];
      const attributes = [...changedAttributes];
      pendingRoots.clear();
      changedAttributes.clear();
      const body = document.body;
      if (fullOwed) {
        fullOwed = false;
        modeCheckOwed = false;
        return fullScan();
      }
      // A class or style change on the body, the root, or anything that holds a thinned panel may be the app changing modes.
      if (!modeCheckOwed) modeCheckOwed = attributes.some((el) => el === body || el === html || [...panels].some((panel) => el.contains(panel)));
      if (modeCheckOwed) {
        modeCheckOwed = false;
        // Our own inline colors hide a mode switch from the scan, so a real one starts over from the app's real colors.
        if (textSide() !== state.textSide) {
          forget();
          return fullScan();
        }
      }
      if (roots.includes(body) || roots.includes(html)) return fullScan();
      return partialScan(roots);
    }

    // The slider calls this on every move: the same layer, the same touched elements, only their mix changes.
    function setStrength(value) {
      userStrength = value;
      state.strength = value;
      const percent = percentFor();
      if (percent !== state.percent) {
        state.percent = percent;
        for (const [el, record] of touched) if (record.remix && el.isConnected) touch(el, record.remix(percent));
        settle();
      }
      return report(state, touched);
    }

    function teardown() {
      observer.disconnect();
      modeObserver.disconnect();
      removeEventListener('resize', onResize);
      clearTimeout(state.timer);
      clearTimeout(laneTimer);
      pendingRoots.clear();
      changedAttributes.clear();
      const restored = touched.size;
      for (const [el, record] of touched) untouch(el, record);
      touched.clear();
      panels.clear();
      dropFlip();
      layer.remove();
      delete window[mark.key];
      return restored;
    }

    window[mark.key] = state;
    fullOwed = false;
    fullScan();
    measurePicture();
    observer.observe(html, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
    modeObserver.observe(html, { attributes: true });
    if (document.head) modeObserver.observe(document.head, { childList: true });
    addEventListener('resize', onResize);
    return report(state, touched);
  }

  function report(state, touched) {
    const panels = [...touched.keys()].filter((el) => el !== document.documentElement && el !== document.body).length;
    return {
      token: state.token,
      deferred: false,
      panels,
      appAppearance: state.appAppearance,
      imageTone: state.imageTone,
      flipped: state.flipped,
      lane: state.lane,
      strength: state.percent === null ? null : 100 - state.percent,
      strengthSet: state.strength !== null,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    return { token: params.token, deferred: true, panels: 0, appAppearance: null, imageTone: null, flipped: false, strength: null, strengthSet: requestedStrength !== null };
  }
  return start();
}

// Runs inside the page, same serialization rule as overlayApply.
export function overlayRestore(mark) {
  const state = window[mark.key];
  const restored = state ? state.teardown() : 0;
  for (const node of document.querySelectorAll(`[${mark.attr}]`)) node.remove();
  const remaining = document.querySelectorAll(`[${mark.attr}]`).length + (window[mark.key] ? 1 : 0);
  return { hadOverlay: Boolean(state), restored, remaining };
}

// Runs inside the page. Reads back what a deferred apply settled on once the app finished booting.
export function overlayInspect(mark) {
  return window[mark.key]?.inspect() ?? null;
}

export const pageCall = (fn, ...args) => `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;

// overlayApply also gets colorToRgb, as source, since the page has no other way to read oklch() and friends.
export const applyExpression = (params) => `(${overlayApply})(${JSON.stringify(params)}, ${JSON.stringify(SCAN)}, ${JSON.stringify(MARK)}, ${colorToRgb})`;

export const restoreExpression = () => pageCall(overlayRestore, MARK);

export const inspectExpression = () => pageCall(overlayInspect, MARK);
