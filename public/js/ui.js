// Utilidades de interfaz. Todo el contenido dinámico se inserta como texto (sin innerHTML) para evitar XSS.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...children) => { clear(el); append(el, children); return el; };

export function toast(message, type = 'info') {
  const t = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500);
}

export function errorText(err) {
  if (!err) return 'Error';
  let msg = err.message || String(err);
  if (Array.isArray(err.details) && err.details.length) {
    msg += ': ' + err.details.map((d) => d.label || (d.path ? `${d.path} ${d.message}` : d.message) || d.type).filter(Boolean).join('; ');
  }
  return msg;
}
export const toastError = (err) => toast(errorText(err), 'error');

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    const close = (v) => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'row between' }, h('h2', {}, title), h('button', { class: 'btn ghost small', onclick: () => close(null), 'aria-label': 'Cerrar' }, '✕')),
        body,
        actions.length ? h('div', { class: 'row' }, actions.map((a) => h('button', {
          class: `btn ${a.class || ''}`, onclick: async (e) => {
            if (!a.onClick) return close(a.value);
            e.target.disabled = true;
            try { const v = await a.onClick(); if (v !== false) close(v ?? a.value); } finally { e.target.disabled = false; }
          },
        }, a.label))) : null));
    document.body.append(bg);
    bg.querySelector('input,select,textarea,button.primary')?.focus();
  });
}

export async function confirmDialog(title, text, okLabel = 'Confirmar', danger = false) {
  return (await modal(title, h('p', {}, text), [
    { label: 'Cancelar', value: false }, { label: okLabel, value: true, class: danger ? 'danger' : 'primary' }])) === true;
}

export async function promptDialog(title, label, { required = true, multiline = true, placeholder = '' } = {}) {
  const input = multiline ? h('textarea', { placeholder }) : h('input', { placeholder });
  const r = await modal(title, h('label', { class: 'field' }, h('span', {}, label), input), [
    { label: 'Cancelar', value: null },
    { label: 'Aceptar', class: 'primary', onClick: () => {
      if (required && !input.value.trim()) { toast('Este campo es obligatorio', 'error'); return false; }
      return input.value.trim();
    } }]);
  return r;
}

// ----- Formularios declarativos -----
// field: { name, label, type: text|number|email|date|select|textarea|checkbox|multi|yesno, options:[[value,label]], step, min, max, full, placeholder }
export function form(fields, initial = {}) {
  const getters = {};
  const el = h('div', { class: 'form-grid' }, fields.map((f) => {
    const v = initial[f.name];
    let input;
    if (f.type === 'select') {
      input = h('select', { name: f.name }, h('option', { value: '' }, '— Selecciona —'),
        f.options.map(([val, lab]) => h('option', { value: val, selected: String(v) === String(val) }, lab)));
      getters[f.name] = () => input.value || undefined;
    } else if (f.type === 'textarea') {
      input = h('textarea', { name: f.name, placeholder: f.placeholder || '', value: v ?? '' });
      getters[f.name] = () => input.value.trim() || undefined;
    } else if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', name: f.name, checked: Boolean(v) });
      getters[f.name] = () => input.checked;
      return h('label', { class: `field row ${f.full ? 'full' : ''}` }, input, h('span', {}, f.label));
    } else if (f.type === 'multi') {
      const sel = new Set(v || []);
      input = h('div', { class: 'checks' }, f.options.map(([val, lab]) => {
        const lb = h('label', { class: sel.has(val) ? 'on' : '' });
        const cb = h('input', { type: 'checkbox', checked: sel.has(val), onchange: () => { cb.checked ? sel.add(val) : sel.delete(val); lb.classList.toggle('on', cb.checked); } });
        lb.append(cb, lab);
        return lb;
      }));
      getters[f.name] = () => [...sel];
    } else if (f.type === 'yesno') {
      let state = typeof v === 'boolean' ? v : undefined;
      const yes = h('button', { type: 'button', class: state === true ? 'on' : '' }, 'Sí');
      const no = h('button', { type: 'button', class: state === false ? 'on' : '' }, 'No');
      const set = (s) => { state = s; yes.classList.toggle('on', s === true); no.classList.toggle('on', s === false); };
      yes.onclick = () => set(true); no.onclick = () => set(false);
      getters[f.name] = () => state;
      return h('div', { class: 'q-row full' }, h('span', {}, f.label), h('div', { class: 'yesno' }, yes, no));
    } else {
      input = h('input', { name: f.name, type: f.type || 'text', value: v ?? '', step: f.step, min: f.min, max: f.max, placeholder: f.placeholder || '', autocomplete: f.autocomplete });
      getters[f.name] = () => {
        if (input.value === '') return undefined;
        return f.type === 'number' ? Number(input.value) : input.value.trim();
      };
    }
    return h('label', { class: `field ${f.full ? 'full' : ''}` }, h('span', {}, f.label), input);
  }));
  const values = () => Object.fromEntries(Object.entries(getters).map(([k, g]) => [k, g()]).filter(([, v]) => v !== undefined));
  return { el, values };
}

export const fmtDate = (d) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtUsd = (n, d = 2) => (n === null || n === undefined ? '—' : `USD ${Number(n).toFixed(d)}`);
export const fmtPct = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);
export const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-EC'));

export function table(columns, rows, { onRow, empty = 'Sin registros' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? () => onRow(r) : null },
      columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : (r[c.key] ?? '—'))))))));
}

export function tabs(items, onSelect, initial = 0) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const buttons = items.map((it, i) => h('button', { role: 'tab', class: i === initial ? 'on' : '', onclick: () => select(i) }, it));
  bar.append(...buttons);
  function select(i) { buttons.forEach((b, j) => b.classList.toggle('on', i === j)); onSelect(i); }
  setTimeout(() => onSelect(initial));
  return bar;
}

export const kpi = (label, value, sub) => h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: String(value).length > 9 ? 'value sm' : 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
export const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
export const loading = () => h('div', { class: 'empty' }, 'Cargando…');
