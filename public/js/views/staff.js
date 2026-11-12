// Vistas del personal (administrador y entrenador).
import { api, download } from '../api.js';
import { h, mount, toast, toastError, form, modal, table, tabs, kpi, pill, fmtDate, fmtDateTime, fmtPct, fmtUsd, loading, promptDialog, confirmDialog, errorText } from '../ui.js';
import { L, lab } from '../labels.js';
import { state } from '../app.js';
import { trainingPlanView, nutritionPlanView, rationaleView, progressBlock } from './common.js';
import { assessmentView } from './athlete.js';

const isAdmin = () => state.user.role === 'admin';

// ---------- Dashboard ----------
export async function dashboardView(el) {
  const d = await api.get('/dashboard');
  const alertList = d.alerts.length ? d.alerts.map((a) => h('div', { class: `alert ${a.level === 'high' ? 'high' : ''}` },
    a.athlete_id ? h('a', { href: `#/athlete/${a.athlete_id}` }, a.message) : a.message)) : [h('p', { class: 'muted' }, 'Sin alertas. Todo en orden.')];
  mount(el, h('h1', {}, isAdmin() ? 'Dashboard' : 'Mi panel'), h('p', { class: 'muted' }, 'Indicadores calculados con datos reales del sistema.'),
    h('div', { class: 'grid kpis' },
      kpi('Deportistas activos', d.athletes_active, isAdmin() ? `de ${d.capacity} contratados · ${d.athletes_registered} registrados` : `${d.athletes_registered} asignados`),
      isAdmin() ? kpi('Entrenadores activos', d.coaches_active) : null,
      kpi('Planes vigentes', d.training_plans_active, `${d.nutrition_plans_active} nutricionales`),
      kpi('Pendientes de revisión', d.plans_pending_review, 'propuestas de IA'),
      kpi('Evaluaciones pendientes', d.assessments_pending, `${d.assessments_to_review} por revisar`),
      kpi('Revisiones quincenales', d.biweekly_reviews_due, 'disponibles'),
      kpi('Cumplimiento (28 d)', fmtPct(d.training_adherence_28d), 'sesiones realizadas / planificadas'),
      kpi('Progreso', d.progress.athletes_with_data ? `${d.progress.athletes_improving}/${d.progress.athletes_with_data}` : '—', 'mejoran su 1RM estimado (14 d)'),
      kpi('Entrenaron (7 d)', d.athletes_training_last_7d),
      d.ai ? kpi('Consumo IA (mes)', fmtUsd(d.ai.month_cost_usd), `presupuesto ${fmtUsd(d.ai.budget_usd)} · ${d.ai.calls} solicitudes`) : null),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card stack' }, h('h2', {}, 'Alertas'), alertList),
      h('div', { class: 'card' }, h('h2', {}, 'Revisiones quincenales disponibles'), table([
        { label: 'Deportista', key: 'full_name' }, { label: 'Días con el plan', num: true, key: 'days_since' }],
      d.biweekly_reviews_due_list, { onRow: (r) => { location.hash = `#/athlete/${r.athlete_id}`; }, empty: 'Ninguna por ahora' }))));
}

