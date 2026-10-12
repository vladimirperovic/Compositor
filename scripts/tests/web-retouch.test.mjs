// Real editor under the deployed CSP, synthetic images only, external requests blocked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('../../build/web/', import.meta.url));
const csp = (await readFile(resolve(root, '.htaccess'), 'utf8')).match(/Header set Content-Security-Policy "([^"]+)"/)[1];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://darkroom.test') return route.abort();
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[\w.-]+$/.test(name)) return route.abort();
    try {
      await route.fulfill({ headers: { 'Content-Security-Policy': csp }, body: await readFile(resolve(root, name)), contentType:
        name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.jpg') ? 'image/jpeg' : 'text/html' });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://darkroom.test/');
  await page.waitForFunction(() => document.body.classList.contains('has-image'));
  await page.locator('#reset').click();
  await page.evaluate(async () => {
    const transfer = new DataTransfer();
    for (let n = 0; n < 3; n++) {
      const c = new OffscreenCanvas(800, 600), ctx = c.getContext('2d');
      ctx.fillStyle = n === 2 ? 'rgb(160,120,80)' : 'rgb(128,128,128)'; ctx.fillRect(0, 0, 800, 600);
      if (n === 2) { ctx.fillStyle = 'rgb(200,120,40)'; ctx.fillRect(0, 0, 400, 300); ctx.fillStyle = 'rgb(40,200,40)'; ctx.fillRect(400, 0, 400, 300); }
      transfer.items.add(new File([await c.convertToBlob()], `retouch-${n}.png`, { type: 'image/png' }));
    }
    document.getElementById('panel').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('.batch-thumb.selected')?.textContent === 'retouch-0.png');
  const range = async (label, value) => {
    await page.getByRole('slider', { name: label, exact: true }).evaluate((input, value) => {
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
  };
  const pixel = async (x, y) => page.locator('#canvas').evaluate((c, [x, y]) => [...c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data], [x, y]);
  const waitPixel = async (x, y, test) => {
    for (let i = 0; i < 100; i++) { const p = await pixel(x, y); if (test(p)) return p; await new Promise(r => setTimeout(r, 50)); }
    assert.fail(`Pixel ${x},${y}: ${await pixel(x, y)}`);
  };
  const drag = async (x, y, dx, dy) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up(); };
  await page.locator('#localLight').click();
  await page.locator('#addOval').click();
  assert.equal(await page.getByLabel('Blend mode').inputValue(), 'soft-light');
  await waitPixel(.5, .5, p => p[0] > 140);
  assert.deepEqual(await pixel(.02, .02), [128, 128, 128, 255]);
  const soft = await pixel(.5, .5);
  await page.getByLabel('Blend mode').selectOption('overlay');
  await waitPixel(.5, .5, p => p[0] > soft[0]);
  await range('Layer opacity', 0); await waitPixel(.5, .5, p => p[0] === 128);
  await range('Layer opacity', 100); await waitPixel(.5, .5, p => p[0] > 160);
  let frame = await page.locator('#retouchOverlay').boundingBox();
  const originalEllipse = await page.locator('#localEllipse').boundingBox();
  await drag(frame.x + frame.width * .5, frame.y + frame.height * .5, frame.width * .18, 0);
  const movedEllipse = await page.locator('#localEllipse').boundingBox();
  assert.ok(movedEllipse.x > originalEllipse.x + frame.width * .17, 'oval follows pointer');
  await waitPixel(.68, .5, p => p[0] > 160);
  const handle = await page.locator('#localEllipse [data-handle="se"]').boundingBox();
  await drag(handle.x + handle.width / 2, handle.y + handle.height / 2, -frame.width * .1, -frame.height * .08);
  const resized = await page.locator('#localEllipse').boundingBox();
  assert.ok(resized.width < movedEllipse.width, `resize oval with corner: ${JSON.stringify({ frame, handle, movedEllipse, resized })}`);
  await page.getByLabel('Show Oval 1', { exact: true }).uncheck();
  await waitPixel(.68, .5, p => p[0] === 128);
  await page.getByLabel('Show Oval 1', { exact: true }).check();
  await waitPixel(.68, .5, p => p[0] > 160);
  await page.locator('#addBrush').click();
  await page.getByLabel('Brush action').selectOption('burn');
  await range('Brush strength', 100); await range('Brush size', 12);
  frame = await page.locator('#retouchOverlay').boundingBox();
  await drag(frame.x + frame.width * .15, frame.y + frame.height * .5, frame.width * .18, 0);
  await waitPixel(.24, .5, p => p[0] < 90);
  await page.locator('#retouchUndo').click(); await waitPixel(.24, .5, p => p[0] === 128);
  await page.locator('#retouchRedo').click(); await waitPixel(.24, .5, p => p[0] < 90);
  await page.getByLabel('Brush action').selectOption('erase'); await range('Brush softness', 0);
  await drag(frame.x + frame.width * .15, frame.y + frame.height * .5, frame.width * .18, 0);
  await waitPixel(.24, .5, p => p[0] === 128);
  await page.locator('#retouchUndo').click(); await waitPixel(.24, .5, p => p[0] < 90);
  // A cancelled pointer operation must not leave a hidden stroke in the export.
  await page.getByLabel('Brush action').selectOption('dodge');
  await page.mouse.move(frame.x + frame.width * .4, frame.y + frame.height * .75); await page.mouse.down();
  await page.locator('#retouchOverlay').dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
  await waitPixel(.4, .75, p => p[0] === 128);
  await page.screenshot({ path: join(tmpdir(), 'darkroom-retouch-desktop.png') });
  // Wheel and Space-pan remain available while painting is selected.
  const widthBefore = frame.width;
  await page.mouse.move(frame.x + frame.width * .5, frame.y + frame.height * .5); await page.mouse.wheel(0, -650);
  await page.waitForFunction(w => document.getElementById('retouchOverlay').getBoundingClientRect().width > w * 1.5, widthBefore);
  const scroll = await page.locator('#stage').evaluate(e => e.scrollLeft);
  await page.keyboard.down('Space'); await drag(720, 410, -50, 0); await page.keyboard.up('Space');
  assert.ok(await page.locator('#stage').evaluate(e => e.scrollLeft) > scroll + 40);
  await page.locator('#zoom').click();
  // Crop uses original geometry, and reopening it does not bake or move painted light.
  await page.locator('#cropMode').click();
  assert.equal(await page.locator('#retouchOverlay').isVisible(), false);
  await page.getByLabel('Crop aspect ratio').selectOption('1'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('600 × 600'));
  await waitPixel((.68 * 800 - 100) / 600, .5, p => p[0] > 160);
  await waitPixel((.24 * 800 - 100) / 600, .5, p => p[0] < 90);
  await page.locator('.batch-thumb').nth(1).click();
  await page.waitForFunction(() => document.querySelector('.batch-thumb.selected')?.textContent === 'retouch-1.png');
  await page.locator('#localLight').click(); assert.equal(await page.locator('.local-layer').count(), 0);
  await waitPixel(.5, .5, p => p[0] === 128);
  await page.locator('.batch-thumb').nth(0).click();
  await page.waitForFunction(() => document.querySelector('.batch-thumb.selected')?.textContent === 'retouch-0.png');
  assert.equal(await page.locator('.local-layer').count(), 2);
  await waitPixel((.68 * 800 - 100) / 600, .5, p => p[0] > 160);
  await page.locator('.batch-thumb').nth(2).click();
  await page.waitForFunction(() => document.querySelector('.batch-thumb.selected')?.textContent === 'retouch-2.png');
  await page.locator('#whiteBalance').click(); await page.locator('#pickWhite').click();
  frame = await page.locator('#retouchOverlay').boundingBox();
  await page.mouse.click(frame.x + frame.width * .3, frame.y + frame.height * .75);
  assert.equal(await page.getByLabel('Enable white balance', { exact: true }).isChecked(), true);
  // Compare may have been restored; turn it off to inspect the full output.
  if (await page.locator('#compare').evaluate(e => e.classList.contains('active'))) await page.locator('#compare').click();
  await waitPixel(.3, .75, p => Math.max(...p.slice(0, 3)) - Math.min(...p.slice(0, 3)) <= 1);
  await page.getByRole('button', { name: 'Reset white balance', exact: true }).click();
  await waitPixel(.3, .75, p => p[0] > p[2] + 50);
  await range('Temperature', 20);
  assert.equal(await page.getByLabel('Enable white balance', { exact: true }).isChecked(), true, 'automatic activation is reflected by checkbox');
  await page.getByRole('button', { name: 'Reset white balance', exact: true }).click();
  await page.locator('#selectiveColor').click(); await page.getByLabel('Color range').selectOption('1');
  await range('Saturation', -100);
  assert.equal(await page.getByLabel('Enable individual colors', { exact: true }).isChecked(), true);
  await waitPixel(.25, .25, p => Math.max(...p.slice(0, 3)) - Math.min(...p.slice(0, 3)) <= 2);
  assert.deepEqual(await pixel(.75, .25), [40, 200, 40, 255], 'other color ranges unaffected');
  // Decode actual PNG and per-image ZIP, with full resolution and all local/colour edits.
  await page.locator('#format').selectOption('image/png');
  const decode = async (bytes, points) => page.evaluate(async ({ bytes, points }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return { width: c.width, height: c.height, pixels: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) };
  }, { bytes: [...bytes], points });
  const download = page.waitForEvent('download'); await page.locator('#save').click();
  const png = await decode(await readFile(await (await download).path()), [[200, 150], [600, 150]]);
  assert.ok(Math.abs(png.pixels[0][0] - png.pixels[0][1]) < 2);
  assert.deepEqual(png.pixels[1], [40, 200, 40, 255]);
  const zipped = page.waitForEvent('download'); await page.locator('#saveAll').click();
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const images = JSON.parse(execFileSync(python, ['-c', 'import base64,json,zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps([base64.b64encode(z.read(n)).decode() for n in z.namelist()]))', await (await zipped).path()], { encoding: 'utf8' }));
  const first = await decode(Buffer.from(images[0], 'base64'), [[444, 300], [92, 300]]);
  assert.equal(first.width, 600); assert.equal(first.height, 600);
  assert.ok(first.pixels[0][0] > 160 && first.pixels[1][0] < 90, 'ZIP uses original-space oval and brush after crop');
  assert.deepEqual((await decode(Buffer.from(images[1], 'base64'), [[400, 300]])).pixels[0], [128, 128, 128, 255]);
  assert.deepEqual((await decode(Buffer.from(images[2], 'base64'), [[200, 150], [600, 150]])).pixels, png.pixels);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#localLight').click(); await page.locator('#addOval').click();
  assert.equal(await page.getByLabel('Blend mode').isVisible(), true);
  await page.screenshot({ path: join(tmpdir(), 'darkroom-retouch-mobile.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: actual local layers, blend/opacity, move/resize, brush/erase/undo/cancel, wheel/pan, crop, per-image state, WB, HSL, PNG/ZIP pixels, mobile UI and CSP.');
} finally { await browser.close(); }
