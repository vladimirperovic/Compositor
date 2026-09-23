// Darkroom in the browser. The filters themselves are the desktop app's C core compiled to WebAssembly;
// this file is only the page around them: opening an image, keeping a screen-sized preview responsive,
// cropping, and handing the full resolution to the encoder when the image is saved.
import { EFFECTS, GROUPS, ORDER, PRESETS, byKind, defaultsFor, freshSettings, isNeutral, settingsFor } from './effects.js';

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
  comparing: false,
  cropping: false,
  cropRect: null,
  draft: null,         // half-size preview, used while a slider is moving
  draftScale: 1,
  quick: false,
  shown: null,         // { data, width, height } the last filtered frame, kept for comparing
  split: false,        // the vertical line: original on its left, filtered on its right
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
      p.protectShadows / 100, p.protectHighlights / 100, state.seed, scale);
    count += 1;
  }
  return { values: new Float32Array(values), count };
}

// The filters themselves live in a worker; this page only sends it pixels and settings.
let worker = null;
let threads = false;
let nextJob = 1;
const pending = new Map();

function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url));
  worker.addEventListener('message', event => {
    const { id, ok, buffer, error, hello } = event.data;
    if (hello) { threads = event.data.threads; return; }
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (ok) job.resolve(new Uint8ClampedArray(buffer));
    else job.reject(new Error(error));
  });
  worker.addEventListener('error', () => {
    for (const job of pending.values()) job.reject(new Error('The filters stopped unexpectedly.'));
    pending.clear();
  });
}

/// Runs the active filters over a copy of `data`, in the processor's premultiplied pixels.
function process(data, width, height, scale) {
  const { values, count } = activeStack(scale);
  if (!count) return Promise.resolve(data);
  const copy = new Uint8ClampedArray(data);   // the worker takes ownership of whatever it is sent
  const id = nextJob += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, buffer: copy.buffer, width, height, scale, values, opaque: state.opaque },
                       [copy.buffer]);
  });
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
  const w = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16;
  const h = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 16;
  return { w: Math.max(240, w), h: Math.max(200, h) };
}

const pixelRatio = () => Math.min(2, window.devicePixelRatio || 1);

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
  const scratch = new OffscreenCanvas(w, h);
  const paint = scratch.getContext('2d', { willReadFrequently: true });
  const whole = new ImageData(state.source.data, width, height);
  if (w === width && h === height) {
    paint.putImageData(whole, 0, 0);
  } else {
    // Downscaling needs drawImage, and drawImage needs a canvas to read from.
    const full = new OffscreenCanvas(width, height);
    full.getContext('2d').putImageData(whole, 0, 0);
    paint.imageSmoothingQuality = 'high';
    paint.drawImage(full, 0, 0, w, h);
  }
  state.preview = paint.getImageData(0, 0, w, h);
  state.previewScale = w / width;

  // A half-size copy carries the image while a slider is moving: four times fewer pixels to filter,
  // and the full preview comes back the moment the slider is let go.
  const dw = Math.max(1, Math.round(w / 2));
  const dh = Math.max(1, Math.round(h / 2));
  const small = new OffscreenCanvas(dw, dh);
  const drawn = small.getContext('2d', { willReadFrequently: true });
  drawn.imageSmoothingQuality = 'high';
  drawn.drawImage(scratch, 0, 0, dw, dh);
  state.draft = drawn.getImageData(0, 0, dw, dh);
  state.draftScale = dw / width;
}