// ---------- Lista de deportistas ----------
export async function athletesView(el) {
  const search = h('input', { placeholder: 'Buscar por nombre o correo', type: 'search' });
  const listBox = h('div');
  const load = async () => {
    const qs = new URLSearchParams({ role: 'athlete', limit: '200', ...(search.value ? { search: search.value } : {}) });
    const { users } = await api.get(`/users?${qs}`);
    mount(listBox, table([
      { label: 'Deportista', render: (u) => h('div', {}, h('strong', {}, u.full_name), h('div', { class: 'small muted' }, u.email)) },
      isAdmin() ? { label: 'Entrenador', render: (u) => u.coach_name || pill('Sin asignar', 'warn') } : null,
      { label: 'Evaluación', render: (u) => (u.assessment_status ? pill(lab(L.assessment, u.assessment_status), u.assessment_status === 'draft' ? 'warn' : 'good') : pill('No iniciada')) },
      { label: 'Plan', render: (u) => (u.has_active_plan ? pill('Activo', 'good') : pill('Sin plan')) },
      { label: 'Estado', render: (u) => pill(u.status === 'active' ? 'Activo' : 'Inactivo', u.status === 'active' ? '' : 'bad') },
    ].filter(Boolean), users, { onRow: (u) => { location.hash = `#/athlete/${u.id}`; }, empty: 'No hay deportistas' }));
  };
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  mount(el, h('div', { class: 'row between' }, h('h1', {}, isAdmin() ? 'Deportistas' : 'Mis deportistas'),
    isAdmin() ? h('button', { class: 'btn primary', onclick: () => createUserDialog('athlete', load) }, '+ Nuevo deportista') : null),
  h('div', { class: 'card stack' }, search, listBox));
  await load();
}

export async function createUserDialog(role, onCreated) {
  let coaches = [];
  if (role === 'athlete') coaches = (await api.get('/users?role=coach&status=active&limit=200')).users;
  const f = form([
    { name: 'full_name', label: 'Nombre completo', full: true }, { name: 'email', label: 'Correo electrónico', type: 'email' },
    { name: 'phone', label: 'Teléfono' },
    role === 'athlete' ? { name: 'coach_id', label: 'Entrenador asignado', type: 'select', options: coaches.map((c) => [c.id, c.full_name]) } : { name: 'specialty', label: 'Especialidad' },
  ]);
  const res = await modal(role === 'athlete' ? 'Nuevo deportista' : 'Nuevo entrenador', f.el, [
    { label: 'Cancelar', value: null },
    { label: 'Crear', class: 'primary', onClick: async () => {
      try { return await api.post('/users', { ...f.values(), role }); } catch (err) { toastError(err); return false; }
    } }]);
  if (res?.temporary_password) {
    await modal('Usuario creado', h('div', { class: 'stack' },
      h('p', {}, 'Comparte esta contraseña temporal de forma segura. Se mostrará solo una vez y deberá cambiarse en el primer ingreso.'),
      h('div', { class: 'card tight' }, h('div', { class: 'small muted' }, res.user.email), h('strong', {}, res.temporary_password))), [{ label: 'Entendido', class: 'primary', value: true }]);
    onCreated?.();
  }
}

// ---------- Ficha del deportista ----------
export async function athleteDetailView(el, id) {
  const { athlete } = await api.get(`/users/athletes/${id}`);
  const panel = h('div');
  const sections = [
    ['Resumen', () => summaryTab(panel, athlete)],
    ['Evaluación', () => assessmentTab(panel, athlete)],
    ['Planes', () => plansTab(panel, athlete)],
    ['Progreso', () => progressBlock(panel, athlete.id)],
    ['Observaciones', () => notesTab(panel, athlete)],
  ];
  mount(el, h('div', { class: 'row between' }, h('div', {}, h('h1', {}, athlete.full_name), h('div', { class: 'muted small' }, `${athlete.email} · alta ${fmtDate(athlete.joined_at)}`)),
    h('div', { class: 'row' }, h('a', { class: 'btn small', href: `#/messages/${athlete.id}` }, 'Mensaje'))),
  tabs(sections.map((s) => s[0]), (i) => sections[i][1]().catch((err) => mount(panel, h('div', { class: 'alert high' }, errorText(err))))), panel);
}

