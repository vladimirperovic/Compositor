// The filter library, mirroring the desktop app: the same kinds, defaults, ranges and processing order.
// The numbers here are the contract with FinishPixels.c — the kind is what the processor switches on.

export const BASE = {
  enabled: false, amount: 50, shadows: 40, midtones: 60, highlights: 30,
  radius: 16, saturation: 0, palette: 0, contrastType: 0, protectShadows: 0, protectHighlights: 0,
};

const CONTRAST_TYPES = ['Standard', 'High Pass', 'Fine', 'Balanced', 'Strong'];
const PALETTES = ['Carbon', 'Sepia', 'Cyanotype', 'Warm Violet', 'Teal', 'Copper'];
const EDGES = ['Top', 'Bottom', 'Left', 'Right'];

const slider = (label, field, min, max) => ({ type: 'slider', label, field, min, max });
const picker = (label, field, options) => ({ type: 'picker', label, field, options });

export const EFFECTS = [
  {
    kind: 0, key: 'tonalContrast', title: 'Tonal Contrast', group: 'core',
    summary: 'Bring out texture separately in shadows, midtones and highlights.',
    defaults: { enabled: true, amount: 50, radius: 16 },
    radius: { label: 'Detail radius', min: 1, max: 100 },
    controls: [
      picker('Contrast type', 'contrastType', CONTRAST_TYPES),
      slider('Highlights', 'highlights', -100, 100),
      slider('Midtones', 'midtones', -100, 100),
      slider('Shadows', 'shadows', -100, 100),
      slider('Saturation', 'saturation', -100, 100),
      { type: 'heading', text: 'Tone protection' },
      slider('Protect shadows', 'protectShadows', 0, 100),
      slider('Protect highlights', 'protectHighlights', 0, 100),
    ],
  },
  {
    kind: 1, key: 'ink', title: 'Ink', group: 'core',
    summary: 'Photographic paper and ink tones for a stylized final image.',
    defaults: { amount: 60 },
    controls: [picker('Palette', 'palette', PALETTES)],
  },
  {
    kind: 2, key: 'proContrast', title: 'Pro Contrast', group: 'core',
    summary: 'A gentle S-curve for depth, keeping black and white endpoints.',
    defaults: { amount: 40 }, controls: [],
  },
  {
    kind: 3, key: 'detailExtractor', title: 'Detail Extractor', group: 'core',
    summary: 'Reveal material detail and gently balance local lighting.',
    defaults: { amount: 30, radius: 5 },
    radius: { label: 'Detail radius', min: 1, max: 100 },
    controls: [slider('Saturation', 'saturation', -100, 100)],
  },
  {
    kind: 4, key: 'bloom', title: 'Bloom / Glow', group: 'core',
    summary: 'Diffuse bright areas for softer windows, lamps and reflections.',
    defaults: { amount: 25, radius: 24 },
    radius: { label: 'Detail radius', min: 1, max: 100 }, controls: [],
  },
  {
    kind: 5, key: 'warmth', title: 'Brilliance / Warmth', group: 'core',
    summary: 'Balance cool and warm light, and refine color intensity.',
    defaults: { amount: 50, shadows: 20, saturation: 8 },
    controls: [slider('Warmth', 'shadows', -100, 100), slider('Saturation', 'saturation', -100, 100)],
  },
  {
    kind: 6, key: 'vignette', title: 'Vignette', group: 'core',
    summary: 'Darken the edges softly to draw attention toward the center.',
    defaults: { amount: 25 }, controls: [],
  },
  {
    kind: 7, key: 'sensorGrain', title: 'Sensor Grain', group: 'photo',
    summary: 'Fine, film-like grain, strongest in the midtones, that breaks up the too-clean look of CG.',
    defaults: { amount: 30, radius: 1.5 },
    radius: { label: 'Grain size', min: 1, max: 6 }, controls: [],
  },
  {
    kind: 8, key: 'microTexture', title: 'Micro Texture', group: 'photo',
    summary: 'Lift only the finest texture, such as fabric weave and rug fibres, leaving flat areas alone.',
    defaults: { amount: 40, radius: 1 },
    radius: { label: 'Texture scale', min: 1, max: 6 }, controls: [],
  },
  {
    kind: 9, key: 'highlightRolloff', title: 'Highlight Rolloff', group: 'photo',
    summary: 'Ease bright areas into white as a camera does, with a warm halation around windows and lamps.',
    defaults: { amount: 40, highlights: 30, radius: 16 },
    radius: { label: 'Halation radius', min: 1, max: 100 },
    controls: [slider('Halation', 'highlights', 0, 100)],
  },
  {
    kind: 10, key: 'chromaticAberration', title: 'Chromatic Aberration', group: 'photo',
    summary: 'Split red and blue slightly toward the corners, like a real lens.',
    defaults: { amount: 100, radius: 2 },
    radius: { label: 'Fringe at the corners', min: 1, max: 12 }, controls: [],
  },
  {
    kind: 11, key: 'lensSoftness', title: 'Lens Softness', group: 'photo',
    summary: 'Soften the image gradually toward the corners, keeping the center sharp.',
    defaults: { amount: 40, radius: 4 },
    radius: { label: 'Softness radius', min: 1, max: 40 }, controls: [],
  },
  {
    kind: 12, key: 'splitTone', title: 'Split Tone', group: 'cinematic',
    summary: 'Cool the shadows and warm the light, the way a colorist separates them.',
    defaults: { amount: 50, shadows: -35, midtones: 0, highlights: 40 },
    controls: [
      slider('Highlights', 'highlights', -100, 100),
      slider('Midtones', 'midtones', -100, 100),
      slider('Shadows', 'shadows', -100, 100),
      { type: 'note', text: 'Below zero is cool, above zero is warm.' },
    ],
  },
  {
    kind: 13, key: 'graduatedFilter', title: 'Graduated Filter', group: 'cinematic',
    summary: 'Hold back a bright sky or ceiling with a soft graduated filter.',
    defaults: { amount: 35, shadows: 0, midtones: 25, highlights: 45 },
    controls: [
      picker('From', 'contrastType', EDGES),
      slider('Where it ends', 'highlights', 0, 100),
      slider('Softness', 'midtones', 0, 100),
      slider('Warmth', 'shadows', -100, 100),
    ],
  },
  {
    kind: 14, key: 'filmResponse', title: 'Film Response', group: 'cinematic',
    summary: "A negative's toe and shoulder: blacks lift into haze, highlights bend into white.",
    defaults: { amount: 60, shadows: 25, midtones: 25, highlights: 50 },
    controls: [
      slider('Shoulder', 'highlights', 0, 100),
      slider('Midtone curve', 'midtones', -100, 100),
      slider('Lifted blacks', 'shadows', 0, 100),
      slider('Saturation', 'saturation', -100, 100),
    ],
  },
  {
    kind: 15, key: 'cinematicLook', title: 'Cinematic Look', group: 'cinematic',
    summary: 'The whole finishing chain as one filter: film response, warm and cool split, fine texture, '
      + 'diffusion and halation, lens character, vignette and grain.',
    defaults: { amount: 55, shadows: 60, midtones: 50, highlights: 35, radius: 28 },
    radius: { label: 'Glow radius', min: 4, max: 100 },
    controls: [
      slider('Warm / cool split', 'shadows', 0, 100),
      slider('Glow', 'midtones', 0, 100),
      slider('Grain', 'highlights', 0, 100),
    ],
  },
];

