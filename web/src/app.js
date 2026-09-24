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
  zoom: 'fit',         // 'fit', or 'actual': drawn at `scale` screen points per image pixel
  scale: 1,            // 1 is 100%; the wheel takes it from the fit up to MAX_SCALE (300%)
  fileSize: 0,         // bytes of the file that was opened, for the size beside Save
  encoded: null,       // { key, blob } the last file written or estimated, so Save does not encode twice
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
  for (const id of ['panel', 'inspectorScroll']) {
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
  // `overflow: hidden` on the body stops the page behind only while the root element leaves overflow
  // alone; a site that sets overflow-x on <html> keeps its own scrollbar, and the wheel scrolled the page
  // under the tool. The root is held still for as long as the tool has the window.
  document.documentElement.style.overflow = 'hidden';
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
  document.documentElement.style.overflow = '';
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

/// The part of the image on screen when zoomed, with the margin the stack reads around it — or nothing when
/// the whole image is barely bigger than that, in which case processing all of it is the simpler job. It is
/// read off where the canvas and the stage actually are, so the scale, the centring and the room kept clear
/// of the panels all come out right without being worked out again here.
async function visiblePiece() {
  const stage = el('stage');
  const { width, height } = state.source;
  const margin = await totalReach(1);
  const view = stage.getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  const per = box.width / width || 1;
  const x = Math.max(0, Math.floor((view.left - box.left) / per) - margin);
  const y = Math.max(0, Math.floor((view.top - box.top) / per) - margin);
  const right = Math.min(width, Math.ceil((view.right - box.left) / per) + margin);
  const bottom = Math.min(height, Math.ceil((view.bottom - box.top) / per) + margin);
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

/// How wide the image is drawn: filling the room it has, or `scale` points per image pixel when zoomed.
function displayWidth(width, height) {
  if (state.zoom === 'actual') return Math.max(1, Math.round(state.source.width * state.scale));
  const box = viewBox();
  return Math.round(Math.min(box.w, box.h * (width / height)));
}

const MAX_SCALE = 3;   // 300%: past that the wheel shows single pixels, not the picture

/// The scale at which the whole image fits — measured as the stage is when it is not zoomed, since zoomed
/// it keeps room clear of the panels that the fit does not.
function fitScale() {
  const stage = el('stage');
  const zoomed = stage.classList.contains('actual');
  // Measured without the zoom's padding the scrolled area is smaller for a moment, and the browser cuts
  // the scroll position down to it — so the position is put back once the padding is.
  const left = stage.scrollLeft;
  const top = stage.scrollTop;
  if (zoomed) stage.classList.remove('actual');
  const box = viewBox();
  if (zoomed) {
    stage.classList.add('actual');
    stage.scrollLeft = left;
    stage.scrollTop = top;
  }
  const { width, height } = state.source;
  return Math.min(box.w, box.h * (width / height)) / width;
}

/// Zooms to `scale` (1 is 100%) or back to 'fit'. The point of the image under `anchor` — the cursor, or
/// the middle of the view — stays under it, so zooming reads as moving closer to that spot.
function setZoom(scale, anchor = null) {
  if (!state.source) return;
  const stage = el('stage');
  const view = stage.getBoundingClientRect();
  const at = anchor || { x: view.left + view.width / 2, y: view.top + view.height / 2 };
  const before = canvas.getBoundingClientRect();
  const fx = before.width ? (at.x - before.left) / before.width : 0.5;
  const fy = before.height ? (at.y - before.top) / before.height : 0.5;
  const zoomed = scale !== 'fit';
  state.zoom = zoomed ? 'actual' : 'fit';
  if (zoomed) state.scale = Math.min(MAX_SCALE, Math.max(0.01, scale));
  el('zoom').textContent = zoomed ? 'Fit' : '100%';
  el('zoom').title = zoomed ? 'Fit the whole image (the wheel zooms)' : 'One image pixel per screen point (the wheel zooms)';
  el('viewer').classList.toggle('actual', zoomed);
  stage.classList.toggle('actual', zoomed);
  // Past 200% the pixels are what is being looked at, so they are drawn as squares, not blurred together.
  canvas.style.imageRendering = zoomed && state.scale >= 2 ? 'pixelated' : '';
  canvas.style.width = `${displayWidth(state.source.width, state.source.height)}px`;
  if (zoomed) {
    const after = canvas.getBoundingClientRect();
    stage.scrollLeft += after.left + fx * after.width - at.x;
    stage.scrollTop += after.top + fy * after.height - at.y;
  }
  report(0);
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
    renderLoupe();
    sizes();
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
  const shown = state.zoom === 'actual' ? `${Math.round(state.scale * 100)}%` : `${Math.round(state.previewScale * 100)}% preview`;
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

/// `chosen`: the visitor picked or dropped this image, so it is there to be worked on and opens in the
/// editing view even inside a page. The example that loads by itself waits in the page until asked for.
async function open(file, chosen = false) {
  if (!file) return;
  const before = takeWindow;
  if (chosen) takeWindow = true;
  try {
    await read(file);
  } catch (error) {
    takeWindow = before;
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
  state.fileSize = file.size;
  adopt({ width: image.width, height: image.height, data: image.data });
}

function adopt(source) {
  state.source = source;
  state.fullResult = null;
  state.encoded = null;
  state.opaque = isOpaque(source.data);
  loupe.focus = null;
  loupe.key = '';
  // A new picture, or a crop, starts whole in view rather than at the old zoom and scroll.
  if (state.zoom === 'actual') {
    state.zoom = 'fit';
    el('zoom').textContent = '100%';
    el('viewer').classList.remove('actual');
    el('stage').classList.remove('actual');
    canvas.style.imageRendering = '';
  }
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
    const type = el('format').value;
    const blob = await encodeFull();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `darkroom.${type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    report(0, `Saved ${width} × ${height} · ${bytes(blob.size)}`);
    sizes();
  } catch (error) {
    report(0, error.message);
  } finally {
    el('busy').hidden = true;
  }
}

const bytes = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/// What Save would write: the filters at full resolution, in the chosen format and quality. PNG has no
/// quality, so moving the slider does not make it a different file.
function encodeKey() {
  const type = el('format').value;
  return `${signature(1)}|${type}|${type === 'image/png' ? '' : el('quality').value}`;
}

/// The saved file, made once per stack, format and quality and kept — the size beside Save is this very
/// file, and Save right after it only hands it over.
async function encodeFull() {
  const source = state.source;
  const { width, height } = source;
  const key = encodeKey();
  if (state.encoded && state.encoded.key === key) return state.encoded.blob;
  const full = signature(1);
  let result = state.fullResult && state.fullResult.signature === full ? state.fullResult.data : null;
  if (!result) {
    result = await process(source.data, width, height, 1);
    if (state.source === source) state.fullResult = { signature: full, data: result };
  }
  const out = scratchCanvas(width, height);
  out.getContext('2d').putImageData(new ImageData(result, width, height), 0, 0);
  const type = el('format').value;
  const blob = await toBlob(out, type, Number(el('quality').value) / 100);
  if (state.source === source) state.encoded = { key, blob };
  return blob;
}

/// Beside Save: the size of the file that was opened, and of the file Save will write. The second is made
/// when the page has been still for a moment — filtering the whole image is real work — and on a very large
/// image only when the format or the quality is touched.
let sizeTimer = 0;
let sizeTicket = 0;
function sizes(delay = 800, asked = false) {
  const out = el('sizes');
  clearTimeout(sizeTimer);
  if (!state.source) { out.textContent = ''; return; }
  const original = state.fileSize ? `<span class="long">Original </span>${bytes(state.fileSize)}` : '';
  const known = state.encoded && state.encoded.key === encodeKey() ? state.encoded.blob.size : null;
  const huge = state.source.width * state.source.height > 40e6;
  const saved = known !== null ? bytes(known) : huge && !asked ? '' : '…';
  out.innerHTML = original + (saved ? `${original ? ' → ' : ''}<span class="long">saved </span><b>${saved}</b>` : '');
  if (known !== null || (huge && !asked)) return;
  const ticket = ++sizeTicket;
  sizeTimer = setTimeout(async () => {
    if (ticket !== sizeTicket || !state.source) return;
    if (rendering || state.cropping) { sizes(400, asked); return; }
    try {
      await encodeFull();
      if (ticket === sizeTicket) sizes(800, asked);
    } catch {
      if (ticket === sizeTicket) out.innerHTML = original;
    }
  }, delay);
}

// The loupe -------------------------------------------------------------

/// Under the settings, a piece of the image at 100% — as much as fits there — so what a filter does to
/// grain and edges can be judged while the whole picture stays in view. It shows the same before / after
/// as the stage, with a divider of its own; dragging it looks around, and a click on the picture moves it
/// there. A frame on the picture says where it is looking.
const loupe = { focus: null, key: '', busy: false, again: false, piece: null, splitAt: 0.5 };

function loupeShown() {
  return !!state.source && document.body.classList.contains('editing') && el('loupe').offsetParent !== null;
}

/// The piece at the loupe's size around the focus, kept inside the image.
function loupeRect() {
  const box = el('loupe');
  const { width, height } = state.source;
  const w = Math.max(1, Math.min(width, Math.floor(box.clientWidth)));
  const h = Math.max(1, Math.min(height, Math.floor(box.clientHeight)));
  const focus = loupe.focus || { x: width / 2, y: height / 2 };
  const x = Math.round(Math.min(Math.max(0, focus.x - w / 2), width - w));
  const y = Math.round(Math.min(Math.max(0, focus.y - h / 2), height - h));
  return { x, y, w, h };
}

async function renderLoupe() {
  if (!loupeShown()) { el('loupeMark').hidden = true; return; }
  if (loupe.busy) { loupe.again = true; return; }
  const source = state.source;
  const rect = loupeRect();
  const key = `${signature(1)}|${rect.x},${rect.y},${rect.w},${rect.h}`;
  markLoupe(rect);
  if (key === loupe.key && loupe.piece) { paintLoupe(); return; }
  loupe.busy = true;
  try {
    const { width, height } = source;
    // The margin the stack reads around the piece, so its edges come out as they would in the whole.
    const margin = await totalReach(1);
    const px = Math.max(0, rect.x - margin);
    const py = Math.max(0, rect.y - margin);
    const pw = Math.min(width, rect.x + rect.w + margin) - px;
    const ph = Math.min(height, rect.y + rect.h + margin) - py;
    const raw = new Uint8ClampedArray(pw * ph * 4);
    for (let line = 0; line < ph; line += 1) {
      const from = ((py + line) * width + px) * 4;
      raw.set(source.data.subarray(from, from + pw * 4), line * pw * 4);
    }
    const done = await process(raw, pw, ph, 1, null, { x: px, y: py, fullWidth: width, fullHeight: height });
    if (state.source !== source) return;
    loupe.piece = { ...rect, px, py, pw, ph, raw, done };
    loupe.key = key;
    paintLoupe();
  } catch {
    // The loupe is a view; the stage reports what went wrong.
  } finally {
    loupe.busy = false;
    if (loupe.again) { loupe.again = false; renderLoupe(); }
  }
}

function paintLoupe() {
  const p = loupe.piece;
  if (!p) return;
  const view = el('loupeCanvas');
  if (view.width !== p.w || view.height !== p.h) {
    view.width = p.w;
    view.height = p.h;
    view.style.width = `${p.w}px`;
    view.style.height = `${p.h}px`;
  }
  const draw = view.getContext('2d');
  const dx = p.x - p.px;
  const dy = p.y - p.py;
  draw.putImageData(new ImageData(state.holding ? p.raw : p.done, p.pw, p.ph), -dx, -dy, dx, dy, p.w, p.h);
  if (state.holding || !state.split) return;
  const cut = Math.round(p.w * loupe.splitAt);
  if (cut > 0) draw.putImageData(new ImageData(p.raw, p.pw, p.ph), -dx, -dy, dx, dy, cut, p.h);
  draw.fillStyle = 'rgba(14, 14, 16, .35)';
  draw.fillRect(cut - 2.5, 0, 5, p.h);
  draw.fillStyle = 'rgba(245, 241, 234, .95)';
  draw.fillRect(cut - 1, 0, 2, p.h);
  draw.beginPath();
  draw.arc(cut, p.h / 2, 7, 0, Math.PI * 2);
  draw.fill();
}

/// The frame on the picture: where the loupe is looking, in fractions of the image so it follows any size.
function markLoupe(rect) {
  const mark = el('loupeMark');
  const { width, height } = state.source;
  mark.hidden = state.zoom === 'actual';
  mark.style.left = `${(rect.x / width) * 100}%`;
  mark.style.top = `${(rect.y / height) * 100}%`;
  mark.style.width = `${(rect.w / width) * 100}%`;
  mark.style.height = `${(rect.h / height) * 100}%`;
}

function wireLoupe() {
  const box = el('loupe');
  const view = el('loupeCanvas');
  let drag = null;
  const onDivider = event => {
    if (!state.split || !loupe.piece) return false;
    const r = view.getBoundingClientRect();
    return Math.abs(event.clientX - (r.left + r.width * loupe.splitAt)) < (event.pointerType === 'mouse' ? 12 : 30);
  };
  box.addEventListener('pointerdown', event => {
    if (!state.source || event.button !== 0) return;
    const rect = loupeRect();
    drag = onDivider(event)
      ? { divider: true }
      : { x: event.clientX, y: event.clientY, focus: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } };
    box.setPointerCapture(event.pointerId);
    box.classList.toggle('looking', !drag.divider);
    event.preventDefault();
  });
  box.addEventListener('pointermove', event => {
    if (!drag) {
      box.style.cursor = onDivider(event) ? 'ew-resize' : '';
      return;
    }
    if (drag.divider) {
      const r = view.getBoundingClientRect();
      loupe.splitAt = Math.min(1, Math.max(0, (event.clientX - r.left) / r.width));
      paintLoupe();
      return;
    }
    // One image pixel per point in the loupe, so the picture moves exactly with the pointer.
    loupe.focus = { x: drag.focus.x - (event.clientX - drag.x), y: drag.focus.y - (event.clientY - drag.y) };
    renderLoupe();
  });
  for (const type of ['pointerup', 'pointercancel']) {
    box.addEventListener(type, () => { drag = null; box.classList.remove('looking'); });
  }
  // The room it has changes with the filter chosen (more or fewer settings above it) and with the window.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => renderLoupe()).observe(box);
}

// Wiring ----------------------------------------------------------------

function wire() {
  el('pick').addEventListener('click', () => el('file').click());
  el('open').addEventListener('click', () => el('file').click());

  el('file').addEventListener('change', event => { open(event.target.files[0], true); event.target.value = ''; });
  el('example').addEventListener('click', loadExample);

  const stage = el('stage');
  stage.addEventListener('dragover', event => { event.preventDefault(); stage.classList.add('dragging'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
  stage.addEventListener('drop', event => {
    event.preventDefault();
    stage.classList.remove('dragging');
    open(event.dataTransfer.files[0], true);
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
    paintLoupe();
  });

  const hold = on => {
    if (state.holding === on) return;
    state.holding = on;
    paint();
    paintLoupe();
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
  // A press on the picture also sends the loupe there.
  const lookAt = event => {
    if (!loupeShown()) return;
    const box = canvas.getBoundingClientRect();
    loupe.focus = { x: ((event.clientX - box.left) / box.width) * state.source.width,
                    y: ((event.clientY - box.top) / box.height) * state.source.height };
    renderLoupe();
  };
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
      lookAt(event);
    } else {
      holdTimer = setTimeout(() => hold(true), 180);
      lookAt(event);
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
    setZoom(state.zoom === 'fit' ? 1 : 'fit');
    schedule();
  });

  // The wheel zooms around the cursor, from the fit up to 300%, in steps that feel the same at any size;
  // a trackpad pinch arrives as a wheel with ctrlKey and zooms the same way. In the editing view nothing
  // behind the tool scrolls. In the page the wheel still scrolls the page, and only a pinch zooms.
  let settle = 0;
  stage.addEventListener('wheel', event => {
    if (!state.source || state.cropping) return;
    const editing = document.body.classList.contains('editing');
    if (!editing && !event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    if (!delta) return;
    const fit = fitScale();
    const from = state.zoom === 'actual' ? state.scale : fit;
    let to = from * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015));
    to = Math.min(MAX_SCALE, to);
    // Coming back out, the fit is a stop of its own: the whole picture again, not a scale near it.
    const done = to <= fit * 1.001 && (state.zoom === 'fit' || from > fit * 1.001 || to < Math.min(fit, 1));
    if (done && state.zoom === 'fit') return;
    if (!done && Math.abs(to - from) < 0.0005) return;
    setZoom(done ? 'fit' : to, { x: event.clientX, y: event.clientY });
    // The canvas follows every step at once, stretched; the filters catch up when the wheel rests.
    clearTimeout(settle);
    settle = setTimeout(() => schedule(), 160);
  }, { passive: false });

  // Zoomed, the picture can be dragged from anywhere on the stage — also from the dark room around it,
  // which is what is left to hold when the image is pushed out from under a panel.
  let sliding = null;
  stage.addEventListener('pointerdown', event => {
    if (state.zoom !== 'actual' || state.cropping || event.target === canvas || event.button !== 0) return;
    if (event.target.closest('.crop-overlay, .dropzone, button, a, input, select')) return;
    sliding = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('sliding');
    event.preventDefault();
  });
  stage.addEventListener('pointermove', event => {
    if (!sliding) return;
    stage.scrollLeft = sliding.left - (event.clientX - sliding.x);
    stage.scrollTop = sliding.top - (event.clientY - sliding.y);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    stage.addEventListener(type, () => { sliding = null; stage.classList.remove('sliding'); });
  }

  el('reset').addEventListener('click', () => {
    state.settings = freshSettings();
    el('presets').value = '';
    refreshPanel();
    schedule();
  });

  el('format').addEventListener('change', () => {
    el('qualityWrap').style.visibility = el('format').value === 'image/png' ? 'hidden' : 'visible';
    sizes(150, true);
  });
  el('quality').addEventListener('input', () => {
    el('qualityValue').textContent = el('quality').value;
    sizes(250, true);
  });
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

  for (const id of ['panel', 'inspectorScroll']) el(id).addEventListener('scroll', scrollHints);

  let scrolling = null;
  el('stage').addEventListener('scroll', () => {
    if (state.zoom !== 'actual' || !state.source) return;
    clearTimeout(scrolling);
    scrolling = setTimeout(() => schedule(), 140);
  });

  wireCrop();
  wireLoupe();
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
