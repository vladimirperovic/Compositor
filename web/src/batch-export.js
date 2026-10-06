import { ImageZip, checkCancelled } from './zip.js?v=%%V%%';

export function outputName(name, extension, used) {
  const basename = name.split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  const stem = (basename || 'image').slice(0, 120) + '-darkroom';
  let result = `${stem}.${extension}`;
  let number = 2;
  while (used.has(result.toLowerCase())) result = `${stem}-${number++}.${extension}`;
  used.add(result.toLowerCase());
  return result;
}

// Only one image is decoded/filtered at a time. Callbacks receive a fixed export configuration
// from the editor; opening another image or moving a slider cannot change an in-flight batch.
export async function exportImages(files, { read, render, encode, type, signal, onProgress = () => {} }) {
  const zip = new ImageZip();
  const used = new Set();
  const failures = [];
  let saved = 0;
  for (let index = 0; index < files.length; index += 1) {
    checkCancelled(signal);
    const file = files[index];
    onProgress({ completed: index, total: files.length, name: file.name, saved });
    let blob;
    try {
      const source = await read(file, index);
      checkCancelled(signal);
      const pixels = await render(source, file, index);
      checkCancelled(signal);
      blob = await encode(pixels, source.width, source.height);
      checkCancelled(signal);
      if (!blob || blob.type !== type) throw new Error('The browser could not encode the selected format.');
    } catch (error) {
      checkCancelled(signal);
      failures.push({ name: file.name, message: error.message || 'This image could not be processed.' });
      continue;
    }
    const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
    await zip.add(outputName(file.name, extension, used), blob, signal);
    saved += 1;
  }
  checkCancelled(signal);
  onProgress({ completed: files.length, total: files.length, name: '', saved });
  return { blob: saved ? zip.finish() : null, saved, failures };
}
