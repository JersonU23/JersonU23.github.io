// Vistas de administración: entrenadores, biblioteca, conocimiento, IA y costos, reportes, configuración y auditoría.
import { api, download } from '../api.js';
import { h, mount, toast, toastError, form, modal, table, tabs, kpi, pill, fmtDate, fmtDateTime, fmtUsd, fmtNum, loading, promptDialog } from '../ui.js';
import { L, lab, opts } from '../labels.js';
import { state } from '../app.js';
import { exerciseInfo } from './common.js';
import { createUserDialog } from './staff.js';
import { barChart } from '../charts.js';

const isAdmin = () => state.user.role === 'admin';
const csv = (s) => (s || '').split(/\n|,/).map((x) => x.trim()).filter(Boolean);

// ---------- Entrenadores ----------
export async function coachesView(el) {
  const { users } = await api.get('/users?role=coach&limit=200');
  const toggle = async (u) => {
    try { await api.patch(`/users/${u.id}`, { status: u.status === 'active' ? 'inactive' : 'active' }); coachesView(el); } catch (err) { toastError(err); }
  };
  const reset = async (u) => {
    try {
      const r = await api.post(`/users/${u.id}/reset-password`);
      await modal('Contraseña temporal', h('div', {}, h('p', {}, 'Comparte esta contraseña de forma segura (se muestra una sola vez):'), h('strong', {}, r.temporary_password)), [{ label: 'Listo', class: 'primary', value: true }]);
    } catch (err) { toastError(err); }
  };
  mount(el, h('div', { class: 'row between' }, h('h1', {}, 'Entrenadores'),
    h('button', { class: 'btn primary', onclick: () => createUserDialog('coach', () => coachesView(el)) }, '+ Nuevo entrenador')),
  h('div', { class: 'card' }, table([
    { label: 'Entrenador', render: (u) => h('div', {}, h('strong', {}, u.full_name), h('div', { class: 'small muted' }, u.email)) },
    { label: 'Especialidad', render: (u) => u.specialty || '—' },
    { label: 'Deportistas', num: true, key: 'athletes_assigned' },
    { label: 'Último acceso', render: (u) => fmtDateTime(u.last_login_at) },
    { label: 'Estado', render: (u) => pill(u.status === 'active' ? 'Activo' : 'Inactivo', u.status === 'active' ? 'good' : 'bad') },
    { label: '', render: (u) => h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => toggle(u) }, u.status === 'active' ? 'Desactivar' : 'Activar'),
      h('button', { class: 'btn small', onclick: () => reset(u) }, 'Restablecer clave')) },
  ], users, { empty: 'Aún no hay entrenadores' })));
}

// ---------- Biblioteca de ejercicios ----------
export async function exercisesView(el) {
  const filters = { status: isAdmin() ? 'all' : 'active', search: '' };
  const listBox = h('div', { class: 'grid cols-2' });
  const load = async () => {
    const qs = new URLSearchParams({ limit: '200', status: filters.status, ...(filters.search ? { search: filters.search } : {}) });
    const { exercises } = await api.get(`/exercises?${qs}`);
    mount(listBox, exercises.length ? exercises.map((ex) => h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h3', {}, ex.name), h('div', { class: 'row' }, pill(lab(L.exLevel, ex.level)),
        ex.status !== 'active' ? pill(lab(L.exStatus, ex.status), ex.status === 'proposed' ? 'warn' : 'bad') : null)),
      h('div', { class: 'small muted' }, `${ex.primary_muscles.join(', ')} · ${ex.equipment.join(', ') || 'sin equipo'}${ex.movement_type ? ` · ${ex.movement_type}` : ''}`),
      exerciseInfo(ex),
      isAdmin() ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => exerciseDialog(ex, load) }, 'Editar'),
        ex.status !== 'active' ? h('button', { class: 'btn small primary', onclick: () => setStatus(ex, 'active') }, ex.status === 'proposed' ? 'Validar e incorporar' : 'Activar')
          : h('button', { class: 'btn small', onclick: () => setStatus(ex, 'inactive') }, 'Desactivar')) : null))
      : h('div', { class: 'card empty' }, 'No hay ejercicios con este filtro.'));
  };
  const setStatus = async (ex, status) => { try { await api.patch(`/exercises/${ex.id}`, { status }); load(); } catch (err) { toastError(err); } };
  const search = h('input', { type: 'search', placeholder: 'Buscar ejercicio' });
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(() => { filters.search = search.value; load(); }, 250); };
  const statusSel = isAdmin() ? h('select', { onchange: (e) => { filters.status = e.target.value; load(); } },
    [['all', 'Todos'], ['active', 'Activos'], ['proposed', 'Propuestos por IA'], ['inactive', 'Inactivos']].map(([v, l]) => h('option', { value: v }, l))) : null;
  mount(el, h('div', { class: 'row between' }, h('h1', {}, 'Biblioteca de ejercicios'),
    isAdmin() ? h('button', { class: 'btn primary', onclick: () => exerciseDialog(null, load) }, '+ Nuevo ejercicio') : null),
  h('div', { class: 'row' }, search, statusSel), listBox);
  await load();
}