async function summaryTab(panel, athlete) {
  mount(panel, loading());
  const [quota, cur, pending] = await Promise.all([
    api.get(`/ai/athletes/${athlete.id}/quota`), api.get(`/assessments/athlete/${athlete.id}/current`), api.get('/plans/pending')]);
  const flags = cur.evaluation?.flags || [];
  const mine = pending.pending.filter((p) => p.athlete_id === athlete.id);
  const q = quota.adjustment;
  const aiBtn = (label, fn, enabled = true) => {
    const b = h('button', { class: 'btn primary', disabled: !enabled }, label);
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'Procesando con IA… (puede tardar unos minutos)';
      try { const r = await fn(); toast(r.reused ? 'Se reutilizó una respuesta previa idéntica (sin costo).' : 'Propuesta generada. Revísala antes de activarla.'); summaryTab(panel, athlete); } catch (err) { toastError(err); b.disabled = false; b.textContent = label; }
    };
    return b;
  };
  let coaches = null;
  if (isAdmin()) coaches = (await api.get('/users?role=coach&status=active&limit=200')).users;
  const coachSel = coaches ? h('select', { onchange: async (e) => {
    try { await api.put(`/users/athletes/${athlete.id}/coach`, { coach_id: e.target.value || null }); toast('Entrenador asignado'); } catch (err) { toastError(err); }
  } }, h('option', { value: '' }, '— Sin entrenador —'), coaches.map((c) => h('option', { value: c.id, selected: c.id === athlete.coach_id }, c.full_name))) : null;

  const clearance = (type, granted, note) => h('div', { class: 'row between q-row' },
    h('div', {}, h('strong', {}, type === 'medical' ? 'Autorización médica' : 'Autorización nutricional profesional'),
      h('div', { class: 'small muted' }, granted ? `Registrada: ${note || ''}` : 'No registrada')),
    h('button', { class: 'btn small', onclick: async () => {
      const n = await promptDialog(granted ? 'Retirar autorización' : 'Registrar autorización', 'Detalle (profesional, fecha, documento)');
      if (!n) return;
      try { await api.put(`/users/athletes/${athlete.id}/clearance`, { type, granted: !granted, note: n }); toast('Registrado'); athleteDetailViewReload(athlete.id); } catch (err) { toastError(err); }
    } }, granted ? 'Retirar' : 'Registrar'));

  mount(panel, h('div', { class: 'grid cols-2' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Estado'),
      h('div', { class: 'row' }, 'Evaluación: ', cur.assessment ? pill(lab(L.assessment, cur.assessment.status), cur.assessment.status === 'draft' ? 'warn' : 'good') : pill('No iniciada', 'warn')),
      coachSel ? h('label', { class: 'field' }, h('span', {}, 'Entrenador asignado'), coachSel) : null,
      flags.map((f) => h('div', { class: 'alert high' }, f.message)),
      clearance('medical', athlete.medical_clearance, athlete.medical_clearance_note),
      clearance('nutrition', athlete.nutrition_clearance, athlete.nutrition_clearance_note),
      mine.length ? h('div', { class: 'alert info' }, h('strong', {}, 'Propuestas pendientes: '), mine.map((p) => h('a', { href: `#/plan/${p.kind}/${p.id}` }, ` ${p.kind === 'training' ? 'Entrenamiento' : 'Nutrición'} v${p.version}`))) : null),
    h('div', { class: 'card stack' }, h('h2', {}, 'Inteligencia artificial'),
      h('p', { class: 'small muted' }, 'La IA se usa solo en estos momentos. Toda propuesta queda pendiente hasta que la apruebes, modifiques o rechaces.'),
      h('div', { class: 'stack' },
        h('h3', {}, '1. Generación inicial (entrenamiento + nutrición)'),
        aiBtn('Generar plan inicial', () => api.post(`/ai/athletes/${athlete.id}/initial`, { include_nutrition: true }), !q.has_active_plan && cur.assessment && cur.assessment.status !== 'draft'),
        h('h3', {}, '2. Ajuste quincenal del entrenamiento'),
        h('p', { class: 'small' }, `Usados este mes: ${q.used}/${q.max}. `, q.next_available_at ? `Disponible desde: ${fmtDate(q.next_available_at)}.` : ''),
        aiBtn('Solicitar ajuste quincenal', async () => {
          const req = await promptDialog('Ajuste quincenal', 'Indicaciones para la IA (opcional)', { required: false });
          if (req === null) throw new Error('Cancelado');
          return api.post(`/ai/athletes/${athlete.id}/adjustment`, { request: req || '' });
        }, q.available),
        h('h3', {}, '3. Actualización nutricional'),
        h('p', { class: 'small' }, quota.nutrition.relevant_changes.length ? `Cambios relevantes: ${quota.nutrition.relevant_changes.join('; ')}` : 'Sin cambios relevantes detectados (peso, objetivo o restricciones).'),
        aiBtn('Actualizar plan nutricional', async () => {
          const reason = quota.nutrition.relevant_changes.length ? '' : await promptDialog('Justificación', 'Explica el cambio relevante (mín. 20 caracteres)');
          if (reason === null) throw new Error('Cancelado');
          return api.post(`/ai/athletes/${athlete.id}/nutrition-update`, { reason: reason || '' });
        }, quota.nutrition.has_active_plan),
        h('h3', {}, 'Sin IA'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => manualPlanDialog(athlete) }, 'Crear rutina manual'))))),
  isAdmin() ? h('div', { class: 'card row between' }, h('div', {}, h('strong', {}, 'Privacidad'), h('div', { class: 'small muted' }, 'Exportar o eliminar la información personal del deportista.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => download(`/privacy/athlete/${athlete.id}/export`, `datos-${athlete.id}.json`).catch(toastError) }, 'Exportar datos'),
      h('button', { class: 'btn small danger', onclick: async () => {
        const c = await promptDialog('Eliminar información personal', 'Esta acción es irreversible. Escribe ELIMINAR para confirmar.', { multiline: false });
        if (c !== 'ELIMINAR') return;
        try { await api.del(`/privacy/athlete/${athlete.id}`, { confirm: c }); toast('Información eliminada'); location.hash = '#/athletes'; } catch (err) { toastError(err); }
      } }, 'Eliminar'))) : null);
}
const athleteDetailViewReload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

