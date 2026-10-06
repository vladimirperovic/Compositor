import { EFFECTS, freshSettings } from './effects.js?v=%%V%%';

const KEY = 'darkroom.presets.v1';

// Keep a complete snapshot, including disabled filters, without trusting stale or malformed storage.
export function copySettings(saved) {
  const settings = freshSettings();
  for (const effect of EFFECTS) {
    const source = saved?.[effect.kind];
    if (!source || typeof source !== 'object') continue;
    const target = settings[effect.kind];
    if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
    const controls = [{ field: 'amount', min: 0, max: 100 }, ...effect.controls];
    if (effect.radius) controls.push({ field: 'radius', ...effect.radius });
    for (const [field, value] of Object.entries(target)) {
      if (typeof value !== 'number' || !Number.isFinite(source[field])) continue;
      const control = controls.find(item => item.field === field);
      const min = control?.min ?? 0;
      const max = control?.options ? control.options.length - 1 : control?.max ?? 100;
      target[field] = Math.min(max, Math.max(min, source[field]));
      if (control?.options) target[field] = Math.round(target[field]);
    }
  }
  return settings;
}

export function readPresets(storage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    const ids = new Set();
    return saved.filter(item => {
      if (!item || typeof item.id !== 'string' || !item.id.startsWith('saved-') || ids.has(item.id)
          || typeof item.name !== 'string' || !item.name.trim() || !item.settings) return false;
      ids.add(item.id);
      return true;
    }).map(item => ({
      id: item.id, name: item.name.trim().slice(0, 80), settings: copySettings(item.settings),
      seed: Number.isInteger(item.seed) ? item.seed : 0,
    }));
  } catch {
    return [];
  }
}

export const matchingPreset = (presets, name) => presets.find(item => item.name.toLowerCase() === name.trim().toLowerCase());

export function writePreset(storage, presets, name, settings, seed) {
  name = name.trim();
  if (!name || name.length > 80) throw new Error('Enter a preset name (up to 80 characters).');
  const existing = matchingPreset(presets, name);
  const preset = { id: existing?.id || `saved-${crypto.randomUUID()}`, name, settings: copySettings(settings), seed };
  const updated = existing ? presets.map(item => item.id === existing.id ? preset : item) : [...presets, preset];
  // Only change the menu after persistent storage succeeds.
  storage.setItem(KEY, JSON.stringify(updated));
  return { presets: updated, preset };
}
