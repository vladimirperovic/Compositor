// Darkroom in the browser. The filters themselves are the desktop app's C core compiled to WebAssembly;
// this file is only the page around them: opening an image, keeping a screen-sized preview responsive,
// cropping, and handing the full resolution to the encoder when the image is saved.
import { EFFECTS, GROUPS, ORDER, PRESETS, byKind, freshSettings, isNeutral, settingsFor } from './effects.js?v=%%V%%';

const PREVIEW_LIMIT = 3_500_000;  // preview pixels; beyond this the screen copy is scaled down further

const el = id => document.getElementById(id);
const canvas = el('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });

const state = {
  source: null,        // { width, height, data } straight alpha, full resolution
  opaque: true,
  preview: null,       // the same image at screen size
  previewScale: 1,
  settings: freshSettings(),
  selected: 0,
  seed: (Math.random() * 1e9) | 0,
  zoom: 'fit',
  cropping: false,
  cropRect: null,
  draft: null,         // half-size preview, used while a slider is moving
  draftScale: 1,
  quick: false,
  shown: null,         // { data, width, height } the last filtered frame, kept for comparing
  split: true,         // the vertical line: original on its left, filtered on its right
  splitAt: 0.5,
  holding: false,      // pressing on the image shows the original underneath
  fullResult: null,    // { signature, data } so saving and 100% do not repeat the same work
};

// Filters ---------------------------------------------------------------

function activeStack(scale) {
  const values = [];
  let count = 0;
  for (const kind of ORDER) {
    const p = state.settings[kind];
    if (isNeutral(kind, p)) continue;
    const effect = byKind(kind);
    const radius = effect.radius ? p.radius * scale : p.radius;
    values.push(kind, p.amount / 100, p.shadows / 100, p.midtones / 100, p.highlights / 100,
      radius, p.saturation / 100, p.palette, p.contrastType,
      p.protectShadows / 100, p.protectHighlights / 100, state.seed, scale,
      p.tintShadows / 100, p.tintMidtones / 100, p.tintHighlights / 100);
    count += 1;
  }
  return { values: new Float32Array(values), count };
}

// The filters live in workers, one per core. An image is cut into horizontal bands and each worker takes
// one; because the core can process a region of a larger image — and says through dk_reach how many rows
// of neighbours a band needs to come out identical to the whole — the bands can simply be sewn back
// together. This is how the page uses every core without shared memory or cross-origin isolation.
const SLOTS = 16;   // floats per effect, matching DK_SLOTS in darkroom.c
const POOL_SIZE = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

const pool = [];
let nextJob = 1;
const pending = new Map();

function startWorkers() {
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const worker = new Worker(new URL('./worker.js?v=%%V%%', import.meta.url));
    worker.addEventListener('message', event => {
      const { id, ok, hello } = event.data;
      if (hello) return;
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      if (ok) job.resolve(event.data);
      else job.reject(new Error(event.data.error));
    });
    worker.addEventListener('error', () => {
      for (const job of pending.values()) job.reject(new Error('The filters stopped unexpectedly.'));
      pending.clear();
    });
    pool.push(worker);
  }
}

