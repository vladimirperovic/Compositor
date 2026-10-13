import { clamp, pixelCrop, fitAspect, moveCrop, swapCrop, resizeCrop, drawCrop } from './crop.js?v=%%V%%';

export function wireCrop({ state, el, showOriginal, restore, apply, redraw, updateControls }) {
  const overlay = el('cropOverlay'), rect = el('cropRect');
  const stage = el('stage');
  let box = null, drag = null, swapped = false, space = false, pan = null;
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
    // Follow the image in the same layout pass as zoom/Fit, before ResizeObserver runs.
    // A stale pixel-sized rectangle can otherwise keep the fitted stage scrolled.
    const sx = 100 / image().width, sy = 100 / image().height;
    Object.assign(rect.style, { display: 'block', left: `${box.x * sx}%`,
      top: `${box.y * sy}%`, width: `${box.w * sx}%`, height: `${box.h * sy}%` });
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
    for (const id of ['save', 'compare']) el(id).disabled = enabled;
    updateControls();
    if (!enabled) {
      drag = null;
      endPan();
      space = false;
      stage.classList.remove('crop-hand');
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
    swapped = false;
    swapBack = null;
    el('cropRatio').value = '0';
    // The full original is only a preview while cropping; the saved crop remains unchanged until Apply.
    active(true);
    showOriginal();
    for (const id of ['save', 'compare']) el(id).disabled = true;
    place();
  });
  const point = event => {
    const frame = overlay.getBoundingClientRect();
    return { x: (event.clientX - frame.left) * image().width / frame.width,
      y: (event.clientY - frame.top) * image().height / frame.height };
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
    drag = { at, from: { ...box }, handle, mode, pointer: event.pointerId,
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
      box = moveCrop(drag.from, dx, dy, image());
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
    if (cancelled || box.w < 1 || box.h < 1) box = previous.from;
    if (overlay.hasPointerCapture(previous.pointer)) overlay.releasePointerCapture(previous.pointer);
    place();
  };
  overlay.addEventListener('pointerup', () => endDrag(false));
  overlay.addEventListener('pointercancel', () => endDrag(true));
  overlay.addEventListener('lostpointercapture', () => endDrag(true));
  // Space-drag (or the middle button) pans the zoomed view without changing the crop pixels.
  const endPan = () => {
    const previous = pan;
    pan = null;
    stage.classList.remove('crop-panning');
    if (previous && stage.hasPointerCapture(previous.pointer)) stage.releasePointerCapture(previous.pointer);
  };
  stage.addEventListener('pointerdown', event => {
    if (!state.cropping || pan || drag
      || !(event.button === 1 || (space && event.button === 0))) return;
    pan = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('crop-panning');
    event.preventDefault();
    event.stopPropagation();
  }, true);
  stage.addEventListener('pointermove', event => {
    if (!pan || event.pointerId !== pan.pointer) return;
    stage.scrollLeft = pan.left + pan.x - event.clientX;
    stage.scrollTop = pan.top + pan.y - event.clientY;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, endPan);
  overlay.addEventListener('dblclick', event => { event.stopPropagation(); finish(true); });
  el('cropCancel').addEventListener('click', () => finish(false));
  el('cropApply').addEventListener('click', () => finish(true));
  el('cropReset').addEventListener('click', () => {
    swapBack = null;
    endDrag(true); box = whole();
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
    place();
  });
  new ResizeObserver(() => { endDrag(true); place(); }).observe(overlay);
  new ResizeObserver(() => {
    if (!state.cropping) return;
    el('darkroom').style.setProperty('--crop-actions-height', `${el('cropActions').offsetHeight}px`);
    redraw();
  }).observe(el('cropActions'));
  window.addEventListener('blur', () => {
    endDrag(true); endPan(); space = false; stage.classList.remove('crop-hand');
  });
  window.addEventListener('keyup', event => {
    if (event.code === 'Space') { space = false; stage.classList.remove('crop-hand'); }
  });
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const typing = event.target.closest?.('input, select, textarea, [contenteditable]');
    if (!state.cropping) {
      if (!typing && event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && state.source) {
        event.preventDefault(); el('cropMode').click();
      }
      return;
    }
    if (event.code === 'Space' && !typing) {
      event.preventDefault(); space = true; stage.classList.add('crop-hand');
    }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    else if (event.key === 'Enter' && !typing) { event.preventDefault(); finish(true); }
    else if (!typing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      swapBack = null;
      event.preventDefault(); endDrag(true);
      const step = event.shiftKey ? 10 : 1;
      box = moveCrop(box, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, image());
      place();
    }
  });
}