async function assessmentTab(panel, athlete) {
  mount(panel, loading());
  const res = await api.get(`/assessments/athlete/${athlete.id}/current`);
  const a = res.assessment;
  if (!a) {
    mount(panel, h('div', { class: 'card stack' }, h('p', {}, 'El deportista aún no inicia su evaluación.'),
      h('button', { class: 'btn', onclick: () => assessmentView(panel, athlete.id, { onDone: () => assessmentTab(panel, athlete) }) }, 'Completarla con el deportista')));
    return;
  }
  if (a.status === 'draft') {
    await assessmentView(panel, athlete.id, { onDone: () => assessmentTab(panel, athlete) });
    return;
  }
  const d = a.data;
  const kv = (pairs) => h('table', {}, h('tbody', {}, pairs.filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, Array.isArray(v) ? v.join(', ') : String(v))))));
  const hl = d.health || {};
  mount(panel, h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('div', { class: 'row' }, pill(lab(L.assessment, a.status), 'good'), h('span', { class: 'small muted' }, `Enviada ${fmtDate(a.submitted_at)}`)),
      h('div', { class: 'row' },
        a.status === 'submitted' ? h('button', { class: 'btn small primary', onclick: async () => {
          const notes = await promptDialog('Marcar como revisada', 'Notas de revisión (opcional)', { required: false });
          if (notes === null) return;
          try { await api.post(`/assessments/athlete/${athlete.id}/review`, { notes }); toast('Revisada'); assessmentTab(panel, athlete); } catch (err) { toastError(err); }
        } }, 'Marcar revisada') : null,
        h('button', { class: 'btn small', onclick: async () => {
          if (!(await confirmDialog('Reabrir evaluación', 'La evaluación volverá a borrador para corregirla.'))) return;
          try { await api.post(`/assessments/athlete/${athlete.id}/reopen`, { mode: 'reopen' }); assessmentTab(panel, athlete); } catch (err) { toastError(err); }
        } }, 'Reabrir'))),
    (res.evaluation.flags || []).map((f) => h('div', { class: 'alert high' }, f.message)),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h3', {}, 'Datos personales'), kv([['Nacimiento', d.personal?.birth_date], ['Sexo', lab(L.sex, d.personal?.sex)], ['Peso', d.personal?.weight_kg && `${d.personal.weight_kg} kg`],
        ['Estatura', d.personal?.height_cm && `${d.personal.height_cm} cm`], ['Actividad', lab(L.activity, d.personal?.daily_activity)]])),
      h('div', { class: 'card' }, h('h3', {}, 'Objetivos y experiencia'), kv([['Objetivo', lab(L.goal, d.goals?.primary_goal)], ['Secundarios', (d.goals?.secondary_goals || []).map((g) => L.goal[g])],
        ['Meta', d.goals?.target_description], ['Nivel', lab(L.level, d.experience?.level)], ['Meses', d.experience?.months_training], ['Historial', d.experience?.history]])),
      h('div', { class: 'card' }, h('h3', {}, 'Salud (confidencial)'), kv([['Lesiones', hl.has_injuries ? hl.injuries : 'No'], ['Dolores', hl.pain], ['Operaciones', hl.surgeries],
        ['Enfermedades', hl.has_conditions ? hl.conditions : 'No'], ['Medicamentos', hl.takes_medications ? hl.medications : 'No'], ['Limitaciones', hl.limitations],
        ['Alergias', hl.allergies], ['Restricciones', hl.dietary_restrictions]])),
      h('div', { class: 'card' }, h('h3', {}, 'Disponibilidad, equipamiento y hábitos'), kv([['Días', (d.availability?.days || []).map((x) => L.weekday[x])], ['Minutos', d.availability?.session_minutes],
        ['Horario', lab(L.time, d.availability?.preferred_time)], ['Equipamiento', (d.equipment?.available || []).map((x) => L.equipment[x])],
        ['Sueño', d.habits?.sleep_hours && `${d.habits.sleep_hours} h`], ['Estrés', d.habits?.stress_level], ['Agua', d.habits?.water_liters && `${d.habits.water_liters} L`],
        ['Alimentación', d.habits?.diet_description], ['Presupuesto', lab(L.budget, d.habits?.food_budget)]])))));
}