function ask(worker, message, transfer = []) {
  const id = nextJob += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

// Stack signature → the steps it really runs, and each step's reach. A slider passing through a hundred
// values leaves a hundred of these behind, so the oldest are dropped; they are cheap to ask for again.
const stacks = new Map();

async function stagesFor(values) {
  const key = String(values);
  if (!stacks.has(key)) {
    stacks.set(key, await ask(pool[0], { op: 'expand', values }));
    for (const old of [...stacks.keys()].slice(0, -64)) stacks.delete(old);
  }
  return stacks.get(key);
}

/// How to cut the image up for one step. A band carries `margin` extra rows above and below, so what a
/// core saves is h / (h/n + 2·margin) — still worth it with a wide margin, as long as a band is not
/// mostly overlap.
function planBands(height, margin) {
  const room = Math.max(1, Math.floor(height / 48));
  const overlapBound = Math.max(1, Math.floor((3 * height) / Math.max(1, 2 * margin)));
  const count = Math.max(1, Math.min(pool.length, room, overlapBound));
  const bands = [];
  for (let i = 0; i < count; i += 1) {
    bands.push({ from: Math.round((height * i) / count), to: Math.round((height * (i + 1)) / count) });
  }
  return bands;
}

/// One step of the stack, spread across the pool. `place` says where these pixels sit inside the whole
/// image, so a crop of it gets the same vignette, grain and fringe as the whole would.
async function applyStage(data, width, height, values, margin, place) {
  const bands = planBands(height, margin);
  const common = { op: 'apply', width, fullWidth: place.fullWidth, fullHeight: place.fullHeight,
                   offsetX: place.x, values, opaque: state.opaque };

  if (bands.length === 1) {
    const copy = new Uint8ClampedArray(data);   // a worker takes ownership of whatever it is sent
    const done = await ask(pool[0], { ...common, buffer: copy.buffer, height, offsetY: place.y }, [copy.buffer]);
    return new Uint8ClampedArray(done.buffer);
  }

  const row = width * 4;
  const jobs = bands.map((band, index) => {
    const top = Math.max(0, band.from - margin);
    const bottom = Math.min(height, band.to + margin);
    const slice = data.slice(top * row, bottom * row);
    return ask(pool[index % pool.length],
               { ...common, buffer: slice.buffer, height: bottom - top, offsetY: place.y + top },
               [slice.buffer]);
  });

  const output = new Uint8ClampedArray(width * height * 4);
  const results = await Promise.all(jobs);
  results.forEach((done, index) => {
    const band = bands[index];
    const top = Math.max(0, band.from - margin);
    const processed = new Uint8ClampedArray(done.buffer);
    output.set(processed.subarray((band.from - top) * row, (band.to - top) * row), band.from * row);
  });
  return output;
}

// What each step produced, for the screen-sized preview and for the half-size draft a moving slider gets.
// Changing one filter then starts from the step before it instead of redoing the stack — the same trick
// the desktop app plays. Two images are kept (preview and draft) within a budget; once it is spent, the
// later steps are simply not remembered, which still leaves the expensive early ones cached.
const CACHE_BUDGET = Math.min(96, Math.max(24, (navigator.deviceMemory || 4) * 12)) << 20;
const caches = new Map();

function cacheFor(token) {
  if (!caches.has(token)) {
    caches.set(token, { keys: [], images: [] });
    for (const old of [...caches.keys()].slice(0, -2)) caches.delete(old);
  }
  return caches.get(token);
}

async function totalReach(scale) {
  const stack = activeStack(scale);
  if (!stack.count) return 0;
  const { reaches } = await stagesFor(stack.values);
  return reaches.reduce((sum, reach) => sum + reach, 0) + 2;
}

// What the last render cost, for looking into speed without a profiler.
const reportTiming = timing => { window.__darkroom = { pool: pool.length, ...timing }; };

/// Runs the active filters over `data`, in the processor's premultiplied pixels, one step at a time.
/// `keep` names an image whose steps are worth remembering (the preview); a one-off render leaves it out.
async function process(data, width, height, scale, keep = null,
                       place = { x: 0, y: 0, fullWidth: width, fullHeight: height }) {
  const stack = activeStack(scale);
  if (!stack.count) return data;
  const { steps, reaches } = await stagesFor(stack.values);
  if (!reaches.length) return data;   // the processor found nothing to do after all
  // Steps that read no neighbours cost nothing to run together, and running them together saves a copy
  // of the image and a round trip each. Steps that blur stay on their own, so each is cached separately.
  const runs = [];
  for (let i = 0; i < reaches.length; i += 1) {
    const last = runs[runs.length - 1];
    // Two rows of slack on anything that blurs; a step that reads nothing needs no overlap at all.
    const margin = reaches[i] ? reaches[i] + 2 : 0;
    if (margin === 0 && last && last.margin === 0) last.steps.push(i);
    else runs.push({ margin, steps: [i] });
  }
  const total = runs.length;
  const token = keep ? `${keep}|${width}x${height}|${state.seed}` : null;

  const keys = [];
  let running = '';
  for (const run of runs) {
    for (const step of run.steps) running += '|' + steps.subarray(step * SLOTS, (step + 1) * SLOTS).join(',');
    keys.push(running);
  }

  const kept = token ? cacheFor(token) : null;
  let from = 0;
  let current = data;
  let stored = 0;
  if (kept) {
    while (from < total && kept.keys[from] === keys[from] && kept.images[from]) {
      current = kept.images[from];
      stored += current.length;
      from += 1;
    }
  }

  const started = performance.now();
  for (let i = from; i < total; i += 1) {
    const run = runs[i];
    const values = new Float32Array(run.steps.length * SLOTS);
    run.steps.forEach((step, at) => values.set(steps.subarray(step * SLOTS, (step + 1) * SLOTS), at * SLOTS));
    current = await applyStage(current, width, height, values, run.margin, place);
    if (!kept) continue;
    const room = stored + current.length <= CACHE_BUDGET;
    kept.keys[i] = room ? keys[i] : null;
    kept.images[i] = room ? current : null;
    if (room) stored += current.length;
  }
  if (kept) {
    kept.keys.length = total;
    kept.images.length = total;
  }
  reportTiming({ runs: total, steps: reaches.length, reused: from,
                  ms: +(performance.now() - started).toFixed(1) });
  return current;
}

const isOpaque = data => {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
};

const signature = scale => JSON.stringify([scale, state.seed, activeStack(scale).values]);

// Drawing ---------------------------------------------------------------

/// The room the image has on screen, with the floating panel and the toolbar already taken out.
function viewBox() {
  const stage = el('stage');
  const style = getComputedStyle(stage);
  const w = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const h = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return { w: Math.max(240, w), h: Math.max(200, h) };
}

const pixelRatio = () => Math.min(2, window.devicePixelRatio || 1);

/// A canvas to work on out of sight. OffscreenCanvas where there is one, and a plain detached canvas
/// where there is not — Safari only got OffscreenCanvas in 16.4, and nothing here needs more than a 2D
/// context and a way out to a file.
function scratchCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const toBlob = (canvas, type, quality) => (canvas.convertToBlob
  ? canvas.convertToBlob({ type, quality })
  : new Promise((resolve, reject) => canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('This image could not be encoded.'))), type, quality)));

