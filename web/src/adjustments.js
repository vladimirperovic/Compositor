// Browser finishing tools. Positions belong to the original image, not the current crop or preview.
export const COLOR_RANGES = [
  ['Reds', 0], ['Oranges', 30], ['Yellows', 60], ['Greens', 120],
  ['Aquas', 180], ['Blues', 240], ['Purples', 270], ['Magentas', 300],
];
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const number = (x, fallback, lo, hi) => Number.isFinite(x) ? clamp(x, lo, hi) : fallback;
export const freshAdjustments = () => ({
  whiteBalance: { enabled: false, gains: [1, 1, 1], temperature: 0, tint: 0, strength: 100 },
  colors: { enabled: false, ranges: COLOR_RANGES.map(() => ({ hue: 0, saturation: 0, lightness: 0 })) },
  layers: [],
});
export function copyAdjustments(value, includeLayers = true) {
  const result = freshAdjustments();
  const wb = value?.whiteBalance;
  if (wb) {
    result.whiteBalance = {
      enabled: wb.enabled === true,
      gains: [0, 1, 2].map(i => number(wb.gains?.[i], 1, .25, 4)),
      temperature: number(wb.temperature, 0, -100, 100), tint: number(wb.tint, 0, -100, 100),
      strength: number(wb.strength, 100, 0, 100),
    };
  }
  result.colors.enabled = value?.colors?.enabled === true;
  result.colors.ranges = COLOR_RANGES.map((_, i) => ({
    hue: number(value?.colors?.ranges?.[i]?.hue, 0, -30, 30),
    saturation: number(value?.colors?.ranges?.[i]?.saturation, 0, -100, 100),
    lightness: number(value?.colors?.ranges?.[i]?.lightness, 0, -100, 100),
  }));
  // Layers only come from this editor's in-memory document; reusable looks contain colors, not masks.
  if (includeLayers && Array.isArray(value?.layers)) result.layers = structuredClone(value.layers);
  return result;
}
export function sampleWhiteBalance(image, x, y) {
  const sums = [0, 0, 0]; let count = 0;
  for (let yy = Math.max(0, y - 2); yy <= Math.min(image.height - 1, y + 2); yy++) {
    for (let xx = Math.max(0, x - 2); xx <= Math.min(image.width - 1, x + 2); xx++) {
      const at = (yy * image.width + xx) * 4;
      if (image.data[at + 3] < 250) continue;
      const rgb = image.data.subarray(at, at + 3);
      if (Math.min(...rgb) < 8 || Math.max(...rgb) > 247) continue;
      rgb.forEach((v, c) => sums[c] += v); count++;
    }
  }
  if (!count) throw new Error('Pick a neutral grey or white surface with detail, away from clipped lights and deep shadows.');
  const rgb = sums.map(v => v / count);
  const grey = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  return rgb.map(v => clamp(grey / v, .25, 4));
}
export function hasColors(a) {
  const w = a.whiteBalance;
  return (w.enabled && w.strength > 0 && (w.temperature || w.tint || w.gains.some(v => v !== 1)))
    || (a.colors.enabled && a.colors.ranges.some(v => v.hue || v.saturation || v.lightness));
}
export function applyColors(data, a) {
  if (!hasColors(a)) return data;
  const w = a.whiteBalance;
  const mix = w.enabled ? w.strength / 100 : 0;
  const gains = w.gains.map((g, i) => 1 + mix * (g * Math.pow(2,
    (i === 0 ? w.temperature / 160 : i === 2 ? -w.temperature / 160 : -w.tint / 160)) - 1));
  const ranges = a.colors.ranges;
  const color = a.colors.enabled && ranges.some(v => v.hue || v.saturation || v.lightness);
  for (let p = 0; p < data.length; p += 4) {
    if (!data[p + 3]) continue;
    let r = clamp(data[p] / 255 * gains[0]), g = clamp(data[p + 1] / 255 * gains[1]), b = clamp(data[p + 2] / 255 * gains[2]);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (color && delta > .00001) {
      let h = (max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60;
      h = (h + 360) % 360;
      let l = (max + min) / 2, s = delta / (1 - Math.abs(2 * l - 1));
      let i = COLOR_RANGES.length - 1;
      while (i > 0 && COLOR_RANGES[i][1] > h) i--;
      const next = (i + 1) % COLOR_RANGES.length;
      let t = (h - COLOR_RANGES[i][1]) / ((next ? COLOR_RANGES[next][1] : 360) - COLOR_RANGES[i][1]);
      t = t * t * (3 - 2 * t);
      const at = field => ranges[i][field] * (1 - t) + ranges[next][field] * t;
      h = ((h + at('hue') + 360) % 360) / 60;
      s = clamp(s * (1 + at('saturation') / 100));
      const light = at('lightness') / 100;
      l = clamp(l + (light > 0 ? (1 - l) * light : l * light));
      const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
      const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
      [r, g, b] = rgb.map(v => v + m);
    }
    data[p] = r * 255; data[p + 1] = g * 255; data[p + 2] = b * 255;
  }
  return data;
}

// W3C compositing-1: Soft Light and Overlay, with 50% grey exactly neutral.
export function blendChannel(base, paint, mode) {
  if (mode === 'overlay') return base <= .5 ? 2 * base * paint : 1 - 2 * (1 - base) * (1 - paint);
  if (mode === 'normal') return paint;
  if (paint <= .5) return base - (1 - 2 * paint) * base * (1 - base);
  const d = base <= .25 ? ((16 * base - 12) * base + 4) * base : Math.sqrt(base);
  return base + (2 * paint - 1) * (d - base);
}
const falloff = (distance, softness) => {
  if (distance >= 1) return 0;
  const feather = Math.max(.001, softness / 100);
  const t = clamp((1 - distance) / feather);
  return t * t * (3 - 2 * t);
};

export function applyLocal(data, width, height, layers, geometry, place) {
  // Coordinates in original pixels; using one scalar radius keeps brushes circular at every crop ratio.
  const { originalWidth: ow, originalHeight: oh, crop } = geometry;
  const sx = crop.w / place.fullWidth, sy = crop.h / place.fullHeight;
  const originX = crop.x + place.x * sx, originY = crop.y + place.y * sy;
  for (const layer of layers) {
    if (!layer.enabled || !layer.opacity) continue;
    const mask = new Float32Array(width * height);
    if (layer.type === 'ellipse') {
      const rx = Math.max(1, layer.rx * ow), ry = Math.max(1, layer.ry * oh);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dx = (originX + (x + .5) * sx - layer.x * ow) / rx;
        const dy = (originY + (y + .5) * sy - layer.y * oh) / ry;
        mask[y * width + x] = falloff(Math.hypot(dx, dy), layer.softness) * layer.tone / 100;
      }
    } else {
      for (const stroke of layer.strokes) {
        if (!stroke.points.length) continue;
        const radius = Math.max(1, stroke.radius * Math.min(ow, oh));
        // A stroke is a soft continuous capsule, not repeated dabs that get darker with mouse speed.
        const points = stroke.points.map(p => [(p[0] * ow - originX) / sx, (p[1] * oh - originY) / sy]);
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        const left = Math.max(0, Math.floor(Math.min(...xs) - radius / sx));
        const top = Math.max(0, Math.floor(Math.min(...ys) - radius / sy));
        const right = Math.min(width, Math.ceil(Math.max(...xs) + radius / sx));
        const bottom = Math.min(height, Math.ceil(Math.max(...ys) + radius / sy));
        if (right <= left || bottom <= top) continue;
        const bw = right - left, coverage = new Float32Array(bw * (bottom - top));
        for (let n = 0; n < points.length; n++) {
          const a = points[Math.max(0, n - 1)], b = points[n];
          const vx = (b[0] - a[0]) * sx, vy = (b[1] - a[1]) * sy, len = vx * vx + vy * vy;
          const x0 = Math.max(left, Math.floor(Math.min(a[0], b[0]) - radius / sx));
          const x1 = Math.min(right, Math.ceil(Math.max(a[0], b[0]) + radius / sx));
          const y0 = Math.max(top, Math.floor(Math.min(a[1], b[1]) - radius / sy));
          const y1 = Math.min(bottom, Math.ceil(Math.max(a[1], b[1]) + radius / sy));
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const dx = (x + .5 - a[0]) * sx, dy = (y + .5 - a[1]) * sy;
            const t = len ? clamp((dx * vx + dy * vy) / len) : 0;
            const f = falloff(Math.hypot(dx - t * vx, dy - t * vy) / radius, stroke.softness);
            const at = (y - top) * bw + x - left;
            coverage[at] = Math.max(coverage[at], f);
          }
        }
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          const f = coverage[(y - top) * bw + x - left] * stroke.strength / 100;
          const at = y * width + x;
          mask[at] += ((stroke.mode === 'erase' ? 0 : stroke.mode === 'burn' ? -1 : 1) - mask[at]) * f;
        }
      }
    }
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p] || !data[p * 4 + 3]) continue;
      const amount = layer.opacity / 100;
      for (let c = 0; c < 3; c++) {
        const at = p * 4 + c, base = data[at] / 255;
        // Normal shows the white/black paint itself; untouched neutral pixels remain transparent.
        const strength = layer.blend === 'normal' ? amount * Math.abs(mask[p]) : amount;
        const paint = layer.blend === 'normal' ? (mask[p] > 0 ? 1 : 0) : .5 + mask[p] / 2;
        data[at] = 255 * (base + (blendChannel(base, paint, layer.blend) - base) * strength);
      }
    }
  }
  return data;
}