async function exerciseDialog(ex, onSaved) {
  const v = ex || {};
  const f = form([
    { name: 'name', label: 'Nombre', full: true },
    { name: 'primary_muscles', label: 'Músculos principales (separados por coma)' }, { name: 'secondary_muscles', label: 'Músculos secundarios' },
    { name: 'equipment', label: 'Equipamiento (coma)' }, { name: 'movement_type', label: 'Tipo de movimiento' },
    { name: 'level', label: 'Nivel', type: 'select', options: opts(L.exLevel) },
    { name: 'media_type', label: 'Tipo de medio', type: 'select', options: [['image', 'Imagen'], ['video', 'Video']] },
    { name: 'media_url', label: 'URL de imagen o video (https://)', full: true },
    { name: 'execution', label: 'Técnica de ejecución', type: 'textarea', full: true },
    { name: 'breathing', label: 'Respiración', type: 'textarea', full: true },
    { name: 'common_errors', label: 'Errores frecuentes (uno por línea)', type: 'textarea', full: true },
    { name: 'variations', label: 'Variaciones (uno por línea)', type: 'textarea', full: true },
    { name: 'alternatives', label: 'Alternativas (uno por línea)', type: 'textarea', full: true },
    { name: 'contraindications', label: 'Contraindicaciones (uno por línea)', type: 'textarea', full: true },
  ], { ...v, primary_muscles: v.primary_muscles?.join(', '), secondary_muscles: v.secondary_muscles?.join(', '), equipment: v.equipment?.join(', '),
    common_errors: v.common_errors?.join('\n'), variations: v.variations?.join('\n'), alternatives: v.alternatives?.join('\n'), contraindications: v.contraindications?.join('\n') });
  await modal(ex ? 'Editar ejercicio' : 'Nuevo ejercicio', f.el, [
    { label: 'Cancelar', value: null },
    { label: 'Guardar', class: 'primary', onClick: async () => {
      const x = f.values();
      const body = { ...x, primary_muscles: csv(x.primary_muscles), secondary_muscles: csv(x.secondary_muscles), equipment: csv(x.equipment),
        common_errors: csv(x.common_errors), variations: csv(x.variations), alternatives: csv(x.alternatives), contraindications: csv(x.contraindications) };
      try { ex ? await api.patch(`/exercises/${ex.id}`, body) : await api.post('/exercises', body); toast('Ejercicio guardado'); onSaved(); return true; } catch (err) { toastError(err); return false; }
    } }]);
}

