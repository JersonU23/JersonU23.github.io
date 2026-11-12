// Componentes y vistas compartidas entre roles.
import { api } from '../api.js';
import { h, mount, toastError, fmtDate, fmtDateTime, fmtPct, pill, loading, kpi } from '../ui.js';
import { L, lab } from '../labels.js';
import { lineChart, barChart } from '../charts.js';
import { state } from '../app.js';

const list = (items) => (items?.length ? h('ul', { class: 'clean' }, items.map((i) => h('li', {}, i))) : h('span', { class: 'muted' }, '—'));

// ---------- Ejercicio: ficha técnica ----------
export function exerciseInfo(ex) {
  if (!ex) return h('span', { class: 'muted' }, 'Ejercicio no disponible');
  const safeUrl = ex.media_url && (/^https:\/\//.test(ex.media_url) || ex.media_url.startsWith('/')) ? ex.media_url : null;
  const media = safeUrl ? (ex.media_type === 'video'
    ? h('video', { class: 'media', src: safeUrl, controls: true, preload: 'none', playsinline: true })
    : h('img', { class: 'media', src: safeUrl, alt: ex.name, loading: 'lazy' })) : null;
  return h('details', {}, h('summary', {}, 'Técnica y detalles'),
    media,
    h('div', { class: 'small stack' },
      h('div', {}, h('strong', {}, 'Músculos: '), [...ex.primary_muscles, ...ex.secondary_muscles.map((m) => `${m} (secundario)`)].join(', ') || '—'),
      h('div', {}, h('strong', {}, 'Equipamiento: '), ex.equipment.join(', ') || 'Sin equipo'),
      ex.execution ? h('div', {}, h('strong', {}, 'Ejecución: '), h('span', { class: 'pre' }, ex.execution)) : null,
      ex.breathing ? h('div', {}, h('strong', {}, 'Respiración: '), ex.breathing) : null,
      h('div', {}, h('strong', {}, 'Errores frecuentes: '), list(ex.common_errors)),
      h('div', {}, h('strong', {}, 'Variaciones: '), list(ex.variations)),
      h('div', {}, h('strong', {}, 'Alternativas: '), list(ex.alternatives)),
      ex.contraindications.length ? h('div', { class: 'alert' }, h('strong', {}, 'Contraindicaciones: '), list(ex.contraindications)) : null));
}

// ---------- Plan de entrenamiento (lectura o edición de series/reps/descanso) ----------
export function trainingPlanView(plan, { editable = false } = {}) {
  const c = structuredClone(plan.content);
  const exMap = plan.exercises || {};
  const el = h('div', { class: 'stack' },
    c.summary ? h('p', {}, c.summary) : null,
    h('div', { class: 'grid cols-2' },
      section('Distribución semanal', c.weekly_structure), section('Progresión', c.progression),
      section('Calentamiento', c.warmup_protocol), section('Movilidad', c.mobility), section('Recuperación', c.recovery)),
    c.safety_notes?.length ? h('div', { class: 'alert high' }, h('strong', {}, 'Notas de seguridad'), list(c.safety_notes)) : null,
    c.coach_attention?.length ? h('div', { class: 'alert' }, h('strong', {}, 'Para atención del entrenador'), list(c.coach_attention)) : null,
    c.days.map((d) => h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', {}, `${d.key} · ${d.name}`), pill(lab(L.weekday, d.suggested_weekday))),
      d.focus ? h('p', { class: 'muted small' }, d.focus) : null,
      d.warmup ? h('p', { class: 'small' }, h('strong', {}, 'Calentamiento: '), d.warmup) : null,
      h('div', { class: 'stack' }, d.exercises.map((e) => {
        const ex = exMap[e.exercise_id];
        const fields = editable ? h('div', { class: 'form-grid' },
          numIn('Series', e.sets, (v) => { e.sets = v; }), txtIn('Repeticiones', e.reps, (v) => { e.reps = v; }),
          txtIn('RIR / RPE', e.rir_or_rpe, (v) => { e.rir_or_rpe = v; }), numIn('Descanso (s)', e.rest_seconds, (v) => { e.rest_seconds = v; }))
          : h('div', { class: 'row small' }, pill(`${e.sets} × ${e.reps}`, 'info'), e.rir_or_rpe ? pill(e.rir_or_rpe) : null,
            e.intensity ? pill(e.intensity) : null, e.rest_seconds ? pill(`Descanso ${e.rest_seconds}s`) : null);
        return h('div', { class: 'exercise' }, h('strong', {}, ex?.name || 'Ejercicio'), fields,
          e.notes ? h('div', { class: 'small muted' }, e.notes) : null, exerciseInfo(ex));
      })),
      d.cooldown ? h('p', { class: 'small' }, h('strong', {}, 'Vuelta a la calma: '), d.cooldown) : null)));
  return { el, getContent: () => c };
}
const section = (title, text) => (text ? h('div', { class: 'card tight' }, h('h3', {}, title), h('p', { class: 'small pre' }, text)) : null);
const numIn = (label, v, set) => h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', value: v, min: 0, oninput: (e) => set(Number(e.target.value)) }));
const txtIn = (label, v, set) => h('label', { class: 'field' }, h('span', {}, label), h('input', { value: v || '', oninput: (e) => set(e.target.value) }));