async function plansTab(panel, athlete) {
  mount(panel, loading());
  const [{ training, nutrition }, hist] = await Promise.all([api.get(`/plans/athlete/${athlete.id}/current`), api.get(`/plans/athlete/${athlete.id}/history`)]);
  const histTable = (rows, kind) => table([
    { label: 'Versión', render: (p) => `v${p.version}` }, { label: 'Origen', render: (p) => lab(L.planSource, p.source) },
    { label: 'Estado', render: (p) => pill(lab(L.planStatus, p.status), p.status === 'active' ? 'good' : p.status === 'pending_review' ? 'warn' : p.status === 'rejected' ? 'bad' : '') },
    { label: 'Creado', render: (p) => fmtDate(p.created_at) }, { label: 'Notas', render: (p) => p.review_notes || p.update_reason || '—' }],
  rows, { onRow: (p) => { location.hash = `#/plan/${kind}/${p.id}`; } });
  mount(panel, h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h2', {}, 'Entrenamiento vigente'), training ? trainingPlanView(training).el : h('p', { class: 'muted' }, 'Sin plan activo.')),
    h('div', { class: 'card' }, h('h2', {}, 'Nutrición vigente'), nutrition ? nutritionPlanView(nutrition.content) : h('p', { class: 'muted' }, 'Sin plan nutricional activo.')),
    h('div', { class: 'card' }, h('h2', {}, 'Historial de cambios · entrenamiento'), histTable(hist.training, 'training')),
    h('div', { class: 'card' }, h('h2', {}, 'Historial · nutrición'), histTable(hist.nutrition, 'nutrition'))));
}

