// Crop geometry lives in original image pixels, independent of zoom, DPR and window size.
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function pixelCrop(box, image) {
  const x = clamp(Math.round(box.x), 0, image.width - 1);
  const y = clamp(Math.round(box.y), 0, image.height - 1);
  return { x, y, w: clamp(Math.round(box.w), 1, image.width - x),
    h: clamp(Math.round(box.h), 1, image.height - y) };
}

export function fitAspect(box, ratio) {
  if (!ratio) return { ...box };
  const w = Math.min(box.w, box.h * ratio), h = w / ratio;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

export function moveCrop(box, dx, dy, image) {
  return { ...box, x: clamp(box.x + dx, 0, image.width - box.w),
    y: clamp(box.y + dy, 0, image.height - box.h) };
}

export function swapCrop(box, image) {
  const scale = Math.min(1, image.width / box.h, image.height / box.w);
  const w = box.h * scale, h = box.w * scale;
  return { x: clamp(box.x + box.w / 2 - w / 2, 0, image.width - w),
    y: clamp(box.y + box.h / 2 - h / 2, 0, image.height - h), w, h };
}

export function resizeCrop(box, handle, point, image, ratio = 0, centered = false) {
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const ax = centered || !sx ? cx : sx < 0 ? box.x + box.w : box.x;
  const ay = centered || !sy ? cy : sy < 0 ? box.y + box.h : box.y;
  const maxW = centered || !sx ? 2 * Math.min(ax, image.width - ax) : sx < 0 ? ax : image.width - ax;
  const maxH = centered || !sy ? 2 * Math.min(ay, image.height - ay) : sy < 0 ? ay : image.height - ay;
  let w = sx ? Math.max(1, sx * (point.x - ax) * (centered ? 2 : 1)) : box.w;
  let h = sy ? Math.max(1, sy * (point.y - ay) * (centered ? 2 : 1)) : box.h;
  if (ratio) {
    if (!sy || (sx && Math.abs(w - box.w) >= Math.abs(h - box.h) * ratio)) h = w / ratio;
    else w = h * ratio;
    const scale = Math.min(1, maxW / w, maxH / h);
    w *= scale; h *= scale;
  } else {
    w = Math.min(w, maxW); h = Math.min(h, maxH);
  }
  return { x: centered || !sx ? ax - w / 2 : sx < 0 ? ax - w : ax,
    y: centered || !sy ? ay - h / 2 : sy < 0 ? ay - h : ay, w, h };
}

export function drawCrop(start, point, image, ratio = 0) {
  const sx = point.x < start.x ? -1 : 1, sy = point.y < start.y ? -1 : 1;
  const maxW = sx < 0 ? start.x : image.width - start.x;
  const maxH = sy < 0 ? start.y : image.height - start.y;
  let w = Math.min(Math.abs(point.x - start.x), maxW);
  let h = Math.min(Math.abs(point.y - start.y), maxH);
  if (ratio) {
    w = Math.min(Math.max(w, h * ratio), maxW, maxH * ratio);
    h = w / ratio;
  }
  return { x: sx < 0 ? start.x - w : start.x, y: sy < 0 ? start.y - h : start.y, w, h };
}