/// Whether either panel is scrolled short of its end, so the chevron can say there is more.
function scrollHints() {
  for (const id of ['panel', 'inspector']) {
    const box = el(id);
    box.classList.toggle('has-more', box.scrollHeight - box.scrollTop - box.clientHeight > 4);
  }
}

/// Whether the tool sits inside a page of its own (the standalone one) or inside the site, between its
/// header and footer — in which case it does not take the window until it is asked to.
const insidePage = () => document.getElementById('darkroom')?.dataset.chrome === 'page';

/// A link that ends in #edit asks for the window straight away: the first image, the example included, opens
/// in the editing view instead of waiting in the page. The mark is taken off the address at once, so a reload
/// or a shared link brings back the page, and Back leads to wherever the link was.
let takeWindow = location.hash === '#edit';
if (takeWindow) history.replaceState(history.state, '', location.pathname + location.search);

/// The editing view: the image over the whole window, filters beside it. Leaving keeps the image loaded
/// and gives the page back, with one button to step into it again.
function enterEditing() {
  document.body.classList.add('editing');
  el('leave').querySelector('span').textContent = 'Close';
  // On a phone the sheet would cover the picture, so it starts out of the way behind its own button.
  const away = window.innerWidth <= 1080;
  document.body.classList.toggle('panel-hidden', away);
  el('panelToggle').classList.toggle('active', !away);
  el('compare').classList.toggle('active', state.split);
  measureChrome();
  if (state.source) { buildPreview(); schedule(); }
}

function leave() {
  document.body.classList.remove('editing');
  el('leave').querySelector('span').textContent = 'Edit image';
  measureChrome();
  if (state.source) { buildPreview(); schedule(); }
}

/// The toolbar wraps to two rows on a narrow screen, so the panel and the image are told how tall it is.
function measureChrome() {
  document.documentElement.style.setProperty('--toolbar-height', `${el('toolbar').offsetHeight}px`);
}

function buildPreview() {
  const { width, height } = state.source;
  const box = viewBox();
  const dpr = pixelRatio();
  const room = box.w * dpr;
  const tall = box.h * dpr;
  let scale = Math.min(1, room / width, tall / height);
  if (width * height * scale * scale > PREVIEW_LIMIT) scale = Math.sqrt(PREVIEW_LIMIT / (width * height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const scratch = scratchCanvas(w, h);
  const paint = scratch.getContext('2d', { willReadFrequently: true });
  const whole = new ImageData(state.source.data, width, height);
  if (w === width && h === height) {
    paint.putImageData(whole, 0, 0);
  } else {
    // Downscaling needs drawImage, and drawImage needs a canvas to read from.
    const full = scratchCanvas(width, height);
    full.getContext('2d').putImageData(whole, 0, 0);
    paint.imageSmoothingQuality = 'high';
    paint.drawImage(full, 0, 0, w, h);
  }
  state.preview = paint.getImageData(0, 0, w, h);
  state.previewScale = w / width;
  state.previewToken = (state.previewToken || 0) + 1;

  // A half-size copy carries the image while a slider is moving: four times fewer pixels to filter,
  // and the full preview comes back the moment the slider is let go.
  const dw = Math.max(1, Math.round(w / 2));
  const dh = Math.max(1, Math.round(h / 2));
  const small = scratchCanvas(dw, dh);
  const drawn = small.getContext('2d', { willReadFrequently: true });
  drawn.imageSmoothingQuality = 'high';
  drawn.drawImage(scratch, 0, 0, dw, dh);
  state.draft = drawn.getImageData(0, 0, dw, dh);
  state.draftScale = dw / width;
}

function show(data, width, height, region = null) {
  state.shown = { data, width, height, region };
  paint();
}

/// The part of the image on screen at 100%, with the margin the stack reads around it — or nothing when
/// the whole image is barely bigger than that, in which case processing all of it is the simpler job.
async function visiblePiece() {
  const stage = el('stage');
  const { width, height } = state.source;
  const margin = await totalReach(1);
  const x = Math.max(0, Math.floor(stage.scrollLeft) - margin);
  const y = Math.max(0, Math.floor(stage.scrollTop) - margin);
  const right = Math.min(width, Math.ceil(stage.scrollLeft + stage.clientWidth) + margin);
  const bottom = Math.min(height, Math.ceil(stage.scrollTop + stage.clientHeight) + margin);
  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0 || w * h * 1.6 > width * height) return null;
  const row = width * 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let line = 0; line < h; line += 1) {
    data.set(state.source.data.subarray((y + line) * row + x * 4, (y + line) * row + (x + w) * 4), line * w * 4);
  }
  return { data, x, y, w, h };
}

