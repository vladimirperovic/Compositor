// Real editor, synthetic images, no external requests. Run after scripts/build-web.py.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
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
        name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' :
        name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.jpg') ? 'image/jpeg' : 'text/html' });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://darkroom.test/');
  await page.waitForFunction(() => document.body.classList.contains('has-image') && !document.getElementById('cropMode').disabled);
  await page.locator('#reset').click();
  // Drop on a control panel, not just on the central canvas.
  await page.evaluate(async () => {
    const transfer = new DataTransfer();
    for (const [name, color] of [['first.png', '#dd3322'], ['second.png', '#2266dd']]) {
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 600;
      const context = canvas.getContext('2d');
      context.fillStyle = color; context.fillRect(0, 0, 800, 600);
      context.fillStyle = '#33cc55'; context.fillRect(400, 0, 400, 600);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      transfer.items.add(new File([blob], name, { type: 'image/png' }));
    }
    document.getElementById('panel').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.batch-thumb').length === 2, null, { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector('.batch-thumb.selected')?.textContent === 'first.png');
  await page.locator('#cropMode').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cropOverlay').isVisible(), false, 'Escape cancels the crop');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('editing')), true, 'Escape keeps the editor open');
  const drag = async (x, y, dx, dy) => {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
  };
  await page.keyboard.press('c');
  await page.waitForFunction(() => document.getElementById('cropSize').textContent === '800 × 600 px');
  let frame = await page.locator('#cropOverlay').boundingBox();
  const corner = await page.locator('.crop-handle.se').boundingBox();
  await page.keyboard.down('Shift');
  await drag(corner.x + corner.width / 2, corner.y + corner.height / 2, -frame.width / 5, -frame.height / 10);
  await page.keyboard.up('Shift');
  const locked = (await page.locator('#cropSize').textContent()).match(/(\d+) × (\d+)/).slice(1).map(Number);
  assert.ok(Math.abs(locked[0] / locked[1] - 4 / 3) < .005, 'Shift keeps the ratio through the real handle');
  await page.locator('#cropReset').click();
  frame = await page.locator('#cropOverlay').boundingBox();
  await drag(frame.x + frame.width / 4, frame.y + frame.height / 6, frame.width / 2, frame.height / 2);
  assert.equal(await page.locator('#cropSize').textContent(), '400 × 300 px', 'draw a crop in original pixels');
  let before = await page.locator('#cropRect').boundingBox();
  await drag(before.x + before.width / 2, before.y + before.height / 2, frame.width / 8, 0);
  let after = await page.locator('#cropRect').boundingBox();
  const followsPointer = Math.abs(after.x - before.x - frame.width / 8) < 2;
  const cropDimensions = await page.locator('#cropSize').textContent();
  const canvasBeforeZoom = await page.locator('#canvas').boundingBox();
  await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2);
  await page.mouse.wheel(0, -240);
  const wheelZooms = await page.waitForFunction(width => document.getElementById('canvas').getBoundingClientRect().width > width * 1.1,
    canvasBeforeZoom.width, { timeout: 2000 }).then(() => true, () => false);
  assert.deepEqual({ followsPointer, wheelZooms }, { followsPointer: true, wheelZooms: true }, 'crop frame follows the pointer and wheel zoom works during crop');
  assert.equal(await page.locator('#cropSize').textContent(), cropDimensions, 'zoom preserves original crop dimensions');
  assert.equal(await page.locator('#zoom').isEnabled(), true, 'Fit/100% works during crop');
  await page.mouse.wheel(0, -650);
  await page.waitForFunction(width => document.getElementById('canvas').getBoundingClientRect().width > width * 2,
    canvasBeforeZoom.width);
  const scrollBefore = await page.locator('#stage').evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
  await page.keyboard.down('Space');
  await drag(720, 420, -60, -35);
  await page.keyboard.up('Space');
  const scrollAfter = await page.locator('#stage').evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
  assert.ok(scrollAfter.x > scrollBefore.x + 50 && scrollAfter.y > scrollBefore.y + 25, 'Space-drag pans the zoomed image');
  assert.equal(await page.locator('#cropSize').textContent(), cropDimensions, 'panning does not change crop dimensions');
  assert.equal(await page.locator('#cropOverlay').isVisible(), true, 'releasing Space does not toggle the focused Crop button');
  await page.locator('#zoom').click();
  await page.waitForFunction(width => Math.abs(document.getElementById('canvas').getBoundingClientRect().width - width) < 2, canvasBeforeZoom.width);
  // Move left as well, ending at original x=100 for the exported-pixel assertions below.
  frame = await page.locator('#cropOverlay').boundingBox();
  before = await page.locator('#cropRect').boundingBox();
  await drag(before.x + before.width / 2, before.y + before.height / 2, -frame.width / 4, 0);
  after = await page.locator('#cropRect').boundingBox();
  assert.ok(Math.abs(after.x - before.x + frame.width / 4) < 2, 'crop frame moves left');
  before = after;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  after = await page.locator('#cropRect').boundingBox();
  assert.ok(after.x > before.x && after.y > before.y, 'arrow keys move the selection in their labelled direction');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('cropOverlay').hidden);
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('400 × 300'));
  // Decode the actual download: the crop starts at original x=100 and crosses the green half at x=300.
  await page.locator('#format').selectOption('image/png');
  const downloaded = page.waitForEvent('download');
  await page.locator('#save').click();
  const file = await downloaded;
  const encoded = await readFile(await file.path());
  const saved = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height,
      left: [...context.getImageData(20, 20, 1, 1).data], right: [...context.getImageData(380, 20, 1, 1).data] };
  }, [...encoded]);
  assert.deepEqual(saved, { width: 400, height: 300, left: [221, 51, 34, 255], right: [51, 204, 85, 255] });
  // Switching between images retains each crop, and reopening restores the original outside it.
  await page.locator('.batch-thumb').nth(1).click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('800 × 600'));
  await page.locator('.batch-thumb').first().click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('400 × 300'));
  const zipDownload = page.waitForEvent('download');
  await page.locator('#saveAll').click();
  const archive = await zipDownload;
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const dimensions = JSON.parse(execFileSync(python, ['-X', 'utf8', '-c',
    'import json,struct,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps([struct.unpack(">II",z.read(n)[16:24]) for n in z.namelist()]))',
    await archive.path()], { encoding: 'utf8' }));
  assert.deepEqual(dimensions, [[400, 300], [800, 600]], 'real ZIP uses the individual crops');
  await page.locator('#cropMode').click();
  assert.equal(await page.locator('#saveAll').isDisabled(), true, 'cannot export an unconfirmed crop');
  assert.equal(await page.locator('#cropSize').textContent(), '400 × 300 px');
  await page.locator('#cropReset').click();
  assert.equal(await page.locator('#cropSize').textContent(), '800 × 600 px');
  await page.locator('#cropRatio').selectOption('1.5');
  assert.equal(await page.locator('#cropSize').textContent(), '800 × 533 px');
  await page.locator('#cropSwap').click();
  assert.equal(await page.locator('#cropSize').textContent(), '400 × 600 px');
  await page.locator('#cropSwap').click();
  assert.equal(await page.locator('#cropSize').textContent(), '800 × 533 px', 'two swaps restore the frame');
  await page.locator('#cropSwap').click();
  const portrait = await page.locator('#cropSize').textContent();
  await page.setViewportSize({ width: 1100, height: 800 });
  assert.equal(await page.locator('#cropSize').textContent(), portrait, 'resizing window retains exact pixel selection');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('400 × 300'));
  await page.locator('#cropMode').click();
  await page.locator('#cropReset').click();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('800 × 600'));
  // The ordinary picker accepts several images too, and unsupported drops cannot erase the session.
  const imageBytes = await readFile(resolve(root, 'sample.jpg'));
  await page.locator('#file').setInputFiles([
    { name: 'third.jpg', mimeType: 'image/jpeg', buffer: imageBytes },
    { name: 'fourth.jpg', mimeType: 'image/jpeg', buffer: imageBytes },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.batch-thumb').length === 4);
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('.batch-thumb').count(), 4);
  assert.match(await page.locator('#importNotice').textContent(), /1 non-image file/);
  // A delayed file decode must not replace a newer thumbnail selection.
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    window.releaseTestDecode = release;
    window.createImageBitmap = async (...args) => {
      if (args[0]?.name === 'slow.jpg') await paused;
      return decode(...args);
    };
  });
  await page.locator('#file').setInputFiles({ name: 'slow.jpg', mimeType: 'image/jpeg', buffer: imageBytes });
  await page.waitForFunction(() => document.querySelector('.batch-thumb.loading')?.textContent === 'slow.jpg');
  await page.locator('.batch-thumb').first().click();
  await page.waitForFunction(() => document.querySelector('.batch-thumb.selected')?.textContent === 'first.png');
  await page.evaluate(() => window.releaseTestDecode());
  await page.waitForFunction(() => !document.querySelector('.batch-thumb.loading'));
  assert.equal(await page.locator('.batch-thumb.selected').textContent(), 'first.png');
  await page.locator('#file').setInputFiles([
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a png') },
    { name: 'readable.jpg', mimeType: 'image/jpeg', buffer: imageBytes },
  ]);
  await page.waitForFunction(() => document.querySelector('.batch-thumb.selected')?.textContent === 'readable.jpg');
  assert.match(await page.locator('.batch-thumb.failed').first().textContent(), /broken.png/);
  // Touch-sized viewport and controls remain reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#cropMode').click();
  const actions = await page.locator('#cropActions').boundingBox();
  assert.ok(actions.x >= 0 && actions.x + actions.width <= 390);
  const mobileFrame = await page.locator('#cropRect').boundingBox();
  assert.ok(mobileFrame.y + mobileFrame.height < actions.y, 'crop handles stay above the mobile actions');
  await page.locator('#cropCancel').click();
  if (process.env.DARKROOM_SCREENSHOT) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#cropMode').click();
    await page.locator('#cropRatio').selectOption('1.5');
    await page.screenshot({ path: process.env.DARKROOM_SCREENSHOT });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: multi-file import, per-image crops, original recovery, ratios, crop movement, wheel zoom, Space-drag pan, keyboard, actual PNG/ZIP output and mobile controls.');
} finally {
  await browser.close();
}