// ---------- Centro de conocimiento ----------
export async function knowledgeView(el) {
  const filters = { kind: '', status: '', q: '' };
  const listBox = h('div');
  const load = async () => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries({ ...filters, limit: '200' }).filter(([, v]) => v)));
    const { entries } = await api.get(`/knowledge?${qs}`);
    mount(listBox, table([
      { label: 'Registro', render: (e) => h('div', {}, h('strong', {}, e.title), h('div', { class: 'small muted' }, e.summary.slice(0, 140))) },
      { label: 'Tipo', render: (e) => pill(e.kind === 'scientific' ? 'Científico' : 'Empírico', e.kind === 'scientific' ? 'info' : 'warn') },
      { label: 'Nivel', render: (e) => (e.kind === 'scientific' ? lab(L.evidence, e.evidence_level) : lab(L.classification, e.classification)) },
      { label: 'Tema', render: (e) => lab(L.topic, e.topic) },
      { label: 'Estado', render: (e) => pill(lab(L.validation, e.validation_status), e.validation_status === 'validated' ? 'good' : e.validation_status === 'rejected' ? 'bad' : 'warn') },
      { label: 'Versión', num: true, render: (e) => `v${e.version}` }, { label: 'Usado por IA', num: true, key: 'times_cited' },
    ], entries, { onRow: (e) => entryDialog(e.id, load), empty: 'Sin registros' }));
  };
  const sel = (key, options) => h('select', { onchange: (e) => { filters[key] = e.target.value; load(); } }, options.map(([v, l]) => h('option', { value: v }, l)));
  const search = h('input', { type: 'search', placeholder: 'Buscar' });
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(() => { filters.q = search.value; load(); }, 300); };
  mount(el, h('div', { class: 'row between' }, h('h1', {}, 'Centro de conocimiento'),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => newEntryDialog('empirical', load) }, '+ Experiencia práctica'),
      h('button', { class: 'btn primary', onclick: () => newEntryDialog('scientific', load) }, '+ Evidencia científica'))),
  h('p', { class: 'muted' }, 'Solo los registros validados por el administrador alimentan a la IA. Cada edición crea una nueva versión y queda trazado qué propuestas usaron cada registro.'),
  h('div', { class: 'row' }, search, sel('kind', [['', 'Todos los tipos'], ['scientific', 'Científico'], ['empirical', 'Empírico']]),
    sel('status', [['', 'Todos los estados'], ['pending', 'Pendientes'], ['validated', 'Validados'], ['rejected', 'Rechazados']])),
  h('div', { class: 'card' }, listBox));
  await load();
}

function entryFields(kind) {
  const common = [
    { name: 'title', label: 'Título', full: true }, { name: 'topic', label: 'Tema', type: 'select', options: opts(L.topic) },
    { name: 'tags', label: 'Etiquetas (coma)' }, { name: 'summary', label: 'Resumen (lo que leerá la IA)', type: 'textarea', full: true },
    { name: 'body', label: 'Contenido ampliado', type: 'textarea', full: true }];
  return kind === 'scientific' ? [...common,
    { name: 'source', label: 'Fuente (revista, libro, institución)' }, { name: 'authors', label: 'Autores' },
    { name: 'published_on', label: 'Fecha de publicación', type: 'date' }, { name: 'evidence_level', label: 'Nivel de evidencia', type: 'select', options: opts(L.evidence) },
    { name: 'reference_list', label: 'Referencias verificables (DOI, PubMed o cita completa; una por línea)', type: 'textarea', full: true }]
    : [...common, { name: 'specialty', label: 'Tu especialidad' }, { name: 'classification', label: 'Clasificación', type: 'select', options: opts(L.classification) },
      { name: 'objective', label: 'Objetivo', type: 'textarea', full: true }, { name: 'context', label: 'Contexto (población, duración, condiciones)', type: 'textarea', full: true },
      { name: 'applicable_profile', label: 'Perfil al que aplica', type: 'textarea', full: true }, { name: 'results', label: 'Resultados observados', type: 'textarea', full: true },
      { name: 'limitations', label: 'Limitaciones', type: 'textarea', full: true }];
}
const entryBody = (kind, x) => ({ ...x, kind, tags: csv(x.tags), ...(kind === 'scientific' ? { reference_list: (x.reference_list || '').split('\n').map((s) => s.trim()).filter(Boolean) } : {}) });

async function newEntryDialog(kind, onSaved) {
  const f = form(entryFields(kind));
  await modal(kind === 'scientific' ? 'Nueva evidencia científica' : 'Nueva experiencia práctica', h('div', { class: 'stack' },
    kind === 'scientific' ? h('div', { class: 'alert small' }, 'Registra solo publicaciones reales y verificables. No se aceptan referencias sin fuente.') : null, f.el), [
    { label: 'Cancelar', value: null },
    { label: 'Guardar', class: 'primary', onClick: async () => {
      try { await api.post('/knowledge', entryBody(kind, f.values())); toast('Registro creado (pendiente de validación)'); onSaved(); return true; } catch (err) { toastError(err); return false; }
    } }]);
}