export const GROUPS = { core: 'Filters', photo: 'Photo realism', cinematic: 'Cinematic' };

// Tone and detail first, then color, glow, lens and framing; grain sits on top, as a sensor's would,
// and the Cinematic Look plays its own chain last.
export const ORDER = [0, 3, 8, 2, 14, 1, 5, 12, 13, 9, 4, 11, 10, 6, 7, 15];

export const byKind = kind => EFFECTS.find(effect => effect.kind === kind);

export function defaultsFor(effect) {
  return { ...BASE, ...effect.defaults };
}

export function freshSettings() {
  const settings = {};
  for (const effect of EFFECTS) settings[effect.kind] = defaultsFor(effect);
  return settings;
}

/// Whether these settings leave every pixel untouched, so the filter can be skipped.
export function isNeutral(kind, p) {
  if (!p.enabled || p.amount <= 0) return true;
  if (kind === 0) {
    return p.shadows === 0 && p.midtones === 0 && p.highlights === 0 && p.saturation === 0
      && p.protectShadows === 0 && p.protectHighlights === 0;
  }
  if (kind === 5) return p.shadows === 0 && p.saturation === 0;
  if (kind === 12 || kind === 14) {
    return p.shadows === 0 && p.midtones === 0 && p.highlights === 0 && p.saturation === 0;
  }
  return false;
}