/// How wide the image is drawn: filling the room it has, or one image pixel per point at 100%.
function displayWidth(width, height) {
  if (state.zoom === 'actual') return width;
  const box = viewBox();
  return Math.round(Math.min(box.w, box.h * (width / height)));
}

/// Draws the last filtered frame, and — held or split — the untouched image beside it. No filtering here,
/// so comparing is instant however heavy the stack is.
function paint() {
  if (!state.shown) return;
  const { data, width, height, region } = state.shown;

  if (region) {
    // A piece of the whole image: the canvas keeps the image's own size, showing the untouched picture
    // where nothing has been processed yet, and the piece is drawn into place on top of it.
    const whole = state.source;
    if (canvas.width !== whole.width || canvas.height !== whole.height) {
      canvas.width = whole.width;
      canvas.height = whole.height;
      context.putImageData(new ImageData(whole.data, whole.width, whole.height), 0, 0);
    }
    canvas.style.width = `${displayWidth(whole.width, whole.height)}px`;
    const untouched = state.holding || state.split ? cutOut(whole, region, width, height) : null;
    if (state.holding && untouched) {
      context.putImageData(new ImageData(untouched, width, height), region.x, region.y);
      return;
    }
    context.putImageData(new ImageData(data, width, height), region.x, region.y);
    if (!state.split || !untouched) return;
    const cut = Math.round(whole.width * state.splitAt);
    const before = Math.min(width, Math.max(0, cut - region.x));
    if (before > 0) {
      context.putImageData(new ImageData(untouched, width, height), region.x, region.y, 0, 0, before, height);
    }
    if (cut > region.x && cut < region.x + width) drawDivider(cut, region.y, height);
    return;
  }

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${displayWidth(width, height)}px`;
  const untouched = originalAt(width, height);
  context.putImageData(new ImageData(state.holding && untouched ? untouched : data, width, height), 0, 0);
  if (state.holding || !state.split || !untouched) return;
  const cut = Math.round(width * state.splitAt);
  if (cut > 0) context.putImageData(new ImageData(untouched, width, height), 0, 0, 0, 0, cut, height);
  drawDivider(cut, 0, height);
}

/// The same rows of the image as it came in, for the piece on screen.
function cutOut(whole, region, width, height) {
  const row = whole.width * 4;
  const piece = new Uint8ClampedArray(width * height * 4);
  for (let line = 0; line < height; line += 1) {
    const from = (region.y + line) * row + region.x * 4;
    piece.set(whole.data.subarray(from, from + width * 4), line * width * 4);
  }
  return piece;
}

/// The line between before and after, drawn in the size it will appear on screen rather than in image
/// pixels — on a large image scaled down to fit, a two-pixel line all but disappears.
function drawDivider(cut, top, height) {
  const shown = parseFloat(canvas.style.width) || canvas.width;
  const ratio = Math.max(1, canvas.width / shown);
  context.save();
  context.fillStyle = 'rgba(14, 14, 16, .35)';
  context.fillRect(cut - 2.5 * ratio, top, 5 * ratio, height);
  context.fillStyle = 'rgba(245, 241, 234, .95)';
  context.fillRect(cut - ratio, top, 2 * ratio, height);
  context.beginPath();
  context.arc(cut, top + height / 2, 9 * ratio, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/// The image as it came in, at the size currently on screen, or nothing when the two do not match.
function originalAt(width, height) {
  for (const candidate of [state.preview, state.source, state.draft]) {
    if (candidate && candidate.width === width && candidate.height === height) return candidate.data;
  }
  return null;
}

let rendering = false;
let queued = false;

// A frame to paint the spinner before the work starts — but a hidden tab is never given one, and waiting
// for it there would leave a render running forever.
const beforeWork = () => new Promise(resolve => {
  if (document.visibilityState === 'visible') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});

function schedule(quick = false) {
  state.quick = quick;
  if (rendering) { queued = true; return; }
  run();
}

async function run() {
  if (!state.source) return;
  rendering = true;
  const heavy = state.zoom === 'actual';
  if (heavy) el('busy').hidden = false;
  await beforeWork();
  const started = performance.now();
  try {
    if (heavy) {
      const piece = await visiblePiece();
      if (piece) {
        const data = await process(piece.data, piece.w, piece.h, 1, null,
                                   { x: piece.x, y: piece.y, fullWidth: state.source.width, fullHeight: state.source.height });
        show(data, piece.w, piece.h, { x: piece.x, y: piece.y });
      } else {
        const key = signature(1);
        if (!state.fullResult || state.fullResult.signature !== key) {
          const data = await process(state.source.data, state.source.width, state.source.height, 1);
          state.fullResult = { signature: key, data };
        }
        show(state.fullResult.data, state.source.width, state.source.height);
      }
    } else {
      const image = state.quick && state.draft ? state.draft : state.preview;
      const scale = image === state.draft ? state.draftScale : state.previewScale;
      const data = await process(image.data, image.width, image.height, scale,
                                 `preview${state.previewToken}${image === state.draft ? '-draft' : ''}`);
      show(data, image.width, image.height);
    }
    report(performance.now() - started);
  } catch (error) {
    report(0, error.message);
  } finally {
    el('busy').hidden = true;
    rendering = false;
    if (queued) { queued = false; run(); }
  }
}

function report(ms, error) {
  const { width, height } = state.source || { width: 0, height: 0 };
  const size = `${width} × ${height}`;
  const shown = state.zoom === 'actual' ? '100%' : `${Math.round(state.previewScale * 100)}% preview`;
  el('status').textContent = error ? error : `${size} · ${shown} · ${ms.toFixed(0)} ms`;
}

// Panel -----------------------------------------------------------------

function buildFilterList() {
  const list = el('filters');
  list.replaceChildren();
  let group = null;
  for (const effect of EFFECTS) {
    if (effect.group !== group) {
      group = effect.group;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = GROUPS[group];
      list.append(label);
    }
    const row = document.createElement('div');
    row.className = 'filter';
    row.dataset.kind = effect.kind;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.ariaLabel = `Enable ${effect.title}`;
    check.addEventListener('change', () => {
      state.settings[effect.kind].enabled = check.checked;
      state.selected = effect.kind;
      el('presets').value = '';
      refreshPanel();
      schedule();
    });
    const name = document.createElement('span');
    name.textContent = effect.title;
    row.append(check, name);
    row.addEventListener('click', event => {
      if (event.target === check) return;
      state.selected = effect.kind;
      refreshPanel();
    });
    list.append(row);
  }
}

function refreshPanel() {
  for (const row of el('filters').children) {
    if (!row.dataset.kind) continue;
    const kind = Number(row.dataset.kind);
    const p = state.settings[kind];
    row.classList.toggle('selected', kind === state.selected);
    row.classList.toggle('on', p.enabled);
    row.querySelector('input').checked = p.enabled;
  }
  buildControls();
  scrollHints();
}

function buildControls() {
  const effect = byKind(state.selected);
  const p = state.settings[effect.kind];
  const box = el('controls');
  box.replaceChildren();
  box.classList.toggle('disabled', !p.enabled);

  const summary = document.createElement('p');
  summary.className = 'summary';
  summary.textContent = effect.summary;
  box.append(summary);

  const controls = [{ type: 'slider', label: 'Strength', field: 'amount', min: 0, max: 100 }, ...effect.controls];
  if (effect.radius) {
    controls.push({ type: 'slider', label: effect.radius.label, field: 'radius', ...effect.radius, unit: 'px' });
  }

  for (const control of controls) {
    if (control.type === 'heading') {
      const heading = document.createElement('div');
      heading.className = 'control-heading';
      heading.textContent = control.text;
      box.append(heading);
      continue;
    }
    if (control.type === 'note') {
      const note = document.createElement('p');
      note.className = 'control-note';
      note.textContent = control.text;
      box.append(note);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'control';
    const head = document.createElement('div');
    head.className = 'control-head';
    const name = document.createElement('b');
    name.textContent = control.label;
    head.append(name);

    if (control.type === 'picker') {
      const select = document.createElement('select');
      control.options.forEach((option, index) => {
        const item = document.createElement('option');
        item.value = index;
        item.textContent = option;
        select.append(item);
      });
      select.value = p[control.field];
      select.addEventListener('change', () => {
        p[control.field] = Number(select.value);
        el('presets').value = '';
        schedule();
      });
      wrap.append(head, select);
    } else {
      const value = document.createElement('output');
      const step = control.max <= 12 ? 0.5 : 1;
      const unit = control.unit === 'px' ? ' px' : '';
      value.textContent = `${p[control.field]}${unit}`;
      head.append(value);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = control.min;
      range.max = control.max;
      range.step = step;
      range.value = p[control.field];
      range.ariaLabel = control.label;
      range.addEventListener('input', () => {
        p[control.field] = Number(range.value);
        value.textContent = `${range.value}${unit}`;
        el('presets').value = '';
        schedule(true);
      });
      range.addEventListener('change', () => schedule());
      wrap.append(head, range);
    }
    box.append(wrap);
  }
}

function buildPresets() {
  const select = el('presets');
  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const preset = PRESETS.find(item => item.id === select.value);
    state.settings = preset ? settingsFor(preset) : freshSettings();
    const first = ORDER.find(kind => !isNeutral(kind, state.settings[kind]));
    if (first !== undefined) state.selected = first;
    refreshPanel();
    schedule();
  });
}

// Opening, cropping, saving ---------------------------------------------

async function open(file) {
  if (!file) return;
  try {
    await read(file);
  } catch (error) {
    report(0, `${file.name} could not be opened — is it an image this browser can read?`);
  }
}

async function read(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scratch = scratchCanvas(bitmap.width, bitmap.height);
  const paint = scratch.getContext('2d', { willReadFrequently: true });
  paint.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = paint.getImageData(0, 0, scratch.width, scratch.height);
  adopt({ width: image.width, height: image.height, data: image.data });
}

function adopt(source) {
  state.source = source;
  state.fullResult = null;
  state.opaque = isOpaque(source.data);
  el('dropzone').hidden = true;
  el('viewer').hidden = false;
  el('leave').hidden = false;
  el('panelToggle').hidden = false;
  document.body.classList.add('has-image');
  for (const id of ['compare', 'cropMode', 'zoom', 'save', 'reset']) el(id).disabled = false;
  if (insidePage() && !takeWindow && !document.body.classList.contains('editing')) {
    // Between a site's header and footer: show the picture in the page, and wait to be asked for the rest.
    el('leave').hidden = false;
    el('panelToggle').hidden = false;
    leave();
  } else {
    takeWindow = false;
    enterEditing();
  }
}

function cropTo(rect) {
  const { width, data } = state.source;
  const cropped = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y += 1) {
    const from = ((rect.y + y) * width + rect.x) * 4;
    cropped.set(data.subarray(from, from + rect.w * 4), y * rect.w * 4);
  }
  adopt({ width: rect.w, height: rect.h, data: cropped });
}

async function save() {
  const { width, height } = state.source;
  el('busy').hidden = false;
  await beforeWork();
  try {
    const key = signature(1);
    if (!state.fullResult || state.fullResult.signature !== key) {
      state.fullResult = { signature: key, data: await process(state.source.data, width, height, 1) };
    }
    const out = scratchCanvas(width, height);
    out.getContext('2d').putImageData(new ImageData(state.fullResult.data, width, height), 0, 0);
    const type = el('format').value;
    const quality = Number(el('quality').value) / 100;
    const blob = await toBlob(out, type, quality);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `darkroom.${type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    report(0, `Saved ${width} × ${height} · ${(blob.size / 1048576).toFixed(1)} MB`);
  } catch (error) {
    report(0, error.message);
  } finally {
    el('busy').hidden = true;
  }
}

