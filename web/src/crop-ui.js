import { clamp, pixelCrop, fitAspect, moveCrop, swapCrop, resizeCrop, drawCrop } from './crop.js?v=%%V%%';

export function wireCrop({ state, el, canvas, showOriginal, restore, apply, redraw, updateControls }) {
  const overlay = el('cropOverlay'), rect = el('cropRect');
  let box = null, drag = null, offset = { x: 0, y: 0 }, swapped = false;
  let swapBack = null;
  const image = () => state.original;
  const whole = () => ({ x: 0, y: 0, w: image().width, h: image().height });
  const ratio = () => {
    const value = el('cropRatio').value;
    const aspect = value === 'original' ? image().width / image().height : Number(value);
    return aspect && swapped ? 1 / aspect : aspect;
  };
  for (const line of ['v1', 'v2', 'h1', 'h2']) {
    const guide = document.createElement('div');
    guide.className = `third ${line[0]}`;
    guide.style[line[0] === 'v' ? 'left' : 'top'] = line[1] === '1' ? '33.333%' : '66.666%';
    rect.append(guide);
  }
  for (const handle of ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se']) {
    const node = document.createElement('div');
    node.className = `crop-handle ${handle}`;
    node.dataset.handle = handle;
    rect.append(node);
    if (handle.length === 1) {
      const edge = document.createElement('div');
      edge.className = `crop-edge ${handle}`;
      edge.dataset.handle = handle;
      rect.prepend(edge);
    }
  }
  const place = () => {
    if (!state.cropping || !box) return;
    const sx = overlay.clientWidth / image().width, sy = overlay.clientHeight / image().height;
    Object.assign(rect.style, { display: 'block', left: `${(box.x + offset.x) * sx}px`,
      top: `${(box.y + offset.y) * sy}px`, width: `${box.w * sx}px`, height: `${box.h * sy}px` });
    canvas.style.transform = `translate(${offset.x * sx}px, ${offset.y * sy}px)`;
    const pixels = pixelCrop(box, image());
    el('cropSize').textContent = `${pixels.w} × ${pixels.h} px`;
    el('cropApply').disabled = box.w < 1 || box.h < 1;
    state.cropRect = { ...box };
  };
  const active = enabled => {
    state.cropping = enabled;
    state.holding = false;
    overlay.hidden = !enabled;
    el('cropActions').hidden = !enabled;
    if (enabled) {
      el('importNotice').hidden = true;
      el('darkroom').style.setProperty('--crop-actions-height', `${el('cropActions').offsetHeight}px`);
    }
    el('cropMode').classList.toggle('active', enabled);
    el('cropMode').setAttribute('aria-pressed', String(enabled));
    el('darkroom').classList.toggle('is-cropping', enabled);
    for (const id of ['save', 'zoom', 'compare']) el(id).disabled = enabled;
    updateControls();
    if (!enabled) {
      drag = null;
      offset = { x: 0, y: 0 };
      canvas.style.transform = '';
      rect.style.display = 'none';
      state.cropRect = null;
    }
  };
  const finish = commit => {
    if (!state.cropping || (commit && el('cropApply').disabled)) return;
    const selected = pixelCrop(box, image());
    active(false);
    if (commit) apply(selected);
    else restore();
    el('cropMode').focus({ preventScroll: true });
  };
  el('cropMode').addEventListener('click', () => {
    if (state.cropping) { finish(false); return; }
    if (!image()) return;
    box = state.appliedCrop ? { ...state.appliedCrop } : whole();
    offset = { x: 0, y: 0 };
    swapped = false;
    swapBack = null;
    el('cropRatio').value = '0';
    // The full original is only a preview while cropping; the saved crop remains unchanged until Apply.
    active(true);
    showOriginal();
    for (const id of ['save', 'zoom', 'compare']) el(id).disabled = true;
    place();
  });
  const point = event => {
    const frame = overlay.getBoundingClientRect();
    return { x: (event.clientX - frame.left) * image().width / frame.width - offset.x,
      y: (event.clientY - frame.top) * image().height / frame.height - offset.y };
  };
  overlay.addEventListener('pointerdown', event => {
    if (!state.cropping || event.button !== 0 || drag) return;
    swapBack = null;
    const at = point(event);
    const handle = event.target.closest('[data-handle]')?.dataset.handle;
    const inside = at.x >= box.x && at.x <= box.x + box.w && at.y >= box.y && at.y <= box.y + box.h;
    const full = box.w === image().width && box.h === image().height;
    const mode = handle ? 'resize' : inside && !full ? 'move' : 'draw';
    at.x = clamp(at.x, 0, image().width); at.y = clamp(at.y, 0, image().height);
    drag = { at, from: { ...box }, offset: { ...offset }, handle, mode, pointer: event.pointerId,
      clientX: event.clientX, clientY: event.clientY, frame: overlay.getBoundingClientRect() };
    overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  overlay.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = (event.clientX - drag.clientX) * image().width / drag.frame.width;
    const dy = (event.clientY - drag.clientY) * image().height / drag.frame.height;
    const at = { x: drag.at.x + dx, y: drag.at.y + dy };
    const aspect = ratio() || (event.shiftKey ? (drag.mode === 'draw' ? 1 : drag.from.w / drag.from.h) : 0);
    if (drag.mode === 'move') {
      box = moveCrop(drag.from, -dx, -dy, image());
      // Move the photograph with the pointer, keeping the crop frame stationary on screen.
      offset = { x: drag.offset.x + drag.from.x - box.x, y: drag.offset.y + drag.from.y - box.y };
    } else if (drag.mode === 'resize') {
      box = resizeCrop(drag.from, drag.handle, at, image(), aspect, event.altKey);
    } else {
      box = drawCrop(drag.at, at, image(), aspect);
    }
    place();
  });
  const endDrag = cancelled => {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancelled || box.w < 1 || box.h < 1) { box = previous.from; offset = previous.offset; }
    if (overlay.hasPointerCapture(previous.pointer)) overlay.releasePointerCapture(previous.pointer);
    place();
  };
  overlay.addEventListener('pointerup', () => endDrag(false));
  overlay.addEventListener('pointercancel', () => endDrag(true));
  overlay.addEventListener('lostpointercapture', () => endDrag(true));
  overlay.addEventListener('dblclick', event => { event.stopPropagation(); finish(true); });
  el('cropCancel').addEventListener('click', () => finish(false));
  el('cropApply').addEventListener('click', () => finish(true));
  el('cropReset').addEventListener('click', () => {
    swapBack = null;
    endDrag(true); offset = { x: 0, y: 0 }; box = whole();
    el('cropRatio').value = '0'; swapped = false; place();
  });
  el('cropRatio').addEventListener('change', () => {
    swapBack = null;
    endDrag(true); swapped = false; box = fitAspect(box, ratio()); place();
  });
  el('cropSwap').addEventListener('click', () => {
    endDrag(true);
    swapped = !swapped;
    if (swapBack) { box = swapBack; swapBack = null; }
    else { swapBack = { ...box }; box = swapCrop(box, image()); }
    offset = { x: 0, y: 0 };
    place();
  });
  new ResizeObserver(() => { endDrag(true); place(); }).observe(overlay);
  new ResizeObserver(() => {
    if (!state.cropping) return;
    el('darkroom').style.setProperty('--crop-actions-height', `${el('cropActions').offsetHeight}px`);
    redraw();
  }).observe(el('cropActions'));
  window.addEventListener('blur', () => endDrag(true));
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const typing = event.target.closest?.('input, select, textarea, [contenteditable]');
    if (!state.cropping) {
      if (!typing && event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && state.source) {
        event.preventDefault(); el('cropMode').click();
      }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    else if (event.key === 'Enter' && !typing) { event.preventDefault(); finish(true); }
    else if (!typing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      swapBack = null;
      event.preventDefault(); endDrag(true);
      const step = event.shiftKey ? 10 : 1;
      const moved = moveCrop(box, event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0,
        event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0, image());
      offset.x += box.x - moved.x; offset.y += box.y - moved.y; box = moved; place();
    }
  });
}