// Built-in looks, the same ones the desktop app ships.
const look = (id, name, entries) => ({ id, name, entries });

export const PRESETS = [
  look('natural-interior', 'Natural Interior', {
    0: { amount: 45, contrastType: 3, shadows: 20, midtones: 35, highlights: 10, protectHighlights: 35 },
    5: { amount: 60, shadows: 12, saturation: 6 },
    6: { amount: 15 },
  }),
  look('crisp-exterior', 'Crisp Exterior', {
    0: { amount: 45, contrastType: 0, shadows: 30, midtones: 45, highlights: 25, protectShadows: 20, protectHighlights: 25 },
    3: { amount: 25, radius: 4 },
    2: { amount: 35 },
  }),
  look('evening-glow', 'Evening Glow', {
    0: { amount: 35, contrastType: 3, shadows: 20, midtones: 30, highlights: 10, protectHighlights: 20 },
    4: { amount: 35, radius: 32 },
    5: { amount: 70, shadows: 30, saturation: 5 },
    6: { amount: 25 },
  }),
  look('soft-daylight', 'Soft Daylight', {
    0: { amount: 30, contrastType: 2, shadows: 15, midtones: 25, highlights: 5, protectHighlights: 40 },
    4: { amount: 15, radius: 20 },
    5: { amount: 50, shadows: 6, saturation: 4 },
  }),
  look('photographic', 'Photographic', {
    0: { amount: 35, contrastType: 0, shadows: 20, midtones: 35, highlights: 10, protectHighlights: 30 },
    8: { amount: 35, radius: 1 },
    9: { amount: 45, radius: 18 },
    11: { amount: 30, radius: 4 },
    10: { amount: 100, radius: 1.5 },
    6: { amount: 18 },
    7: { amount: 30, radius: 1.5 },
  }),
  // The post chain behind the film-like CG of the late 2000s: a graded negative, warm light against cool
  // shadows, diffusion and halation through the lens, grain over all of it.
  look('cinema-negative', 'Cinema Negative', {
    0: { amount: 30, contrastType: 3, shadows: 15, midtones: 25, highlights: 5, protectHighlights: 30 },
    15: { amount: 60, shadows: 65, midtones: 50, highlights: 35, radius: 30 },
  }),
  // How commercial visualization is finished instead: glare and bloom, a held-back sky, air in the shadows
  // and restrained color — and no sharpening at all, which is what gives renders away.
  look('studio-daylight', 'Studio Daylight', {
    14: { amount: 55, shadows: 20, midtones: 15, highlights: 45, saturation: -8 },
    13: { amount: 25, contrastType: 0, highlights: 45, midtones: 40, shadows: -8 },
    4: { amount: 30, radius: 36 },
    9: { amount: 35, highlights: 20, radius: 24 },
    6: { amount: 15 },
    7: { amount: 18, radius: 1.5 },
  }),
  look('carbon-monochrome', 'Carbon Monochrome', {
    0: { amount: 40, contrastType: 0, shadows: 30, midtones: 45, highlights: 20 },
    1: { amount: 100 },
    2: { amount: 45 },
    6: { amount: 20 },
  }),
];

export function settingsFor(preset) {
  const settings = freshSettings();
  for (const kind of Object.keys(settings)) settings[kind].enabled = false;
  for (const [kind, values] of Object.entries(preset.entries)) {
    settings[kind] = { ...defaultsFor(byKind(Number(kind))), ...values, enabled: true };
  }
  return settings;
}