// Wiring ----------------------------------------------------------------

function wire() {
  el('pick').addEventListener('click', () => el('file').click());
  el('open').addEventListener('click', () => el('file').click());

  el('file').addEventListener('change', event => open(event.target.files[0]));
  el('example').addEventListener('click', loadExample);

  const stage = el('stage');
  stage.addEventListener('dragover', event => { event.preventDefault(); stage.classList.add('dragging'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
  stage.addEventListener('drop', event => {
    event.preventDefault();
    stage.classList.remove('dragging');
    open(event.dataTransfer.files[0]);
  });

  const panels = shown => {
    document.body.classList.toggle('panel-hidden', !shown);
    el('panelToggle').classList.toggle('active', shown);
    paint();
    scrollHints();
  };
  el('panelToggle').addEventListener('click', () => panels(document.body.classList.contains('panel-hidden')));

  const compare = el('compare');
  compare.addEventListener('click', () => {
    state.split = !state.split;
    compare.classList.toggle('active', state.split);
    paint();
  });

  const hold = on => {
    if (state.holding === on) return;
    state.holding = on;
    paint();
  };
  addEventListener('keydown', event => { if (event.key === 'b' && !event.repeat) hold(true); });
  addEventListener('keyup', event => { if (event.key === 'b') hold(false); });

  // A double click anywhere on the stage puts the panels away, and brings them back.
  el('stage').addEventListener('dblclick', () => {
    if (state.cropping) return;
    if (!document.body.classList.contains('editing')) { enterEditing(); return; }
    panels(document.body.classList.contains('panel-hidden'));
  });

  // On the image itself: the divider is a handle, everywhere else is press-and-hold for the original.
  let dragging = false;
  const position = event => {
    const box = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  };
  let panning = null;
  // A fingertip is far less exact than a cursor, so the divider is easier to catch by touch.
  const reach = event => event.pointerType === 'mouse' ? 16 : 36;
  // By touch the original waits a moment: a finger that only passes over the image on its way to scrolling
  // the page should not flash it.
  let holdTimer = 0;
  canvas.addEventListener('pointerdown', event => {
    const box = canvas.getBoundingClientRect();
    if (state.split && Math.abs(event.clientX - (box.left + box.width * state.splitAt)) < reach(event)) {
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
    } else if (state.zoom === 'actual') {
      const stage = el('stage');
      panning = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('panning');
    } else if (event.pointerType === 'mouse') {
      hold(true);
    } else {
      holdTimer = setTimeout(() => hold(true), 180);
    }
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    if (panning) {
      const stage = el('stage');
      stage.scrollLeft = panning.left - (event.clientX - panning.x);
      stage.scrollTop = panning.top - (event.clientY - panning.y);
      return;
    }
    if (dragging) { state.splitAt = position(event); paint(); return; }
    const box = canvas.getBoundingClientRect();
    const onDivider = state.split && Math.abs(event.clientX - (box.left + box.width * state.splitAt)) < reach(event);
    canvas.style.cursor = onDivider ? 'ew-resize' : state.zoom === 'actual' ? 'grab' : 'default';
  });
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) {
    canvas.addEventListener(event, () => {
      clearTimeout(holdTimer);
      dragging = false;
      panning = null;
      canvas.classList.remove('panning');
      hold(false);
    });
  }

  el('zoom').addEventListener('click', () => {
    state.zoom = state.zoom === 'fit' ? 'actual' : 'fit';
    el('zoom').textContent = state.zoom === 'fit' ? '100%' : 'Fit';
    el('viewer').classList.toggle('actual', state.zoom === 'actual');
    el('stage').classList.toggle('actual', state.zoom === 'actual');
    schedule();
  });

  el('reset').addEventListener('click', () => {
    state.settings = freshSettings();
    el('presets').value = '';
    refreshPanel();
    schedule();
  });

  el('format').addEventListener('change', () => {
    el('qualityWrap').style.visibility = el('format').value === 'image/png' ? 'hidden' : 'visible';
  });
  el('quality').addEventListener('input', () => { el('qualityValue').textContent = el('quality').value; });
  el('save').addEventListener('click', save);

  el('leave').addEventListener('click', () => {
    if (document.body.classList.contains('editing')) leave();
    else enterEditing();
  });

  addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('editing')) leave();
    // Tab still moves between controls when one of them has the focus; it only puts the panels away
    // when the keyboard is not being used to navigate them.
    if (event.key === 'Tab' && state.source && !event.target.closest?.('.toolbar, .sheet')) {
      event.preventDefault();
      panels(document.body.classList.contains('panel-hidden'));
    }
  });

  for (const id of ['panel', 'inspector']) el(id).addEventListener('scroll', scrollHints);

  let scrolling = null;
  el('stage').addEventListener('scroll', () => {
    if (state.zoom !== 'actual' || !state.source) return;
    clearTimeout(scrolling);
    scrolling = setTimeout(() => schedule(), 140);
  });

  wireCrop();
  addEventListener('resize', () => {
    measureChrome();
    scrollHints();
    if (!state.source || state.zoom === 'actual') return;
    buildPreview();
    schedule();
  });
  measureChrome();
}