function show(data, width, height) {
  state.shown = { data, width, height };
  paint();
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
  const { data, width, height } = state.shown;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${displayWidth(width, height)}px`;
  const untouched = originalAt(width, height);
  context.putImageData(new ImageData(state.holding && untouched ? untouched : data, width, height), 0, 0);
  if (state.holding || !state.split || !untouched) return;
  const cut = Math.round(width * state.splitAt);
  if (cut > 0) context.putImageData(new ImageData(untouched, width, height), 0, 0, 0, 0, cut, height);
  context.fillStyle = 'rgba(245, 241, 234, .9)';
  context.fillRect(cut - 1, 0, 2, height);
  context.beginPath();
  context.arc(cut, height / 2, Math.max(9, width / 130), 0, Math.PI * 2);
  context.fill();
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
  state.quick = quick && !state.split && !state.holding;
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
      const key = signature(1);
      if (!state.fullResult || state.fullResult.signature !== key) {
        const data = await process(state.source.data, state.source.width, state.source.height, 1);
        state.fullResult = { signature: key, data };
      }
      show(state.fullResult.data, state.source.width, state.source.height);
    } else {
      const image = state.quick && state.draft ? state.draft : state.preview;
      const scale = image === state.draft ? state.draftScale : state.previewScale;
      const data = await process(image.data, image.width, image.height, scale);
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
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scratch = new OffscreenCanvas(bitmap.width, bitmap.height);
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
  document.body.classList.add('editing');
  // On a phone the sheet would cover the picture, so it starts out of the way behind its own button.
  document.body.classList.toggle('panel-hidden', window.innerWidth < 900);
  measureChrome();
  for (const id of ['compare', 'cropMode', 'zoom', 'save', 'reset']) el(id).disabled = false;
  buildPreview();
  schedule();
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
    const out = new OffscreenCanvas(width, height);
    out.getContext('2d').putImageData(new ImageData(state.fullResult.data, width, height), 0, 0);
    const type = el('format').value;
    const quality = Number(el('quality').value) / 100;
    const blob = await out.convertToBlob({ type, quality });
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
  el('hide')?.addEventListener('click', () => { document.body.classList.add('panel-hidden'); paint(); });
  el('file').addEventListener('change', event => open(event.target.files[0]));
  el('example').addEventListener('click', async () => {
    const response = await fetch('sample.jpg');
    open(new File([await response.blob()], 'example.jpg', { type: 'image/jpeg' }));
  });

  const stage = el('stage');
  stage.addEventListener('dragover', event => { event.preventDefault(); stage.classList.add('dragging'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
  stage.addEventListener('drop', event => {
    event.preventDefault();
    stage.classList.remove('dragging');
    open(event.dataTransfer.files[0]);
  });

  const compare = el('compare');
  compare.addEventListener('click', () => {
    state.split = !state.split;
    compare.classList.toggle('active', state.split);
    if (state.quick) schedule();   // the draft has no untouched twin to compare against
    else paint();
  });

  const hold = on => {
    if (state.holding === on) return;
    state.holding = on;
    if (state.quick) schedule();
    else paint();
  };
  addEventListener('keydown', event => { if (event.key === 'b' && !event.repeat) hold(true); });
  addEventListener('keyup', event => { if (event.key === 'b') hold(false); });

  // On the image itself: the divider is a handle, everywhere else is press-and-hold for the original.
  let dragging = false;
  const position = event => {
    const box = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  };
  canvas.addEventListener('pointerdown', event => {
    const box = canvas.getBoundingClientRect();
    if (state.split && Math.abs(event.clientX - (box.left + box.width * state.splitAt)) < 16) {
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
    } else {
      hold(true);
    }
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    if (dragging) { state.splitAt = position(event); paint(); return; }
    if (!state.split) return;
    const box = canvas.getBoundingClientRect();
    canvas.style.cursor = Math.abs(event.clientX - (box.left + box.width * state.splitAt)) < 16 ? 'ew-resize' : 'default';
  });
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) {
    canvas.addEventListener(event, () => { dragging = false; hold(false); });
  }

  el('zoom').addEventListener('click', () => {
    state.zoom = state.zoom === 'fit' ? 'actual' : 'fit';
    el('zoom').textContent = state.zoom === 'fit' ? '100%' : 'Fit';
    el('viewer').classList.toggle('actual', state.zoom === 'actual');
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

  // Leaving the editing view keeps the image; it only gives the page back.
  const leave = () => {
    if (!document.body.classList.contains('editing')) return;
    document.body.classList.remove('editing');
    buildPreview();
    schedule();
  };
  el('leave').addEventListener('click', leave);
  el('panelToggle').addEventListener('click', () => { document.body.classList.remove('panel-hidden'); paint(); });
  addEventListener('keydown', event => {
    if (event.key === 'Escape') leave();
    if (event.key === 'Tab' && state.source) {
      event.preventDefault();
      document.body.classList.toggle('panel-hidden');
      paint();
    }
  });

  wireCrop();
  addEventListener('resize', () => {
    measureChrome();
    if (!state.source || state.zoom === 'actual') return;
    buildPreview();
    schedule();
  });
  measureChrome();
}

function wireCrop() {
  const overlay = el('cropOverlay');
  const rect = el('cropRect');
  let start = null;

  el('cropMode').addEventListener('click', () => {
    state.cropping = !state.cropping;
    state.cropRect = null;
    rect.style.display = 'none';
    overlay.hidden = !state.cropping;
    el('cropActions').hidden = !state.cropping;
    el('cropMode').classList.toggle('active', state.cropping);
  });

  overlay.addEventListener('pointerdown', event => {
    const box = overlay.getBoundingClientRect();
    start = { x: event.clientX - box.left, y: event.clientY - box.top };
    overlay.setPointerCapture(event.pointerId);
  });

  overlay.addEventListener('pointermove', event => {
    if (!start) return;
    const box = overlay.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - box.left), box.width);
    const y = Math.min(Math.max(0, event.clientY - box.top), box.height);
    const left = Math.min(start.x, x), top = Math.min(start.y, y);
    const width = Math.abs(x - start.x), height = Math.abs(y - start.y);
    Object.assign(rect.style, { display: 'block', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    state.cropRect = { left, top, width, height, box: { width: box.width, height: box.height } };
  });

  overlay.addEventListener('pointerup', () => { start = null; });

  el('cropCancel').addEventListener('click', () => el('cropMode').click());
  el('cropApply').addEventListener('click', () => {
    const chosen = state.cropRect;
    if (!chosen || chosen.width < 8 || chosen.height < 8) return;
    const scale = state.source.width / chosen.box.width;
    const crop = {
      x: Math.round(chosen.left * scale),
      y: Math.round(chosen.top * scale),
      w: Math.round(chosen.width * scale),
      h: Math.round(chosen.height * scale),
    };
    crop.w = Math.max(1, Math.min(crop.w, state.source.width - crop.x));
    crop.h = Math.max(1, Math.min(crop.h, state.source.height - crop.y));
    el('cropMode').click();
    cropTo(crop);
  });
}

function start() {
  startWorker();
  buildPresets();
  buildFilterList();
  refreshPanel();
  wire();
  for (const id of ['compare', 'cropMode', 'zoom', 'save', 'reset']) el(id).disabled = true;
  el('status').textContent = 'Ready — open an image to begin.';
}

start();
