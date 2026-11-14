import { MAX_CURVE_POINTS, curveMapping } from './adjustments.js?v=%%V%%';

const tones = ['#d7b584', '#ef9289', '#8acb9a', '#8eb1ed'];
const histograms = new WeakMap();

export function drawHistogram(context, preview, channel, x = 0, y = 0,
  width = context.canvas.width, height = context.canvas.height) {
  if (!preview) return;
  let channels = histograms.get(preview);
  if (!channels) {
    channels = Array.from({ length: 4 }, () => new Uint32Array(256));
    for (let i = 0; i < preview.data.length; i += 4) {
      if (!preview.data[i + 3]) continue;
      for (let c = 0; c < 3; c++) {
        channels[c + 1][preview.data[i + c]]++;
        channels[0][preview.data[i + c]]++;
      }
    }
    histograms.set(preview, channels);
  }
  const bins = channels[channel];
  const populated = bins.slice(1, -1).filter(Boolean).sort();
  const typical = populated[Math.floor((populated.length - 1) * .95)];
  const peak = Math.min(Math.max(...bins), typical ? typical * 4 : Infinity);
  if (!peak) return;
  context.save();
  context.fillStyle = tones[channel];
  context.globalAlpha = .32;
  const bar = width / bins.length;
  bins.forEach((count, i) => {
    const tall = Math.min(1, count / peak) * height;
    context.fillRect(x + i * bar, y + height - tall, bar, tall);
  });
  context.restore();
}

export function curveEditor(box, points, preview, channel, update, commit, { button, row }) {
  const graph = document.createElement('canvas');
  graph.className = 'tone-curve';
  graph.width = graph.height = 512;
  graph.setAttribute('role', 'img');
  graph.setAttribute('aria-label', 'Tone curve');
  const context = graph.getContext('2d');
  const inset = 16, extent = graph.width - 2 * inset;
  const position = value => inset + value / 255 * extent;
  const coordinate = value => Math.round(Math.max(0, Math.min(255, (value - inset) * 255 / extent)));
  let selected = 0, pointer = null, edited = false;
  const choose = document.createElement('select');
  choose.setAttribute('aria-label', 'Curve point');
  const numberInput = label => {
    const input = document.createElement('input');
    input.type = 'number'; input.min = 0; input.max = 255; input.step = 1;
    input.setAttribute('aria-label', label);
    return input;
  };
  const input = numberInput('Curve input'), output = numberInput('Curve output');
  const add = button('Add point', () => {
    let widest = 0;
    for (let i = 1; i < points.length - 1; i++) {
      if (points[i + 1][0] - points[i][0] > points[widest + 1][0] - points[widest][0]) widest = i;
    }
    const x = Math.round((points[widest][0] + points[widest + 1][0]) / 2);
    insert(x, Math.round(curveMapping(points)(x)));
    commit();
  });
  const remove = button('Remove point', () => {
    points.splice(selected, 1);
    selected--;
    update(); commit(); refresh();
    choose.focus();
  });

  function draw() {
    context.clearRect(0, 0, graph.width, graph.height);
    drawHistogram(context, preview, channel, inset, inset, extent, extent);
    context.strokeStyle = '#f5f1ea24'; context.lineWidth = 2;
    context.beginPath();
    for (const level of [0, .25, .5, .75, 1]) {
      const at = inset + extent * level;
      context.moveTo(at, inset); context.lineTo(at, inset + extent);
      context.moveTo(inset, at); context.lineTo(inset + extent, at);
    }
    context.moveTo(position(0), position(255)); context.lineTo(position(255), position(0));
    context.stroke();
    const mapping = curveMapping(points);
    context.strokeStyle = tones[channel]; context.lineWidth = 4;
    context.beginPath();
    context.moveTo(position(0), position(255 - mapping(0)));
    for (let x = 1; x <= 255; x++) context.lineTo(position(x), position(255 - mapping(x)));
    context.stroke();
    points.forEach(([x, y], i) => {
      context.beginPath();
      context.arc(position(x), position(255 - y), 8, 0, 2 * Math.PI);
      context.fillStyle = i === selected ? tones[channel] : '#17171a';
      context.fill(); context.stroke();
    });
  }

  function refresh() {
    const [x, y] = points[selected];
    const endpoint = selected === 0 || selected === points.length - 1;
    choose.replaceChildren(...points.map(([at], i) => new Option(`Point ${i + 1} · ${at}`, i)));
    choose.value = selected;
    input.value = x; output.value = y;
    input.min = endpoint ? x : points[selected - 1][0] + 1;
    input.max = endpoint ? x : points[selected + 1][0] - 1;
    input.disabled = remove.disabled = endpoint;
    add.disabled = points.length >= MAX_CURVE_POINTS;
    draw();
  }

  function move(x, y) {
    const nextX = Math.min(Number(input.max), Math.max(Number(input.min), x));
    const nextY = Math.min(255, Math.max(0, y));
    if (points[selected][0] === nextX && points[selected][1] === nextY) return;
    points[selected] = [nextX, nextY];
    update(); refresh();
    edited = true;
  }

  function insert(x, y) {
    if (points.length >= MAX_CURVE_POINTS || points.some(([at]) => at === x)) return;
    selected = points.findIndex(([at]) => at > x);
    points.splice(selected, 0, [x, y]);
    update(); refresh();
    edited = true;
  }

  const location = event => {
    const rect = graph.getBoundingClientRect();
    return [(event.clientX - rect.left) * graph.width / rect.width, (event.clientY - rect.top) * graph.height / rect.height];
  };
  graph.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer !== null) return;
    const [x, y] = location(event);
    const hit = graph.width / graph.getBoundingClientRect().width * 9;
    const index = points.findIndex(([at, value]) => Math.hypot(x - position(at), y - position(255 - value)) <= hit);
    edited = false;
    if (index >= 0) { selected = index; refresh(); }
    else {
      insert(coordinate(x), 255 - coordinate(y));
      if (!edited) return;
    }
    pointer = event.pointerId;
    graph.setPointerCapture(pointer);
  });
  graph.addEventListener('pointermove', event => {
    if (pointer !== event.pointerId) return;
    const [x, y] = location(event);
    move(coordinate(x), 255 - coordinate(y));
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) graph.addEventListener(type, event => {
    if (pointer !== event.pointerId) return;
    pointer = null;
    if (edited) commit();
  });
  choose.addEventListener('change', () => { selected = Number(choose.value); refresh(); });
  for (const field of [input, output]) field.addEventListener('change', () => {
    edited = false;
    if (Number.isFinite(field.valueAsNumber)) move(Math.round(input.valueAsNumber), Math.round(output.valueAsNumber));
    if (edited) commit();
    else refresh();
  });

  const fields = document.createElement('div'); fields.className = 'curve-fields';
  for (const [name, control] of [['Point', choose], ['Input', input], ['Output', output]]) {
    const label = document.createElement('label'); label.textContent = name; label.append(control); fields.append(label);
  }
  const hint = document.createElement('p'); hint.className = 'control-note';
  hint.textContent = 'Click the graph to add a point. Drag a point or edit its input and output below.';
  box.append(graph, hint, fields);
  row(box, add, remove);
  refresh();
}