async function notesTab(panel, athlete) {
  const { notes } = await api.get(`/tracking/athlete/${athlete.id}/notes`);
  const input = h('textarea', { placeholder: 'Observación (técnica, adherencia, sensaciones…)' });
  mount(panel, h('div', { class: 'card stack' }, input, h('button', { class: 'btn primary', onclick: async () => {
    try { await api.post(`/tracking/athlete/${athlete.id}/notes`, { body: input.value }); notesTab(panel, athlete); } catch (err) { toastError(err); }
  } }, 'Guardar observación'),
  notes.map((n) => h('div', { class: 'card tight' }, h('div', { class: 'small muted' }, `${n.author_name} · ${fmtDateTime(n.created_at)}`), h('p', { class: 'pre' }, n.body)))));
}

// Rutina manual: el entrenador elige ejercicios de la biblioteca
async function manualPlanDialog(athlete) {
  const { exercises } = await api.get('/exercises?limit=200');
  const days = [];
  const box = h('div', { class: 'stack' });
  const addDay = () => { days.push({ key: String.fromCharCode(65 + days.length), name: `Día ${String.fromCharCode(65 + days.length)}`, exercises: [] }); draw(); };
  const draw = () => mount(box, days.map((d) => h('div', { class: 'card tight stack' },
    h('input', { value: d.name, oninput: (e) => { d.name = e.target.value; } }),
    d.exercises.map((e, i) => h('div', { class: 'row' }, h('span', {}, exercises.find((x) => x.id === e.exercise_id)?.name),
      h('input', { type: 'number', value: e.sets, min: 1, max: 10, oninput: (ev) => { e.sets = Number(ev.target.value); }, 'aria-label': 'Series' }),
      h('input', { value: e.reps, oninput: (ev) => { e.reps = ev.target.value; }, 'aria-label': 'Repeticiones' }),
      h('button', { class: 'btn ghost small', onclick: () => { d.exercises.splice(i, 1); draw(); } }, '✕'))),
    h('select', { onchange: (e) => { if (e.target.value) { d.exercises.push({ exercise_id: e.target.value, sets: 3, reps: '10', rest_seconds: 90 }); draw(); } } },
      h('option', { value: '' }, '+ Añadir ejercicio'), exercises.map((x) => h('option', { value: x.id }, x.name))))));
  addDay();
  await modal('Rutina manual', h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Se activará de inmediato y reemplazará el plan vigente.'), box,
    h('button', { class: 'btn small', onclick: addDay }, '+ Día')), [
    { label: 'Cancelar', value: null },
    { label: 'Activar rutina', class: 'primary', onClick: async () => {
      try { await api.post(`/plans/training/athlete/${athlete.id}/manual`, { content: { days, summary: 'Rutina creada manualmente por el entrenador' } }); toast('Rutina activada'); return true; } catch (err) { toastError(err); return false; }
    } }]);
}

// ---------- Revisiones pendientes ----------
export async function reviewsView(el) {
  const { pending } = await api.get('/plans/pending');
  mount(el, h('h1', {}, 'Revisiones pendientes'), h('p', { class: 'muted' }, 'Propuestas de la IA que esperan tu aprobación. Nada llega al deportista sin tu revisión.'),
    h('div', { class: 'card' }, table([
      { label: 'Deportista', key: 'full_name' }, { label: 'Tipo', render: (p) => (p.kind === 'training' ? 'Entrenamiento' : 'Nutrición') },
      { label: 'Origen', render: (p) => lab(L.planSource, p.source) }, { label: 'Versión', render: (p) => `v${p.version}` }, { label: 'Generado', render: (p) => fmtDateTime(p.created_at) }],
    pending, { onRow: (p) => { location.hash = `#/plan/${p.kind}/${p.id}`; }, empty: 'No hay propuestas pendientes' })));
}