async function entryDialog(id, onSaved) {
  const { entry: e, versions, citations } = await api.get(`/knowledge/${id}`);
  const f = form(entryFields(e.kind), { ...e, tags: e.tags.join(', '), reference_list: e.reference_list.join('\n') });
  const canEdit = isAdmin() || e.created_by === state.user.id;
  const actions = [{ label: 'Cerrar', value: null }];
  if (canEdit) actions.push({ label: 'Guardar nueva versión', onClick: async () => {
    try { await api.patch(`/knowledge/${id}`, entryBody(e.kind, f.values())); toast('Nueva versión guardada'); onSaved(); return true; } catch (err) { toastError(err); return false; }
  } });
  if (isAdmin()) {
    actions.push({ label: 'Rechazar', class: 'danger', onClick: async () => { await api.post(`/knowledge/${id}/validate`, { status: 'rejected' }); onSaved(); } });
    actions.push({ label: 'Validar', class: 'primary', onClick: async () => { await api.post(`/knowledge/${id}/validate`, { status: 'validated' }); toast('Validado: ya alimenta a la IA'); onSaved(); } });
  }
  await modal(e.title, h('div', { class: 'stack' },
    h('div', { class: 'row' }, pill(lab(L.validation, e.validation_status)), pill(`v${e.version}`), h('span', { class: 'small muted' }, `Autor: ${e.author_name || '—'}`)),
    f.el,
    h('h3', {}, 'Versiones'), h('ul', { class: 'clean small' }, versions.map((v) => h('li', {}, `v${v.version} · ${fmtDateTime(v.created_at)} · ${v.changed_by || '—'}`))),
    h('h3', {}, 'Uso por la IA'), citations.length ? h('ul', { class: 'clean small' }, citations.map((c) => h('li', {}, `${lab(L.operation, c.operation)} · ${fmtDate(c.created_at)} · v${c.entry_version}: ${c.usage_note || ''}`)))
      : h('p', { class: 'small muted' }, 'Aún no fue citado.')), actions);
}

// ---------- IA y costos ----------
export async function aiView(el) {
  const u = await api.get('/ai/usage');
  const pct = u.budget_usd ? u.month.cost / u.budget_usd : 0;
  const panel = h('div');
  const sections = [['Consumo', () => usagePanel(panel, u)], ['Historial de solicitudes', () => requestsPanel(panel)], ['Asistente administrativo', () => assistantPanel(panel)]];
  mount(el, h('h1', {}, 'IA y costos'),
    !u.provider_configured ? h('div', { class: 'alert high' }, 'IA no configurada: falta ANTHROPIC_API_KEY en el servidor. Las funciones de IA no están disponibles.') : null,
    h('div', { class: 'grid kpis' },
      kpi('Costo del mes', fmtUsd(u.month.cost, 4), `${Math.round(pct * 100)}% de ${fmtUsd(u.budget_usd)}`),
      kpi('Costo por deportista activo', fmtUsd(u.cost_per_active_athlete, 4), `${u.active_athletes} activos`),
      kpi('Solicitudes correctas', u.month.succeeded, `${u.month.reused} reutilizadas sin costo`),
      kpi('Fallidas / bloqueadas', `${u.month.failed} / ${u.month.blocked}`),
      kpi('Tokens entrada / salida', `${fmtNum(u.month.input_tokens)} / ${fmtNum(u.month.output_tokens)}`, `${fmtNum(u.month.cache_read_tokens)} leídos de caché`),
      kpi('Modelo', u.model)),
    pct >= u.alert_threshold ? h('div', { class: `alert ${pct >= 1 ? 'high' : ''}` }, pct >= 1 ? 'Presupuesto agotado: las nuevas solicitudes se bloquean.' : 'Se superó el umbral de alerta del presupuesto.') : null,
    tabs(sections.map((s) => s[0]), (i) => sections[i][1]()), panel);
}