// ---------- Plan nutricional ----------
export function nutritionPlanView(content) {
  const m = content.macros || {};
  return h('div', { class: 'stack' },
    h('div', { class: 'grid kpis' }, kpi('Energía', `${content.energy_kcal} kcal`), kpi('Proteína', `${m.protein_g} g`),
      kpi('Carbohidratos', `${m.carbs_g} g`), kpi('Grasas', `${m.fat_g} g`), kpi('Hidratación', `${content.hydration_liters} L`)),
    content.energy_rationale ? section('Cómo se calculó', content.energy_rationale) : null,
    content.energy_estimate ? h('p', { class: 'small muted' }, `Referencia del sistema: ${content.energy_estimate.method} → TMB ${content.energy_estimate.bmr_kcal} kcal, gasto estimado ${content.energy_estimate.tdee_kcal} kcal.`) : null,
    (content.meals || []).map((meal) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, meal.name), meal.timing ? pill(meal.timing) : null),
      h('ul', { class: 'clean' }, meal.options.map((o) => h('li', {}, o.description, o.portion_guide ? h('span', { class: 'muted' }, ` — ${o.portion_guide}`) : null))))),
    content.food_alternatives?.length ? section('Alternativas', content.food_alternatives.join('\n')) : null,
    content.tracking_guidance ? section('Seguimiento', content.tracking_guidance) : null,
    content.referral_recommended ? h('div', { class: 'alert high' }, h('strong', {}, 'Se recomienda consultar a un profesional sanitario: '), content.referral_reason) : null,
    h('div', { class: 'alert info small' }, (content.disclaimers?.length ? content.disclaimers : ['Plan orientativo. No sustituye la valoración de un nutricionista o médico.']).join(' ')));
}

// ---------- Fundamentos: evidencia, experiencia, inferencias, contradicciones ----------
export function rationaleView(plan, citations = []) {
  const c = plan.content;
  const cited = new Map(citations.map((x) => [x.entry_id, x]));
  const ev = c.evidence_used || [];
  return h('div', { class: 'stack' },
    plan.rationale ? h('div', { class: 'card' }, h('h3', {}, 'Justificación'), h('p', { class: 'pre' }, plan.rationale)) : null,
    h('div', { class: 'card' }, h('h3', {}, 'Conocimiento utilizado'),
      ev.length ? h('ul', { class: 'clean' }, ev.map((e) => {
        const k = cited.get(e.knowledge_id);
        return h('li', {}, pill(e.source_type === 'scientific' ? 'Evidencia científica' : 'Experiencia práctica', e.source_type === 'scientific' ? 'info' : 'warn'), ' ',
          h('strong', {}, k?.title || e.knowledge_id), k ? ` (v${k.entry_version}${k.evidence_level ? ` · ${lab(L.evidence, k.evidence_level)}` : ''}${k.classification ? ` · ${lab(L.classification, k.classification)}` : ''})` : '',
          ': ', e.how_applied);
      })) : h('p', { class: 'muted' }, 'No se citaron registros del centro de conocimiento.')),
    c.inferences?.length ? h('div', { class: 'card' }, h('h3', {}, 'Inferencias de la IA (no respaldadas por un registro citado)'), list(c.inferences)) : null,
    c.contradictions?.length ? h('div', { class: 'alert' }, h('strong', {}, 'Contradicciones detectadas'), list(c.contradictions)) : null,
    c.warnings?.length ? h('div', { class: 'alert' }, h('strong', {}, 'Advertencias de validación del sistema'), list(c.warnings)) : null);
}