export async function planReviewView(el, kind, id) {
  const { plan, citations, parent } = await api.get(`/plans/${kind}/${id}`);
  const view = kind === 'training' ? trainingPlanView(plan, { editable: plan.status === 'pending_review' }) : null;
  const changes = plan.change_summary || [];
  const exMap = plan.exercises || {};
  const notes = h('textarea', { placeholder: 'Notas de revisión (obligatorias para rechazar)' });
  const act = async (decision) => {
    try {
      const body = { decision, notes: notes.value.trim() || undefined };
      if (decision === 'approve' && view) body.content = view.getContent();
      if (decision === 'approve' && !(await confirmDialog('Aprobar y activar', 'El plan reemplazará al vigente y el deportista lo verá de inmediato.', 'Aprobar'))) return;
      await api.post(`/plans/${kind}/${id}/review`, body);
      toast(decision === 'approve' ? 'Plan activado' : 'Propuesta rechazada');
      location.hash = `#/athlete/${plan.athlete_id}`;
    } catch (err) { toastError(err); }
  };
  mount(el, h('div', { class: 'row between' },
    h('div', {}, h('h1', {}, `${kind === 'training' ? 'Entrenamiento' : 'Nutrición'} v${plan.version}`),
      h('div', { class: 'row' }, pill(lab(L.planStatus, plan.status), plan.status === 'pending_review' ? 'warn' : 'good'), pill(lab(L.planSource, plan.source)),
        h('a', { href: `#/athlete/${plan.athlete_id}` }, 'Ver deportista'))),
    parent ? h('span', { class: 'small muted' }, `Basado en v${parent.version}`) : null),
  plan.update_reason ? h('div', { class: 'alert info' }, h('strong', {}, 'Motivo de actualización: '), plan.update_reason) : null,
  changes.length ? h('div', { class: 'card' }, h('h2', {}, 'Cambios propuestos'), table([
    { label: 'Tipo', render: (c) => lab(L.change, c.change_type) }, { label: 'Día', key: 'day_key' },
    { label: 'Ejercicio', render: (c) => exMap[c.exercise_id]?.name || '—' }, { label: 'Antes', key: 'before' }, { label: 'Después', key: 'after' }, { label: 'Motivo', key: 'reason' }], changes)) : null,
  plan.content.period_summary ? h('div', { class: 'card' }, h('h3', {}, 'Datos del periodo analizado (calculados sin IA)'), h('p', { class: 'small' },
    `Sesiones ${plan.content.period_summary.sessions.done}/${plan.content.period_summary.sessions.planned} · cumplimiento ${fmtPct(plan.content.period_summary.sessions.adherence)} · fatiga media ${plan.content.period_summary.wellness.avg_fatigue ?? '—'} · molestias ${plan.content.period_summary.wellness.pain_reports}`)) : null,
  h('div', { class: 'grid cols-2' },
    h('div', { class: 'stack' }, h('h2', {}, 'Propuesta'), view ? [plan.status === 'pending_review' ? h('p', { class: 'small muted' }, 'Puedes modificar series, repeticiones, RIR y descanso antes de aprobar.') : null, view.el] : nutritionPlanView(plan.content)),
    h('div', { class: 'stack' }, h('h2', {}, 'Fundamentos'), rationaleView(plan, citations))),
  plan.status === 'pending_review' ? h('div', { class: 'card stack' }, h('h2', {}, 'Decisión del entrenador'), notes,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => act('approve') }, 'Aprobar y activar'),
      h('button', { class: 'btn danger', onclick: () => act('reject') }, 'Rechazar'))) : (plan.review_notes ? h('div', { class: 'alert info' }, h('strong', {}, 'Notas de revisión: '), plan.review_notes) : null));
}
