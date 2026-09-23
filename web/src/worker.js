// The filters run here, off the page's own thread, so the page keeps responding while an image is
// processed. It is a classic worker on purpose: the core arrives through importScripts, which is also how
// a pool of band workers would load it when the work is split across cores.

let wasm = null;
const threads = false;

const ready = (async () => {
  importScripts('darkroom.js?v=%%V%%');
  wasm = await self.createDarkroom({ locateFile: file => `${file}?v=%%V%%` });
})();

ready.then(() => self.postMessage({ hello: true, threads }));

self.onmessage = async event => {
  const { id, buffer, width, height, values, opaque } = event.data;
  await ready;
  const pixels = width * height;
  const image = wasm._malloc(pixels * 4);
  const stack = wasm._malloc(Math.max(4, values.length * 4));
  try {
    if (!image || !stack) throw new Error('This image is too large for the browser to hold.');
    wasm.HEAPU8.set(new Uint8Array(buffer), image);
    if (!opaque) wasm._dk_premultiply(image, pixels);
    wasm.HEAPF32.set(values, stack / 4);
    const count = values.length / 13;
    if (!wasm._dk_apply(image, width, height, width, height, 0, 0, stack, count)) {
      throw new Error('The filters could not run on this image.');
    }
    if (!opaque) wasm._dk_unpremultiply(image, pixels);
    const out = new Uint8ClampedArray(wasm.HEAPU8.subarray(image, image + pixels * 4));
    self.postMessage({ id, ok: true, buffer: out.buffer, width, height }, [out.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  } finally {
    wasm._free(image);
    wasm._free(stack);
  }
};