function usagePanel(panel, u) {
  mount(panel, h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h2', {}, 'Por operación (mes actual)'), table([
      { label: 'Operación', render: (r) => lab(L.operation, r.operation) }, { label: 'Solicitudes', num: true, key: 'calls' },
      { label: 'Costo total', num: true, render: (r) => fmtUsd(r.cost, 4) }, { label: 'Costo medio', num: true, render: (r) => fmtUsd(r.avg_cost, 4) },
      { label: 'Tokens medios (in/out)', num: true, render: (r) => `${fmtNum(r.avg_input)} / ${fmtNum(r.avg_output)}` }], u.by_operation, { empty: 'Sin consumo este mes' })),
    barChart('Costo mensual de IA (USD)', u.history.map((m) => ({ x: `${m.month}-01`, y: Math.round(m.cost * 100) / 100 })), { unit: 'USD' }),
    h('div', { class: 'card' }, h('h2', {}, 'Deportistas con mayor consumo (mes)'), table([
      { label: 'Deportista', key: 'full_name' }, { label: 'Solicitudes', num: true, key: 'calls' }, { label: 'Costo', num: true, render: (r) => fmtUsd(r.cost, 4) }], u.top_athletes)),
    h('div', { class: 'card small muted' }, 'Referencia de diseño para 300 deportistas: hasta 300 generaciones iniciales en la incorporación, hasta 600 ajustes al mes y cero llamadas de IA en el seguimiento diario. Los costos mostrados son los medidos en cada solicitud (tokens × precio vigente guardado).')));
}

