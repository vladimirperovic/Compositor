// Run with Node and Python available: node scripts/tests/web-batch.test.mjs
// Python's independent ZIP reader checks the actual archive records, names, payloads and CRCs.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ImageZip } from '../../web/src/zip.js';
import { exportImages, outputName } from '../../web/src/batch-export.js';

const used = new Set();
assert.equal(outputName('Čačak.JPG', 'png', used), 'Čačak-darkroom.png');
assert.equal(outputName('čačak.png', 'png', used), 'čačak-darkroom-2.png');
assert.equal(outputName('../folder/render.jpg', 'webp', used), 'render-darkroom.webp');
assert.equal(outputName('C:\\folder\\render.jpg', 'webp', used), 'render-darkroom-2.webp');
assert.equal(outputName('.jpg', 'jpg', used), 'image-darkroom.jpg');
assert.equal(outputName('a:b?.jpg', 'jpg', used), 'a_b_-darkroom.jpg');

const seen = [];
const progress = [];
let active = false;
const callbacks = {
  type: 'image/png',
  read: async file => {
    assert.equal(active, false, 'decode images sequentially');
    if (file.name === 'broken.jpg') throw Error('Unreadable image');
    active = true;
    return { width: file.width, height: file.height, name: file.name };
  },
  render: async source => { seen.push([source.width, source.height]); return source.name; },
  encode: async (pixels, width, height) => {
    active = false;
    return new Blob([JSON.stringify({ pixels, width, height })], { type: 'image/png' });
  },
  onProgress: value => progress.push(value),
};
const files = [
  { name: 'Čačak.jpg', width: 12, height: 48 },
  { name: 'broken.jpg' },
  { name: 'čačak.png', width: 75, height: 20 },
];
const result = await exportImages(files, callbacks);
assert.equal(result.saved, 2);
assert.deepEqual(result.failures, [{ name: 'broken.jpg', message: 'Unreadable image' }]);
assert.deepEqual(seen, [[12, 48], [75, 20]], 'preserve each original resolution');
assert.equal(progress.at(-1).completed, 3);
assert.equal(progress.at(-1).saved, 2);

const individual = await exportImages(files.filter(file => file.name !== 'broken.jpg'), {
  ...callbacks,
  read: async (file, index) => ({ width: index === 0 ? 6 : file.width, height: file.height }),
  render: async (source, file, index) => `${file.name}:${['warm', 'monochrome'][index]}`,
  encode: async (pixels, width, height) => new Blob([JSON.stringify({ pixels, width, height })], { type: 'image/png' }),
});
assert.equal(individual.saved, 2);

const empty = await exportImages([{ name: 'broken.jpg' }], callbacks);
assert.equal(empty.blob, null);
assert.equal(empty.saved, 0);
const wrongFormat = await exportImages([files[0]], { ...callbacks, encode: async () => {
  active = false;
  return new Blob(['fallback'], { type: 'image/jpeg' });
} });
assert.equal(wrongFormat.saved, 0);
assert.match(wrongFormat.failures[0].message, /selected format/);

const controller = new AbortController();
let reads = 0;
await assert.rejects(exportImages(files, { ...callbacks, signal: controller.signal,
  read: async file => { reads += 1; return file; },
  render: async () => { controller.abort(); return new Uint8Array(); },
}), { name: 'AbortError' });
assert.equal(reads, 1, 'cancellation stops before the next file and before encoding');
await assert.rejects(exportImages(files, { ...callbacks, signal: controller.signal }), { name: 'AbortError' });

const tooBig = new ImageZip();
await assert.rejects(tooBig.add('huge.png', { size: 0xffffffff }), /too large/);
tooBig.offset = 0xffffffff - 50;
await assert.rejects(tooBig.add('x', new Blob()), /too large/, 'headers and directory count toward the limit');
const cancelledZip = new ImageZip();
await assert.rejects(cancelledZip.add('x', new Blob(['x']), controller.signal), { name: 'AbortError' });
assert.equal(cancelledZip.parts.length, 0, 'cancellation cannot leave a partial entry');

const folder = await mkdtemp(join(tmpdir(), 'darkroom-batch-test-'));
try {
  await writeFile(join(folder, 'batch.zip'), new Uint8Array(await result.blob.arrayBuffer()));
  await writeFile(join(folder, 'individual.zip'), new Uint8Array(await individual.blob.arrayBuffer()));
  const zip = new ImageZip();
  const payload = new Uint8Array(2 * 1024 * 1024 + 19);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  await zip.add('тест-Č.jpg', new Blob([payload]));
  await zip.add('empty.png', new Blob());
  await writeFile(join(folder, 'large.zip'), new Uint8Array(await zip.finish().arrayBuffer()));
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, ['-X', 'utf8', '-c', `
import json, pathlib, sys, zipfile
folder = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(folder / 'batch.zip') as z:
    assert z.testzip() is None
    assert z.namelist() == ['Čačak-darkroom.png', 'čačak-darkroom-2.png']
    assert json.loads(z.read(z.namelist()[0])) == dict(pixels='Čačak.jpg', width=12, height=48)
    assert json.loads(z.read(z.namelist()[1])) == dict(pixels='čačak.png', width=75, height=20)
    assert all(i.flag_bits & 0x800 for i in z.infolist())
with zipfile.ZipFile(folder / 'large.zip') as z:
    assert z.testzip() is None
    assert z.read('тест-Č.jpg') == bytes(i % 251 for i in range(2 * 1024 * 1024 + 19))
    assert z.read('empty.png') == b''
with zipfile.ZipFile(folder / 'individual.zip') as z:
    assert z.testzip() is None
    first, second = [json.loads(z.read(name)) for name in z.namelist()]
    assert first == dict(pixels='Čačak.jpg:warm', width=6, height=48)
    assert second == dict(pixels='čačak.png:monochrome', width=75, height=20)
`, folder], { stdio: 'pipe' });
} finally {
  // mkdtemp created this exact directory for this test; never traverse a caller-provided path.
  await rm(folder, { recursive: true, force: true });
}
console.log('PASS: batch sequencing, original dimensions, failed files, encoding mismatch, cancellation, safe unique names, ZIP32 limits, Unicode, multichunk CRC and independent ZIP extraction.');