// ---------- Progreso (sin IA) ----------
export async function progressBlock(el, athleteId) {
  mount(el, loading());
  const p = await api.get(`/tracking/athlete/${athleteId}/progress?days=30`);
  const s = p.summary;
  const exSelect = h('select', {}, p.series.exercises.map((e) => h('option', { value: e.exercise_id }, e.name)));
  const exChart = h('div');
  const drawEx = () => {
    const ex = p.series.exercises.find((e) => e.exercise_id === exSelect.value);
    mount(exChart, ex ? lineChart(`1RM estimado · ${ex.name}`, ex.points.map((pt) => ({ x: pt.date, y: pt.e1rm })), { unit: 'kg' }) : h('div', { class: 'empty' }, 'Registra cargas para ver su evolución.'));
  };
  exSelect.onchange = drawEx;
  const goals = p.goals;
  mount(el, h('div', { class: 'stack' },
    goals ? h('div', { class: 'row' }, h('strong', {}, 'Objetivo: '), pill(lab(L.goal, goals.primary_goal), 'info'), goals.target_weight_kg ? pill(`Peso objetivo ${goals.target_weight_kg} kg`) : null) : null,
    h('div', { class: 'grid kpis' },
      kpi('Sesiones (30 días)', `${s.sessions.done}${s.sessions.planned ? ` / ${s.sessions.planned}` : ''}`, 'realizadas / planificadas'),
      kpi('Cumplimiento', fmtPct(s.sessions.adherence)),
      kpi('Cambio de peso', s.body.weight_change_kg === null ? '—' : `${s.body.weight_change_kg > 0 ? '+' : ''}${s.body.weight_change_kg} kg`),
      kpi('Fatiga media', s.wellness.avg_fatigue ?? '—', 'escala 1–10'),
      kpi('Molestias', s.wellness.pain_reports, 'reportes en el periodo')),
    h('div', { class: 'grid cols-2' },
      lineChart('Peso corporal', p.series.body.map((b) => ({ x: b.measured_on, y: b.weight_kg })), { unit: 'kg' }),
      barChart('Sesiones por semana', p.series.weekly_sessions.map((w) => ({ x: w.week, y: w.sessions })))),
    p.series.exercises.length ? h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', {}, 'Evolución de cargas por ejercicio'), exSelect), exChart) : null,
    lineChart('Cintura', p.series.body.map((b) => ({ x: b.measured_on, y: b.waist_cm })), { unit: 'cm' }),
    Object.keys(s.sets_per_muscle_week).length ? h('div', { class: 'card' }, h('h3', {}, 'Series semanales por grupo muscular (últimos 30 días)'),
      h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, Object.entries(s.sets_per_muscle_week).sort((a, b) => b[1] - a[1])
        .map(([m, n]) => h('tr', {}, h('td', {}, m), h('td', { class: 'num' }, n))))))) : null,
    s.exercises.length ? h('div', { class: 'card' }, h('h3', {}, 'Rendimiento por ejercicio (30 días)'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Ejercicio', 'Series', 'Carga máx.', 'Cambio 1RM est.', 'RIR medio'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, s.exercises.map((e) => h('tr', {}, h('td', {}, e.name), h('td', { class: 'num' }, e.sets), h('td', { class: 'num' }, `${e.top_load_kg} kg`),
        h('td', { class: 'num' }, e.e1rm_change_pct === null ? '—' : `${e.e1rm_change_pct > 0 ? '+' : ''}${e.e1rm_change_pct}%`), h('td', { class: 'num' }, e.avg_rir ?? '—'))))))) : null,
    h('div', { class: 'card' }, h('h3', {}, 'Historial de rutinas'), p.series.plan_history.length ? h('ul', { class: 'clean' }, p.series.plan_history.map((x) =>
      h('li', {}, `v${x.version} · ${lab(L.planSource, x.source)} · `, pill(lab(L.planStatus, x.status), x.status === 'active' ? 'good' : ''), ` · ${fmtDate(x.activated_at || x.created_at)}`))) : h('p', { class: 'muted' }, 'Sin rutinas aún.'))));
  drawEx();
}