const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

function wireCrop() {
  const overlay = el('cropOverlay');
  const rect = el('cropRect');
  let box = null;     // the crop, in the overlay's own pixels
  let drag = null;

  // The frame: a dashed rectangle with a square at each corner and side, and thirds drawn inside it.
  for (const line of ['v1', 'v2', 'h1', 'h2']) {
    const guide = document.createElement('div');
    guide.className = `third ${line[0]}`;
    guide.style[line[0] === 'v' ? 'left' : 'top'] = line[1] === '1' ? '33.333%' : '66.666%';
    rect.append(guide);
  }
  for (const side of ['n', 'e', 's', 'w']) {
    const edge = document.createElement('div');
    edge.className = `crop-edge ${side}`;
    edge.dataset.handle = side;
    rect.append(edge);
  }
  for (const corner of HANDLES) {
    const handle = document.createElement('div');
    handle.className = `crop-handle ${corner}`;
    handle.dataset.handle = corner;
    rect.append(handle);
  }

  const place = () => {
    Object.assign(rect.style, {
      display: 'block', left: `${box.x}px`, top: `${box.y}px`,
      width: `${box.w}px`, height: `${box.h}px`,
    });
    state.cropRect = { ...box, frame: { width: overlay.clientWidth, height: overlay.clientHeight } };
  };

  const wholeImage = () => {
    box = { x: 0, y: 0, w: overlay.clientWidth, h: overlay.clientHeight };
    place();
  };

  el('cropMode').addEventListener('click', () => {
    state.cropping = !state.cropping;
    overlay.hidden = !state.cropping;
    el('cropActions').hidden = !state.cropping;
    el('cropMode').classList.toggle('active', state.cropping);
    if (state.cropping) wholeImage();
    else { rect.style.display = 'none'; state.cropRect = null; }
  });

  overlay.addEventListener('pointerdown', event => {
    const frame = overlay.getBoundingClientRect();
    const at = { x: event.clientX - frame.left, y: event.clientY - frame.top };
    const handle = event.target.dataset ? event.target.dataset.handle : null;
    const inside = at.x >= box.x && at.x <= box.x + box.w && at.y >= box.y && at.y <= box.y + box.h;
    drag = { at, from: { ...box }, handle, mode: handle ? 'resize' : inside ? 'move' : 'draw' };
    if (drag.mode === 'draw') { box = { x: at.x, y: at.y, w: 0, h: 0 }; place(); }
    overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  overlay.addEventListener('pointermove', event => {
    if (!drag) return;
    const frame = overlay.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - frame.left), frame.width);
    const y = Math.min(Math.max(0, event.clientY - frame.top), frame.height);

    if (drag.mode === 'move') {
      box.x = Math.min(Math.max(0, drag.from.x + x - drag.at.x), frame.width - drag.from.w);
      box.y = Math.min(Math.max(0, drag.from.y + y - drag.at.y), frame.height - drag.from.h);
    } else if (drag.mode === 'draw') {
      box = { x: Math.min(drag.at.x, x), y: Math.min(drag.at.y, y),
              w: Math.abs(x - drag.at.x), h: Math.abs(y - drag.at.y) };
    } else {
      // Each letter in the handle's name moves that edge; the opposite ones stay where they are.
      const edges = { left: drag.from.x, top: drag.from.y,
                      right: drag.from.x + drag.from.w, bottom: drag.from.y + drag.from.h };
      if (drag.handle.includes('w')) edges.left = Math.min(x, edges.right - 16);
      if (drag.handle.includes('e')) edges.right = Math.max(x, edges.left + 16);
      if (drag.handle.includes('n')) edges.top = Math.min(y, edges.bottom - 16);
      if (drag.handle.includes('s')) edges.bottom = Math.max(y, edges.top + 16);
      box = { x: edges.left, y: edges.top, w: edges.right - edges.left, h: edges.bottom - edges.top };
    }
    place();
  });

  for (const event of ['pointerup', 'pointercancel']) overlay.addEventListener(event, () => { drag = null; });

  el('cropCancel').addEventListener('click', () => el('cropMode').click());
  el('cropApply').addEventListener('click', () => {
    const chosen = state.cropRect;
    if (!chosen || chosen.w < 8 || chosen.h < 8) return;
    const scale = state.source.width / chosen.frame.width;
    const crop = {
      x: Math.round(chosen.x * scale),
      y: Math.round(chosen.y * scale),
      w: Math.round(chosen.w * scale),
      h: Math.round(chosen.h * scale),
    };
    crop.x = Math.max(0, Math.min(crop.x, state.source.width - 1));
    crop.y = Math.max(0, Math.min(crop.y, state.source.height - 1));
    crop.w = Math.max(1, Math.min(crop.w, state.source.width - crop.x));
    crop.h = Math.max(1, Math.min(crop.h, state.source.height - crop.y));
    el('cropMode').click();
    cropTo(crop);
  });
}

/// The studio's own render, so the page opens with something to work on.
async function loadExample() {
  try {
    const response = await fetch(new URL('sample.jpg?v=%%V%%', import.meta.url));
    if (response.ok) await open(new File([await response.blob()], 'example.jpg', { type: 'image/jpeg' }));
  } catch (error) {
    report(0, 'The example image could not be loaded — open one of your own.');
  }
}

function start() {
  startWorkers();
  buildPresets();
  buildFilterList();
  refreshPanel();
  wire();
  for (const id of ['compare', 'cropMode', 'zoom', 'save', 'reset']) el(id).disabled = true;
  el('status').textContent = 'Ready — open an image to begin.';
  loadExample();
}

start();
