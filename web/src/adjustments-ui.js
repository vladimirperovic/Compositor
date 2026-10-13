import { COLOR_RANGES, freshAdjustments, sampleWhiteBalance } from './adjustments.js?v=%%V%%';

export function wireAdjustments({ state, el, schedule, refreshPanel, paint, redraw }) {
  const overlay = el('retouchOverlay'), ellipse = el('localEllipse'), cursor = el('brushCursor');
  let active = null, picking = false, space = false, gesture = null, previousSplit = null;
  let cursorPoint = null;
  let history = [], future = [], baseline = '';
  let brush = { mode: 'dodge', size: 15, softness: 80, strength: 25 };
  let colorRange = 1;
  const blends = [['soft-light', 'Soft Light'], ['overlay', 'Overlay'], ['normal', 'Normal']];
  const snapshot = () => JSON.stringify(state.adjustments);
  const selectedLayer = () => state.adjustments.layers.find(layer => layer.id === active);
  const crop = () => state.appliedCrop || { x: 0, y: 0, w: state.original?.width || 1, h: state.original?.height || 1 };
  const point = event => {
    const r = overlay.getBoundingClientRect(), c = crop();
    return { x: (c.x + (event.clientX - r.left) / r.width * c.w) / state.original.width,
      y: (c.y + (event.clientY - r.top) / r.height * c.h) / state.original.height };
  };
  const limited = x => Math.min(1, Math.max(0, x));
  const commit = () => {
    const now = snapshot();
    if (baseline && baseline !== now) { history.push(baseline); history = history.slice(-40); future = []; }
    baseline = now;
    el('presets').value = '';
    schedule(); syncHistory(); syncLayerRows();
  };
  function syncHistory() {
    const undo = el('retouchUndo'), redo = el('retouchRedo');
    if (undo) undo.disabled = !history.length;
    if (redo) redo.disabled = !future.length;
  }
  function undo(redo = false) {
    endGesture(true);
    const from = redo ? future : history, to = redo ? history : future;
    if (!from.length) return;
    to.push(snapshot()); state.adjustments = JSON.parse(from.pop()); baseline = snapshot();
    if (!selectedLayer()) active = state.adjustments.layers.at(-1)?.id;
    refreshPanel(); schedule();
  }
  function load() {
    endGesture(true); picking = false; active = state.adjustments.layers.at(-1)?.id;
    history = []; future = []; baseline = snapshot(); sync();
  }
  function changed(quick = false) { schedule(quick); sync(); }
  function select(key) {
    endGesture(true); picking = false;
    if (state.cropping) el('cropCancel').click();
    state.selected = key; refreshPanel();
  }
  for (const [id, key] of [['localLight', 'local'], ['whiteBalance', 'wb'], ['selectiveColor', 'hsl']]) {
    el(id).addEventListener('click', () => select(key));
  }
  function sync() {
    const local = state.selected === 'local' && !state.cropping && !!state.source && document.body.classList.contains('editing');
    const interactive = local || (picking && state.selected === 'wb' && !state.cropping);
    const changedMode = state.retouching !== interactive;
    state.retouching = interactive;
    el('darkroom').classList.toggle('is-retouching', interactive);
    if (interactive && previousSplit === null) { previousSplit = state.split; state.split = false; paint(); }
    if (!interactive && previousSplit !== null) { state.split = previousSplit; previousSplit = null; paint(); }
    overlay.hidden = !interactive;
    el('compare').disabled = !!state.cropping || interactive;
    el('compare').classList.toggle('active', state.split);
    overlay.classList.toggle('sampling', picking);
    overlay.classList.toggle('hand', space);
    updateCursor();
    for (const [id, key] of [['localLight', 'local'], ['whiteBalance', 'wb'], ['selectiveColor', 'hsl']]) {
      el(id).classList.toggle('selected', state.selected === key);
      el(id).disabled = !state.source || !!state.cropping;
    }
    const layer = selectedLayer(), c = crop();
    const wbCheck = el('controls').querySelector('input[aria-label="Enable white balance"]');
    const colorCheck = el('controls').querySelector('input[aria-label="Enable individual colors"]');
    if (wbCheck) wbCheck.checked = state.adjustments.whiteBalance.enabled;
    if (colorCheck) colorCheck.checked = state.adjustments.colors.enabled;
    ellipse.hidden = !local || layer?.type !== 'ellipse';
    if (!ellipse.hidden) {
      const ow = state.original.width, oh = state.original.height;
      Object.assign(ellipse.style, {
        left: `${(layer.x * ow - layer.rx * ow - c.x) / c.w * 100}%`,
        top: `${(layer.y * oh - layer.ry * oh - c.y) / c.h * 100}%`,
        width: `${2 * layer.rx * ow / c.w * 100}%`, height: `${2 * layer.ry * oh / c.h * 100}%`,
      });
    }
    syncHistory();
    syncLayerRows();
    if (changedMode && state.source && state.zoom === 'fit') redraw();
  }
  function syncLayerRows() {
    for (const item of el('controls').querySelectorAll('.local-layer')) {
      const layer = state.adjustments.layers.find(value => value.id === item.dataset.layerId);
      if (!layer) continue;
      item.classList.toggle('muted', !layer.enabled);
      const summary = item.querySelector('.local-layer-summary');
      summary.textContent = `${blends.find(([value]) => value === layer.blend)?.[1] || 'Normal'} · ${layer.opacity}%`;
      const shape = item.querySelector('.layer-mask-shape');
      if (layer.type === 'ellipse') Object.assign(shape.style, {
        left: `${layer.x * 100}%`, top: `${layer.y * 100}%`, width: `${layer.rx * 200}%`, height: `${layer.ry * 200}%`,
      });
    }
  }
  function button(text, action, id) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.className = 'retouch-button'; if (id) b.id = id;
    b.addEventListener('click', action); return b;
  }
  function note(box, text) { const p = document.createElement('p'); p.className = 'summary'; p.textContent = text; box.append(p); }
  function row(box, ...items) { const r = document.createElement('div'); r.className = 'retouch-row'; r.append(...items); box.append(r); return r; }
  function range(box, label, object, field, min, max, onInput = () => changed(true), onChange = commit) {
    const wrap = document.createElement('label'); wrap.className = 'control';
    const head = document.createElement('span'); head.className = 'control-head';
    const name = document.createElement('b'); name.textContent = label;
    const output = document.createElement('output'); output.textContent = object[field];
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max;
    input.step = 1; input.value = object[field]; input.setAttribute('aria-label', label);
    input.addEventListener('input', () => { object[field] = Number(input.value); output.textContent = input.value; onInput(); });
    input.addEventListener('change', onChange); head.append(name, output); wrap.append(head, input); box.append(wrap);
  }
  function choice(box, label, items, value, change) {
    const wrap = document.createElement('label'); wrap.className = 'control'; wrap.textContent = label;
    const select = document.createElement('select'); select.setAttribute('aria-label', label);
    for (const [v, name] of items) select.append(new Option(name, v)); select.value = value;
    select.addEventListener('change', () => change(select.value)); wrap.append(select); box.append(wrap); return select;
  }
  function toggle(box, label, object) {
    const wrap = document.createElement('label'); wrap.className = 'retouch-toggle';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = object.enabled;
    check.setAttribute('aria-label', label); check.addEventListener('change', () => { object.enabled = check.checked; commit(); });
    wrap.append(check, document.createTextNode(label)); box.append(wrap);
  }
  function uniqueName(base) {
    let name = base, suffix = 2;
    while (state.adjustments.layers.some(layer => layer.name === name)) name = `${base} ${suffix++}`;
    return name;
  }
  function add(type) {
    if (state.adjustments.layers.length >= 16) return;
    const c = crop(), ow = state.original.width, oh = state.original.height;
    const layer = { id: crypto.randomUUID(), name: uniqueName(`${type === 'ellipse' ? 'Oval' : 'Brush'} ${state.adjustments.layers.length + 1}`),
      type, enabled: true, blend: 'soft-light', opacity: 100,
      x: (c.x + c.w / 2) / ow, y: (c.y + c.h / 2) / oh, rx: c.w / ow * .22, ry: c.h / oh * .22,
      softness: 80, tone: 35, strokes: [] };
    state.adjustments.layers.push(layer); active = layer.id; commit(); refreshPanel();
  }
  function duplicate() {
    endGesture(true);
    const layer = selectedLayer(), layers = state.adjustments.layers;
    if (!layer || layers.length >= 16) return;
    const copy = structuredClone(layer);
    copy.id = crypto.randomUUID(); copy.name = uniqueName(`${layer.name} copy`);
    layers.splice(layers.indexOf(layer) + 1, 0, copy); active = copy.id;
    commit(); refreshPanel();
  }
  function render(box, key) {
    box.classList.remove('disabled');
    box.classList.add('retouch-controls');
    row(box, button('Undo', () => undo(), 'retouchUndo'), button('Redo', () => undo(true), 'retouchRedo'),
      button('Done', () => select(0), 'retouchDone'));
    if (key === 'local') {
      const heading = document.createElement('div'); heading.className = 'local-layers-heading';
      const title = document.createElement('h3'); title.textContent = 'Layers';
      const count = document.createElement('span'); count.textContent = `${state.adjustments.layers.length} / 16`;
      count.title = 'Up to 16 independent local light layers'; heading.append(title, count); box.append(heading);
      note(box, 'Add an oval for each area you want to adjust. Select a layer below to edit it independently.');
      const actions = row(box, button('+ Oval', () => add('ellipse'), 'addOval'), button('+ Brush layer', () => add('brush'), 'addBrush'));
      for (const b of actions.children) b.disabled = state.adjustments.layers.length >= 16;
      const list = document.createElement('div'); list.className = 'local-layers'; list.setAttribute('aria-label', 'Local light layers');
      for (const layer of [...state.adjustments.layers].reverse()) {
        const item = document.createElement('div'); item.className = 'local-layer'; item.classList.toggle('selected', layer.id === active);
        item.dataset.layerId = layer.id;
        toggle(item, `Show ${layer.name}`, layer);
        const pick = button('', () => { endGesture(true); active = layer.id; refreshPanel(); });
        pick.setAttribute('aria-label', layer.name); pick.setAttribute('aria-pressed', String(layer.id === active));
        const mask = document.createElement('span'); mask.className = `layer-mask ${layer.type}`; mask.setAttribute('aria-hidden', 'true');
        const shape = document.createElement('span'); shape.className = 'layer-mask-shape'; mask.append(shape);
        const caption = document.createElement('span'); caption.className = 'local-layer-caption';
        const name = document.createElement('strong'); name.textContent = layer.name;
        const summary = document.createElement('span'); summary.className = 'local-layer-summary'; caption.append(name, summary);
        pick.append(mask, caption); item.append(pick); list.append(item);
      }
      box.append(list);
      const layer = selectedLayer();
      if (layer) {
        const index = state.adjustments.layers.indexOf(layer);
        const move = delta => {
          const target = index + delta;
          if (target < 0 || target >= state.adjustments.layers.length) return;
          state.adjustments.layers.splice(index, 1); state.adjustments.layers.splice(target, 0, layer); commit(); refreshPanel();
        };
        const up = button('↑', () => move(1)); up.setAttribute('aria-label', 'Move up'); up.title = 'Move layer up'; up.disabled = index === state.adjustments.layers.length - 1;
        const down = button('↓', () => move(-1)); down.setAttribute('aria-label', 'Move down'); down.title = 'Move layer down'; down.disabled = index === 0;
        const copy = button('Duplicate', duplicate, 'duplicateLocalLayer'); copy.disabled = state.adjustments.layers.length >= 16;
        row(box, up, down, copy, button('Delete layer', () => {
          state.adjustments.layers.splice(index, 1); active = state.adjustments.layers.at(-1)?.id; commit(); refreshPanel();
        }, 'deleteLocalLayer')).classList.add('local-layer-actions');
        const properties = document.createElement('section'); properties.className = 'local-layer-properties';
        properties.setAttribute('aria-label', 'Selected layer settings'); box.append(properties);
        const label = document.createElement('label'); label.className = 'control'; label.textContent = 'Layer name';
        const name = document.createElement('input'); name.type = 'text'; name.maxLength = 80; name.value = layer.name;
        name.setAttribute('aria-label', 'Layer name'); name.className = 'layer-name';
        name.addEventListener('change', () => { layer.name = name.value.trim() || 'Local light'; commit(); refreshPanel(); }); label.append(name); properties.append(label);
        choice(properties, 'Blend mode', blends, layer.blend,
          value => { layer.blend = value; commit(); });
        range(properties, 'Layer opacity', layer, 'opacity', 0, 100);
        if (layer.type === 'ellipse') {
          range(properties, 'Light / dark', layer, 'tone', -100, 100);
          range(properties, 'Oval softness', layer, 'softness', 0, 100);
          note(properties, 'Drag this oval to move it; drag a corner to resize. Negative light darkens. Add another oval with + Oval.');
        } else {
          choice(properties, 'Brush action', [['dodge', 'White · lighten'], ['burn', 'Black · darken'], ['erase', 'Erase to neutral']], brush.mode,
            value => { brush.mode = value; });
          range(properties, 'Brush size', brush, 'size', 1, 100, () => updateCursor(), () => {});
          range(properties, 'Brush softness', brush, 'softness', 0, 100, () => {}, () => {});
          range(properties, 'Brush strength', brush, 'strength', 1, 100, () => {}, () => {});
          note(properties, 'Paint on the image. X swaps white / black; Space + drag pans. Each stroke can be undone.');
        }
      } else note(box, 'Add an oval or a brush layer to begin. Up to 16 independent layers.');
    } else if (key === 'wb') {
      const w = state.adjustments.whiteBalance;
      note(box, 'Pick a surface that should be neutral grey or white. The pipette averages nearby original pixels; manual controls refine the result.');
      toggle(box, 'Enable white balance', w);
      row(box, button(picking ? 'Cancel pipette' : 'Pick neutral point', () => { picking = !picking; refreshPanel(); }, 'pickWhite'),
        button('Reset white balance', () => { state.adjustments.whiteBalance = freshAdjustments().whiteBalance; picking = false; commit(); refreshPanel(); }));
      range(box, 'WB strength', w, 'strength', 0, 100);
      range(box, 'Temperature', w, 'temperature', -100, 100, () => { w.enabled = true; changed(true); });
      range(box, 'Tint', w, 'tint', -100, 100, () => { w.enabled = true; changed(true); });
      const status = document.createElement('p'); status.id = 'whiteBalanceStatus'; status.className = 'control-note'; status.setAttribute('role', 'status');
      status.textContent = picking ? 'Click a neutral surface in the image. Escape cancels.' : 'Temperature: cool to warm. Tint: green to magenta.'; box.append(status);
    } else {
      const colors = state.adjustments.colors;
      note(box, 'Adjust a color range throughout the image, with smooth transitions into neighbouring colors.');
      toggle(box, 'Enable individual colors', colors);
      choice(box, 'Color range', COLOR_RANGES.map(([name], i) => [i, name]), colorRange, value => { colorRange = Number(value); refreshPanel(); });
      const rangeSettings = colors.ranges[colorRange];
      const update = () => { colors.enabled = true; changed(true); };
      range(box, 'Hue', rangeSettings, 'hue', -30, 30, update);
      range(box, 'Saturation', rangeSettings, 'saturation', -100, 100, update);
      range(box, 'Lightness', rangeSettings, 'lightness', -100, 100, update);
      row(box, button('Reset this color', () => { colors.ranges[colorRange] = { hue: 0, saturation: 0, lightness: 0 }; commit(); refreshPanel(); }));
    }
    sync();
    const list = box.querySelector('.local-layers'), selected = list?.querySelector('.selected');
    // Only scroll the rebuilt layer list, keeping the surrounding settings in place.
    if (selected) list.scrollTop += Math.max(0, selected.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom);
  }
  function endGesture(cancelled = false) {
    if (!gesture) return;
    const old = gesture; gesture = null;
    state.retouchGesture = false;
    if (old.before) {
      if (cancelled) { state.adjustments = JSON.parse(old.before); changed(); refreshPanel(); }
      else { commit(); sync(); }
    }
    if (overlay.hasPointerCapture(old.pointer)) overlay.releasePointerCapture(old.pointer);
    overlay.classList.remove('painting');
  }
  overlay.addEventListener('pointerdown', event => {
    if (gesture || !state.source) return;
    cursorPoint = { x: event.clientX, y: event.clientY };
    if (event.button === 1 || (space && event.button === 0)) {
      gesture = { pointer: event.pointerId, pan: true, x: event.clientX, y: event.clientY, left: el('stage').scrollLeft, top: el('stage').scrollTop };
    } else if (event.button !== 0) return;
    else if (picking) {
      const p = point(event), c = crop();
      try {
        const gains = sampleWhiteBalance(state.source, Math.round(p.x * state.original.width - c.x), Math.round(p.y * state.original.height - c.y));
        Object.assign(state.adjustments.whiteBalance, { enabled: true, gains, temperature: 0, tint: 0 });
        picking = false; commit(); refreshPanel(); el('whiteBalanceStatus').textContent = 'Neutral point sampled. Fine-tune with Temperature and Tint.';
      } catch (error) { el('whiteBalanceStatus').textContent = error.message; }
      event.preventDefault(); event.stopPropagation(); return;
    } else {
      const layer = selectedLayer();
      if (!layer || !layer.enabled) return;
      const p = point(event);
      gesture = { pointer: event.pointerId, before: snapshot(), start: p, layer, from: { ...layer }, handle: event.target.dataset.handle };
      state.retouchGesture = true;
      if (layer.type === 'brush') {
        gesture.stroke = { mode: brush.mode, radius: brush.size / 200, softness: brush.softness, strength: brush.strength, points: [[p.x, p.y]] };
        layer.strokes.push(gesture.stroke); changed(true);
      }
    }
    overlay.setPointerCapture(event.pointerId); overlay.classList.add('painting'); event.preventDefault(); event.stopPropagation();
  });
  function updateCursor() {
    const layer = selectedLayer();
    cursor.hidden = overlay.hidden || state.selected !== 'local' || picking || layer?.type !== 'brush'
      || !layer.enabled || space || gesture?.pan || !cursorPoint;
    if (!cursor.hidden) {
      const r = overlay.getBoundingClientRect(), c = crop();
      const diameter = brush.size / 100 * Math.min(state.original.width, state.original.height);
      Object.assign(cursor.style, { left: `${cursorPoint.x - r.left}px`, top: `${cursorPoint.y - r.top}px`, width: `${diameter / c.w * r.width}px`, height: `${diameter / c.h * r.height}px` });
    }
  }
  overlay.addEventListener('pointermove', event => {
    cursorPoint = { x: event.clientX, y: event.clientY }; updateCursor();
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (gesture.pan) {
      el('stage').scrollLeft = gesture.left + gesture.x - event.clientX; el('stage').scrollTop = gesture.top + gesture.y - event.clientY; return;
    }
    const p = point(event), g = gesture;
    if (g.stroke) {
      const last = g.stroke.points.at(-1);
      const distance = Math.hypot((p.x - last[0]) * state.original.width, (p.y - last[1]) * state.original.height);
      if (distance < Math.max(.5, g.stroke.radius * Math.min(state.original.width, state.original.height) / 10)) return;
      // Bound a single gesture's command size without losing the latest location.
      if (g.stroke.points.length >= 8192) g.stroke.points = g.stroke.points.filter((_, i) => i % 2 === 0);
      g.stroke.points.push([p.x, p.y]);
    } else if (g.handle) {
      g.layer.rx = Math.max(.002, Math.min(1, Math.abs(p.x - g.from.x)));
      g.layer.ry = Math.max(.002, Math.min(1, Math.abs(p.y - g.from.y)));
    } else {
      g.layer.x = limited(g.from.x + p.x - g.start.x); g.layer.y = limited(g.from.y + p.y - g.start.y);
    }
    changed(true); event.preventDefault(); event.stopPropagation();
  });
  overlay.addEventListener('pointerup', () => endGesture());
  overlay.addEventListener('pointercancel', () => endGesture(true));
  overlay.addEventListener('lostpointercapture', () => endGesture(true));
  overlay.addEventListener('pointerleave', () => { cursorPoint = null; cursor.hidden = true; });
  overlay.addEventListener('dblclick', event => event.stopPropagation());
  overlay.addEventListener('wheel', event => { if (gesture) { event.preventDefault(); event.stopPropagation(); } }, { passive: false });
  // End a stroke before crop/open/reset alters the underlying document.
  el('cropMode').addEventListener('click', () => { endGesture(true); picking = false; }, true);
  new ResizeObserver(() => { if (gesture) endGesture(true); sync(); }).observe(overlay);
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe(el('cropOverlay'), { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('blur', () => { endGesture(true); space = false; sync(); });
  window.addEventListener('keyup', event => { if (event.code === 'Space') { space = false; sync(); } });
  window.addEventListener('keydown', event => {
    if (event.target.closest?.('input, select, textarea, [contenteditable]') || state.cropping) return;
    if (!['local', 'wb', 'hsl'].includes(state.selected)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
    else if (event.key === 'Escape' && (gesture || picking || state.selected === 'local')) {
      event.preventDefault(); endGesture(true); picking = false; state.selected = 0; refreshPanel();
    } else if (state.retouching && event.code === 'Space') { event.preventDefault(); space = true; sync(); }
    else if (state.selected === 'local' && event.key.toLowerCase() === 'x') {
      event.preventDefault(); brush.mode = brush.mode === 'burn' ? 'dodge' : 'burn'; refreshPanel();
    }
  }, true);
  baseline = snapshot();
  return { render, sync, load, cancel: () => endGesture(true), reset: () => { endGesture(true); state.adjustments = freshAdjustments(); commit(); refreshPanel(); } };
}