// ---------- Mensajes ----------
export async function messagesView(el, withId) {
  const { contacts } = await api.get('/messages/contacts');
  const conv = h('div', { class: 'card stack' });
  const side = h('div', { class: 'card contacts' }, h('h3', {}, 'Conversaciones'),
    contacts.length ? contacts.map((c) => h('a', { href: `#/messages/${c.id}`, class: c.id === withId ? 'on' : '' },
      h('span', {}, c.full_name, h('span', { class: 'small muted' }, ` · ${L.role[c.role]}`)), c.unread ? pill(String(c.unread), 'bad') : null))
      : h('p', { class: 'muted' }, state.user.role === 'athlete' ? 'Aún no tienes entrenador asignado.' : 'Sin contactos.'));
  mount(el, h('h1', {}, 'Mensajes'), h('div', { class: 'chat' }, side, conv));
  if (!withId) { mount(conv, h('div', { class: 'empty' }, 'Selecciona una conversación')); return; }
  const other = contacts.find((c) => c.id === withId);
  const box = h('div', { class: 'msgs' });
  const input = h('textarea', { placeholder: 'Escribe un mensaje…', maxlength: 4000 });
  const load = async () => {
    const { messages } = await api.get(`/messages/with/${withId}`);
    mount(box, messages.length ? messages.map((m) => h('div', { class: `msg ${m.sender_id === state.user.id ? 'me' : ''}` }, m.body,
      h('div', { class: 'small muted' }, fmtDateTime(m.created_at)))) : h('div', { class: 'empty' }, 'Sin mensajes todavía'));
    box.scrollTop = box.scrollHeight;
  };
  const send = async () => {
    if (!input.value.trim()) return;
    try { await api.post('/messages', { to: withId, body: input.value.trim() }); input.value = ''; await load(); } catch (err) { toastError(err); }
  };
  mount(conv, h('h3', {}, other?.full_name || 'Conversación'), box, input, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: send }, 'Enviar')));
  await load();
}

// ---------- Notificaciones ----------
export async function notificationsView(el) {
  const { notifications } = await api.get('/notifications');
  mount(el, h('div', { class: 'row between' }, h('h1', {}, 'Notificaciones'),
    h('button', { class: 'btn small', onclick: async () => { await api.post('/notifications/read-all'); notificationsView(el); } }, 'Marcar todo como leído')),
  h('div', { class: 'stack' }, notifications.length ? notifications.map((n) => h('div', { class: `card tight ${n.read_at ? '' : 'alert info'}` },
    h('div', { class: 'row between' }, h('strong', {}, n.title), h('span', { class: 'small muted' }, fmtDateTime(n.created_at))),
    n.body ? h('p', { class: 'small' }, n.body) : null,
    n.link ? h('a', { href: n.link, onclick: () => api.post(`/notifications/${n.id}/read`).catch(() => {}) }, 'Abrir') : null))
    : h('div', { class: 'empty' }, 'No tienes notificaciones')));
}
