// Gráficos SVG livianos (una serie por gráfico → sin leyenda; el título nombra la serie).
// Incluyen tooltip con cruz al pasar el puntero/tocar y una vista de tabla accesible.
import { h, fmtDate } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const W = 640, H = 220, M = { t: 14, r: 16, b: 28, l: 44 };

function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= step0);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function frame(title, svg, rows, unit) {
  const tableView = h('div', { class: 'table-wrap hidden' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Fecha'), h('th', { class: 'num' }, `Valor${unit ? ` (${unit})` : ''}`))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.x)), h('td', { class: 'num' }, r.y))))));
  const chartBox = h('div', { class: 'chart' }, svg);
  const toggle = h('button', { class: 'btn ghost small', onclick: () => {
    const showTable = tableView.classList.contains('hidden');
    tableView.classList.toggle('hidden', !showTable);
    chartBox.classList.toggle('hidden', showTable);
    toggle.textContent = showTable ? 'Ver gráfico' : 'Ver tabla';
  } }, 'Ver tabla');
  return { el: h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, title), toggle), chartBox, tableView), chartBox };
}

function axes(svg, ticks, y, xLabels) {
  const g = s('g', { class: 'axis' });
  for (const t of ticks) {
    g.append(s('line', { class: 'gridline', x1: M.l, x2: W - M.r, y1: y(t), y2: y(t) }));
    const tx = s('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end' });
    tx.textContent = t;
    g.append(tx);
  }
  for (const { x, label, anchor } of xLabels) {
    const tx = s('text', { x, y: H - 8, 'text-anchor': anchor || 'middle' });
    tx.textContent = label;
    g.append(tx);
  }
  svg.append(g);
}

function attachTooltip(box, svg, pts, unit) {
  const tip = h('div', { class: 'tooltip hidden' });
  box.append(tip);
  const cross = s('line', { class: 'cross hidden', y1: M.t, y2: H - M.b });
  const hl = s('circle', { class: 'dot', r: 5, visibility: 'hidden' });
  svg.append(cross, hl);
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.cx - px) < Math.abs(best.cx - px)) best = p;
    cross.setAttribute('x1', best.cx); cross.setAttribute('x2', best.cx); cross.classList.remove('hidden');
    hl.setAttribute('cx', best.cx); hl.setAttribute('cy', best.cy); hl.setAttribute('visibility', 'visible');
    tip.textContent = `${fmtDate(best.x)} · ${best.y}${unit ? ` ${unit}` : ''}`;
    tip.style.left = `${(best.cx / W) * 100}%`;
    tip.style.top = `${(best.cy / H) * rect.height}px`;
    tip.classList.remove('hidden');
  };
  const leave = () => { tip.classList.add('hidden'); cross.classList.add('hidden'); hl.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}

/** Línea temporal. data: [{ x: 'YYYY-MM-DD', y: number }] */
export function lineChart(title, data, { unit = '' } = {}) {
  const rows = data.filter((d) => d.y !== null && d.y !== undefined).sort((a, b) => (a.x < b.x ? -1 : 1));
  if (rows.length < 2) return h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'empty' }, rows.length ? 'Se necesita al menos otro registro para ver la tendencia.' : 'Aún no hay datos.'));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title}: ${rows.length} registros` });
  const t0 = new Date(rows[0].x).getTime(), t1 = new Date(rows.at(-1).x).getTime();
  const ys = rows.map((r) => r.y);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const x = (d) => M.l + ((new Date(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - (v - ticks[0]) / (ticks.at(-1) - ticks[0])) * (H - M.t - M.b);
  axes(svg, ticks, y, [{ x: M.l, label: fmtDate(rows[0].x), anchor: 'start' }, { x: W - M.r, label: fmtDate(rows.at(-1).x), anchor: 'end' }]);
  const pts = rows.map((r) => ({ ...r, cx: x(r.x), cy: y(r.y) }));
  svg.append(s('path', { class: 'series', d: pts.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join('') }));
  if (pts.length <= 40) for (const p of pts) svg.append(s('circle', { class: 'dot', cx: p.cx, cy: p.cy, r: 4 }));
  // Etiqueta directa solo del último valor
  const last = pts.at(-1);
  const lab = s('text', { x: last.cx - 6, y: last.cy - 10, 'text-anchor': 'end', class: 'axis' });
  lab.textContent = `${last.y}${unit ? ` ${unit}` : ''}`;
  svg.append(lab);
  const { el, chartBox } = frame(title, svg, rows, unit);
  attachTooltip(chartBox, svg, pts, unit);
  return el;
}

/** Barras por periodo. data: [{ x: 'YYYY-MM-DD', y: number }] */
export function barChart(title, data, { unit = '' } = {}) {
  if (!data.length) return h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'empty' }, 'Aún no hay datos.'));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
  const ticks = niceTicks(0, Math.max(...data.map((d) => d.y)));
  const y = (v) => M.t + (1 - v / ticks.at(-1)) * (H - M.t - M.b);
  const band = (W - M.l - M.r) / data.length;
  const bw = Math.max(4, Math.min(28, band - 2)); // 2px de separación mínima entre barras
  axes(svg, ticks, y, [{ x: M.l + band / 2, label: fmtDate(data[0].x) }, { x: M.l + band * (data.length - 0.5), label: fmtDate(data.at(-1).x) }]);
  const pts = data.map((d, i) => ({ ...d, cx: M.l + band * (i + 0.5), cy: y(d.y) }));
  for (const p of pts) {
    const top = p.cy, base = H - M.b, r = Math.min(4, bw / 2, base - top);
    // Barra con extremo de datos redondeado (4px) anclada a la línea base
    const x0 = p.cx - bw / 2, x1 = p.cx + bw / 2;
    svg.append(s('path', { class: 'bar', d: base - top < 1 ? '' : `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z` }));
  }
  const { el, chartBox } = frame(title, svg, data, unit);
  attachTooltip(chartBox, svg, pts, unit);
  return el;
}