async function requestsPanel(panel) {
  mount(panel, loading());
  const { requests } = await api.get('/ai/requests?limit=100');
  mount(panel, h('div', { class: 'card' }, table([
    { label: 'Fecha', render: (r) => fmtDateTime(r.created_at) }, { label: 'Operación', render: (r) => lab(L.operation, r.operation) },
    { label: 'Deportista', render: (r) => r.athlete_name || '—' },
    { label: 'Estado', render: (r) => pill(lab(L.aiStatus, r.status), r.status === 'succeeded' ? 'good' : r.status === 'reused' ? 'info' : ['failed', 'refused', 'blocked'].includes(r.status) ? 'bad' : '') },
    { label: 'Modelo', render: (r) => r.served_model || r.model }, { label: 'Tokens in/out', num: true, render: (r) => `${fmtNum(r.input_tokens)} / ${fmtNum(r.output_tokens)}` },
    { label: 'Costo', num: true, render: (r) => fmtUsd(r.cost_usd, 4) }, { label: 'Latencia', num: true, render: (r) => (r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)} s` : '—') },
    { label: 'Error', render: (r) => r.error || '' }], requests, { empty: 'Sin solicitudes' })));
}

function assistantPanel(panel) {
  const q = h('textarea', { placeholder: 'Ej.: ¿Qué problemas operativos ves este mes? ¿Cómo va el consumo de IA frente al presupuesto?' });
  const out = h('div', { class: 'stack' });
  const btn = h('button', { class: 'btn primary' }, 'Consultar');
  btn.onclick = async () => {
    btn.disabled = true; mount(out, loading());
    try {
      const r = await api.post('/ai/assistant', { question: q.value });
      mount(out, h('div', { class: 'card stack' }, r.reused ? pill('Respuesta reutilizada (sin costo)', 'info') : null, h('p', { class: 'pre' }, r.answer),
        r.findings.length ? [h('h3', {}, 'Hallazgos'), h('ul', { class: 'clean' }, r.findings.map((f) => h('li', {}, f)))] : null,
        r.suggested_actions.length ? [h('h3', {}, 'Acciones sugeridas'), h('ul', { class: 'clean' }, r.suggested_actions.map((a) => h('li', {}, a.action, a.requires_authorization ? pill('Requiere autorización', 'warn') : null, h('div', { class: 'small muted' }, a.reason))))] : null,
        r.data_limitations.length ? h('div', { class: 'alert small' }, 'Limitaciones de datos: ', r.data_limitations.join(' · ')) : null));
    } catch (err) { mount(out); toastError(err); } finally { btn.disabled = false; }
  };
  mount(panel, h('div', { class: 'card stack' }, h('p', { class: 'small muted' }, 'El asistente consulta solo estadísticas agregadas (sin datos personales) y no ejecuta cambios: propone acciones que requieren tu autorización.'), q, btn), out);
}

// ---------- Reportes ----------
export async function reportsView(el) {
  const e = await api.get('/reports/economics');
  mount(el, h('h1', {}, 'Reportes'),
    h('div', { class: 'card stack' }, h('h2', {}, 'Economía del servicio (mes actual)'),
      e.note ? h('div', { class: 'alert' }, e.note) : null,
      h('div', { class: 'grid kpis' },
        kpi('Costo de IA medido', fmtUsd(e.month_ai_cost_usd, 2)), kpi('Costos operativos + IA', fmtUsd(e.total_cost_usd)),
        kpi('Tarifa mensual', fmtUsd(e.monthly_fee_usd)), kpi('Margen operativo', e.margin === null ? '—' : `${Math.round(e.margin * 100)}%`, `objetivo ${Math.round(e.target_margin * 100)}%`),
        kpi('Tarifa mínima para el objetivo', fmtUsd(e.min_fee_for_target_usd))),
      h('p', { class: 'small muted' }, 'Los costos operativos (infraestructura, base de datos, almacenamiento, notificaciones, pasarela de pago, mantenimiento) se registran en Configuración → Avanzado con los valores reales facturados.')),
    h('div', { class: 'card row between' }, h('div', {}, h('h3', {}, 'Exportaciones'), h('p', { class: 'small muted' }, 'Archivos CSV compatibles con hojas de cálculo.')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => download('/reports/athletes.csv', 'deportistas.csv').catch(toastError) }, 'Deportistas (CSV)'),
        h('button', { class: 'btn', onclick: () => download('/reports/ai-usage.csv', 'consumo-ia.csv').catch(toastError) }, 'Consumo de IA (CSV)'))));
}

// ---------- Configuración (3 niveles) ----------
export async function settingsView(el) {
  const { settings: s, gym, defaults } = await api.get('/settings');
  const panel = h('div');
  const save = async (level, values, automatic) => {
    try { await api.patch('/settings', { level, values, automatic }); toast('Configuración guardada y registrada en auditoría'); settingsView(el); } catch (err) { toastError(err); }
  };
  const basic = () => {
    const f = form([
      { name: 'ai_enabled', label: 'IA habilitada', type: 'checkbox', full: true },
      { name: 'ai_monthly_budget_usd', label: 'Presupuesto mensual de IA (USD)', type: 'number', step: 1 },
      { name: 'ai_alert_threshold', label: 'Umbral de alerta (0.1–1)', type: 'number', step: 0.05 },
      { name: 'monthly_fee_usd', label: 'Tarifa mensual cobrada al gimnasio (USD)', type: 'number', step: 1 }], s);
    mount(panel, h('div', { class: 'card stack' }, h('p', { class: 'muted small' }, 'Lo esencial para operar.'), f.el,
      h('button', { class: 'btn primary', onclick: () => save('basic', f.values()) }, 'Guardar')));
  };
  const advanced = () => {
    const oc = s.operating_costs || {};
    const f = form([
      { name: 'capacity', label: 'Capacidad contratada (deportistas)', type: 'number' },
      { name: 'ai_model', label: 'Modelo de IA', type: 'select', options: defaults.models.map((m) => [m, m]) },
      { name: 'ai_effort', label: 'Esfuerzo de razonamiento', type: 'select', options: [['low', 'Bajo'], ['medium', 'Medio'], ['high', 'Alto'], ['xhigh', 'Muy alto'], ['max', 'Máximo']] },
      { name: 'max_adjustments_per_month', label: 'Ajustes de IA por deportista al mes (máx. 4)', type: 'number' },
      { name: 'min_days_between_adjustments', label: 'Días mínimos entre ajustes', type: 'number' },
      { name: 'assistant_daily_limit', label: 'Consultas diarias del asistente', type: 'number' },
      { name: 'nutrition_weight_change_pct', label: 'Cambio de peso que justifica actualizar nutrición (%)', type: 'number', step: 0.5 },
      { name: 'target_margin', label: 'Margen operativo objetivo (0–0.95)', type: 'number', step: 0.05 }], { ...s, capacity: gym.capacity });
    const costs = form(['infrastructure', 'database', 'storage', 'notifications', 'payment_gateway', 'maintenance', 'other'].map((k) => ({
      name: k, label: { infrastructure: 'Servidor / hosting', database: 'Base de datos', storage: 'Almacenamiento', notifications: 'Notificaciones', payment_gateway: 'Pasarela de pago', maintenance: 'Mantenimiento', other: 'Otros' }[k] + ' (USD/mes)', type: 'number', step: 0.01 })), oc);
    const pricing = { ...defaults.pricing, ...(s.ai_pricing || {}) };
    const priceInputs = {};
    const priceTable = h('table', {}, h('thead', {}, h('tr', {}, ['Modelo', 'Entrada', 'Salida', 'Escritura caché', 'Lectura caché'].map((t) => h('th', {}, t)))),
      h('tbody', {}, Object.entries(pricing).map(([m, p]) => h('tr', {}, h('td', {}, m), ['input', 'output', 'cache_write', 'cache_read'].map((k) => {
        const inp = h('input', { type: 'number', step: 0.01, value: p[k] });
        (priceInputs[m] ||= {})[k] = inp;
        return h('td', {}, inp);
      })))));
    mount(panel, h('div', { class: 'stack' }, h('div', { class: 'card stack' }, h('h3', {}, 'Parámetros'), f.el),
      h('div', { class: 'card stack' }, h('h3', {}, 'Costos operativos reales'), costs.el),
      h('div', { class: 'card stack' }, h('h3', {}, 'Precios de IA (USD por millón de tokens)'), h('p', { class: 'small muted' }, 'Actualízalos si cambian las tarifas del proveedor. Cada solicitud guarda el precio con el que se calculó.'), h('div', { class: 'table-wrap' }, priceTable)),
      h('button', { class: 'btn primary', onclick: () => {
        const ai_pricing = Object.fromEntries(Object.entries(priceInputs).map(([m, ks]) => [m, Object.fromEntries(Object.entries(ks).map(([k, i]) => [k, Number(i.value)]))]));
        save('advanced', { ...f.values(), operating_costs: costs.values(), ai_pricing });
      } }, 'Guardar configuración avanzada')));
  };
  const automatic = () => {
    const a = s.advanced || {};
    const f = form([
      { name: 'auto_initial_generation', label: 'Generar la propuesta inicial automáticamente cuando el deportista envía su evaluación', type: 'checkbox', full: true },
      { name: 'auto_max_cost_per_request_usd', label: 'Costo máximo autorizado por solicitud automática (USD)', type: 'number', step: 0.01 }], a);
    mount(panel, h('div', { class: 'card stack' },
      h('p', { class: 'muted small' }, 'En modo automático la IA actúa sin solicitud manual dentro de los límites autorizados. Las propuestas siguen requiriendo la aprobación del entrenador y respetan el presupuesto mensual y las reglas de seguridad.'),
      f.el, h('button', { class: 'btn primary', onclick: () => save('automatic', {}, f.values()) }, 'Activar modo automático')));
  };
  const levels = ['basic', 'advanced', 'automatic'];
  mount(el, h('h1', {}, 'Configuración'), h('p', { class: 'muted' }, `Nivel actual: ${{ basic: 'Básico', advanced: 'Avanzado', automatic: 'Automático' }[s.config_level]}. Todos los cambios quedan registrados en la auditoría.`),
    tabs(['Básico', 'Avanzado', 'Automático'], (i) => [basic, advanced, automatic][i](), Math.max(0, levels.indexOf(s.config_level))), panel);
}

// ---------- Auditoría ----------
export async function auditView(el) {
  const filter = h('input', { type: 'search', placeholder: 'Filtrar por acción (ej.: plan, ai., settings)' });
  const box = h('div');
  const load = async () => {
    const { entries } = await api.get(`/audit?limit=200${filter.value ? `&action=${encodeURIComponent(filter.value)}` : ''}`);
    mount(box, table([
      { label: 'Fecha', render: (a) => fmtDateTime(a.created_at) }, { label: 'Usuario', render: (a) => a.actor_name || 'Sistema' },
      { label: 'Acción', key: 'action' }, { label: 'Entidad', render: (a) => `${a.entity || ''} ${a.entity_id ? a.entity_id.slice(0, 8) : ''}` },
      { label: 'Detalle', render: (a) => (a.details ? h('code', { class: 'small' }, JSON.stringify(a.details).slice(0, 160)) : '') }, { label: 'IP', key: 'ip' }], entries));
  };
  let t;
  filter.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  mount(el, h('h1', {}, 'Auditoría'), h('div', { class: 'card stack' }, filter, box));
  await load();
}
