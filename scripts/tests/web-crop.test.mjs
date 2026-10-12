import assert from 'node:assert/strict';
import { pixelCrop, fitAspect, moveCrop, swapCrop, resizeCrop, drawCrop } from '../../web/src/crop.js';

const image = { width: 800, height: 600 };
const box = { x: 200, y: 150, w: 400, h: 300 };
assert.deepEqual(pixelCrop({ x: 799.8, y: 599.9, w: 3, h: 2 }, image), { x: 799, y: 599, w: 1, h: 1 });
assert.deepEqual(fitAspect({ x: 0, y: 0, w: 800, h: 600 }, 1), { x: 100, y: 0, w: 600, h: 600 });
assert.deepEqual(moveCrop(box, -999, 999, image), { x: 0, y: 300, w: 400, h: 300 });
assert.deepEqual(swapCrop(swapCrop(box, image), image), box);
assert.deepEqual(resizeCrop(box, 'se', { x: 700, y: 500 }, image), { x: 200, y: 150, w: 500, h: 350 });
assert.deepEqual(resizeCrop(box, 'nw', { x: 100, y: 50 }, image), { x: 100, y: 50, w: 500, h: 400 });
assert.deepEqual(resizeCrop(box, 'e', { x: 650, y: 300 }, image, 0, true), { x: 150, y: 150, w: 500, h: 300 });
assert.deepEqual(drawCrop({ x: 600, y: 500 }, { x: 200, y: 200 }, image), { x: 200, y: 200, w: 400, h: 300 });
// All handles and modifier combinations must stay inside the image and preserve a locked ratio,
// including pointer movement far outside the picture and across the opposite edge.
for (const handle of ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se']) {
  for (const ratio of [0, 1, 1.5, 2 / 3, 16 / 9]) {
    for (const centered of [false, true]) {
      for (const point of [{ x: -900, y: -700 }, { x: 1600, y: 1200 }, { x: 350, y: 275 }]) {
        const result = resizeCrop(box, handle, point, image, ratio, centered);
        assert.ok(result.w > 0 && result.h > 0, JSON.stringify(result));
        assert.ok(result.x >= -1e-8 && result.y >= -1e-8);
        assert.ok(result.x + result.w <= image.width + 1e-8 && result.y + result.h <= image.height + 1e-8);
        if (ratio) assert.ok(Math.abs(result.w / result.h - ratio) < 1e-8);
      }
    }
  }
}
console.log('PASS: crop pixel bounds, all eight handles, aspect ratios, centred resizing, drawing and panning.');
