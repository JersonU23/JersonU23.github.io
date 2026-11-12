// Vistas del deportista: interfaz sencilla y pensada para el móvil.
import { api } from '../api.js';
import { h, mount, toast, toastError, form, fmtDate, pill, table, errorText } from '../ui.js';
import { L, lab, opts } from '../labels.js';
import { state } from '../app.js';
import { exerciseInfo, nutritionPlanView, progressBlock } from './common.js';

const me = () => state.user.id;

// ---------- Hoy: entrenamiento del día y registro de series ----------
export async function todayView(el) {
  const [{ training }, { sessions }, assessment] = await Promise.all([
    api.get(`/plans/athlete/${me()}/current`), api.get(`/tracking/athlete/${me()}/sessions?limit=10`), api.get(`/assessments/athlete/${me()}/current`)]);
  if (!training) {
    const a = assessment.assessment;
    mount(el, h('h1', {}, 'Hola, ' + state.user.full_name.split(' ')[0]), h('div', { class: 'card stack' },
      !a || a.status === 'draft'
        ? [h('h2', {}, 'Completa tu evaluación inicial'), h('p', {}, 'Con tu evaluación, tu entrenador preparará un plan personalizado. Puedes guardarla y continuar después.'),
          h('a', { class: 'btn primary', href: '#/assessment' }, a ? 'Continuar evaluación' : 'Comenzar evaluación')]
        : [h('h2', {}, 'Tu plan está en preparación'), h('p', { class: 'muted' }, 'Tu entrenador está revisando tu evaluación. Te avisaremos cuando tu plan esté listo.')]));
    return;
  }
  const days = training.content.days;
  const last = sessions.find((s) => s.day_key);
  const nextIdx = last ? (days.findIndex((d) => d.key === last.day_key) + 1) % days.length : 0;
  let current = Math.max(0, nextIdx);
  const dayBox = h('div');
  const selector = h('div', { class: 'row' });
  const draw = () => {
    mount(selector, days.map((d, i) => h('button', { class: `btn small ${i === current ? 'primary' : ''}`, onclick: () => { current = i; draw(); } }, `${d.key} · ${d.name}`)));
    mount(dayBox, dayLogger(training, days[current]));
  };
  mount(el, h('h1', {}, 'Entrenamiento de hoy'),
    h('p', { class: 'muted' }, `Plan v${training.version} · próxima sesión sugerida: ${days[nextIdx >= 0 ? nextIdx : 0].name}`),
    selector, dayBox,
    h('div', { class: 'card' }, h('h3', {}, 'Últimas sesiones'), table([
      { label: 'Fecha', render: (s) => fmtDate(s.performed_on) }, { label: 'Día', key: 'day_key' },
      { label: 'Series', num: true, render: (s) => s.sets.length }, { label: 'Fatiga', num: true, key: 'fatigue' }], sessions, { empty: 'Aún no registras sesiones' })));
  draw();
}

function dayLogger(plan, day) {
  const exMap = plan.exercises || {};
  const rows = [];
  const cards = day.exercises.map((e) => {
    const ex = exMap[e.exercise_id];
    const grid = h('div', { class: 'sets-grid' }, h('span', { class: 'small muted' }, 'Serie'), h('span', { class: 'small muted' }, 'Reps'),
      h('span', { class: 'small muted' }, 'Kg'), h('span', { class: 'small muted' }, 'RIR'));
    for (let n = 1; n <= e.sets; n++) {
      const reps = h('input', { type: 'number', inputmode: 'numeric', min: 0, placeholder: e.reps, 'aria-label': `Repeticiones serie ${n}` });
      const load = h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 0.5, 'aria-label': `Carga serie ${n}` });
      const rir = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 10, 'aria-label': `RIR serie ${n}` });
      grid.append(h('span', {}, n), reps, load, rir);
      rows.push({ exercise_id: e.exercise_id, set_number: n, reps, load, rir });
    }
    return h('div', { class: 'exercise' },
      h('div', { class: 'row between' }, h('strong', {}, ex?.name || 'Ejercicio'), h('span', { class: 'row small' }, pill(`${e.sets} × ${e.reps}`, 'info'), e.rir_or_rpe ? pill(e.rir_or_rpe) : null)),
      h('div', { class: 'small muted' }, [e.intensity, e.rest_seconds ? `Descanso ${e.rest_seconds}s` : null, e.notes].filter(Boolean).join(' · ')),
      grid, exerciseInfo(ex));
  });
  const meta = form([
    { name: 'duration_min', label: 'Duración (min)', type: 'number', min: 0 },
    { name: 'fatigue', label: 'Fatiga al terminar (1–10)', type: 'number', min: 1, max: 10 },
    { name: 'notes', label: 'Notas', type: 'textarea', full: true, placeholder: 'Sensaciones, molestias, observaciones…' },
  ]);
  const save = async (btn) => {
    const sets = rows.filter((r) => r.reps.value !== '').map((r) => ({
      exercise_id: r.exercise_id, set_number: r.set_number, reps: Number(r.reps.value),
      load_kg: r.load.value === '' ? null : Number(r.load.value), rir: r.rir.value === '' ? null : Number(r.rir.value) }));
    if (!sets.length) return toast('Registra al menos una serie', 'error');
    btn.disabled = true;
    try {
      await api.post(`/tracking/athlete/${me()}/sessions`, { day_key: day.key, sets, ...meta.values() });
      toast('Sesión registrada. ¡Buen trabajo!');
      location.hash = '#/progress';
    } catch (err) { toastError(err); } finally { btn.disabled = false; }
  };
  const btn = h('button', { class: 'btn primary', onclick: () => save(btn) }, 'Guardar sesión');
  return h('div', { class: 'stack' },
    day.warmup ? h('div', { class: 'alert info' }, h('strong', {}, 'Calentamiento: '), day.warmup) : null,
    cards, day.cooldown ? h('div', { class: 'alert info' }, h('strong', {}, 'Vuelta a la calma: '), day.cooldown) : null,
    h('div', { class: 'card' }, meta.el), btn);
}

// ---------- Registro: medidas, alimentación, bienestar ----------
export async function logView(el) {
  const forms = {
    measurements: form([
      { name: 'measured_on', label: 'Fecha', type: 'date' }, { name: 'weight_kg', label: 'Peso (kg)', type: 'number', step: 0.1 },
      { name: 'body_fat_pct', label: '% grasa (si lo conoces)', type: 'number', step: 0.1 }, { name: 'waist_cm', label: 'Cintura (cm)', type: 'number', step: 0.1 },
      { name: 'hip_cm', label: 'Cadera (cm)', type: 'number', step: 0.1 }, { name: 'chest_cm', label: 'Pecho (cm)', type: 'number', step: 0.1 },
      { name: 'arm_cm', label: 'Brazo (cm)', type: 'number', step: 0.1 }, { name: 'thigh_cm', label: 'Muslo (cm)', type: 'number', step: 0.1 }]),
    food: form([
      { name: 'logged_on', label: 'Fecha', type: 'date' },
      { name: 'meal', label: 'Comida', type: 'select', options: [['Desayuno', 'Desayuno'], ['Media mañana', 'Media mañana'], ['Almuerzo', 'Almuerzo'], ['Media tarde', 'Media tarde'], ['Cena', 'Cena'], ['Otro', 'Otro']] },
      { name: 'adherence', label: '¿Seguiste el plan?', type: 'select', options: opts(L.adherence) },
      { name: 'description', label: 'Qué comiste', type: 'textarea', full: true },
      { name: 'kcal', label: 'kcal (opcional)', type: 'number' }, { name: 'protein_g', label: 'Proteína g (opcional)', type: 'number' },
      { name: 'carbs_g', label: 'Carbohidratos g (opcional)', type: 'number' }, { name: 'fat_g', label: 'Grasas g (opcional)', type: 'number' }]),
    wellness: form([
      { name: 'reported_on', label: 'Fecha', type: 'date' }, { name: 'fatigue', label: 'Fatiga (1–10)', type: 'number', min: 1, max: 10 },
      { name: 'sleep_hours', label: 'Horas de sueño', type: 'number', step: 0.5 }, { name: 'stress', label: 'Estrés (1–10)', type: 'number', min: 1, max: 10 },
      { name: 'soreness', label: 'Agujetas / dolor muscular (1–10)', type: 'number', min: 1, max: 10 },
      { name: 'pain', label: '¿Tienes alguna molestia o dolor?', type: 'yesno' },
      { name: 'pain_location', label: '¿Dónde?', placeholder: 'Ej.: rodilla izquierda' }, { name: 'pain_intensity', label: 'Intensidad (0–10)', type: 'number', min: 0, max: 10 },
      { name: 'notes', label: 'Notas', type: 'textarea', full: true }]),
  };
  const titles = { measurements: 'Medidas corporales', food: 'Alimentación', wellness: 'Bienestar y molestias' };
  const card = (key) => {
    const btn = h('button', { class: 'btn primary' }, 'Guardar');
    btn.onclick = async () => {
      btn.disabled = true;
      try { await api.post(`/tracking/athlete/${me()}/${key}`, forms[key].values()); toast('Registro guardado'); logView(el); } catch (err) { toastError(err); } finally { btn.disabled = false; }
    };
    return h('div', { class: 'card stack' }, h('h2', {}, titles[key]), forms[key].el, btn);
  };
  const [{ measurements }, { food }] = await Promise.all([api.get(`/tracking/athlete/${me()}/measurements`), api.get(`/tracking/athlete/${me()}/food`)]);
  mount(el, h('h1', {}, 'Registrar'), h('p', { class: 'muted' }, 'Tus registros alimentan tu progreso y la revisión quincenal con tu entrenador.'),
    h('div', { class: 'grid cols-2' }, card('wellness'), card('measurements'), card('food'),
      h('div', { class: 'card' }, h('h3', {}, 'Últimas medidas'), table([{ label: 'Fecha', render: (m) => fmtDate(m.measured_on) },
        { label: 'Peso', num: true, render: (m) => m.weight_kg ?? '—' }, { label: 'Cintura', num: true, render: (m) => m.waist_cm ?? '—' }], measurements.slice(0, 8)),
      h('h3', {}, 'Última alimentación'), table([{ label: 'Fecha', render: (f) => fmtDate(f.logged_on) }, { label: 'Comida', key: 'meal' },
        { label: 'Plan', render: (f) => lab(L.adherence, f.adherence) }], food.slice(0, 8)))));
}

export async function progressView(el) {
  const box = h('div');
  mount(el, h('h1', {}, 'Mi progreso'), box);
  await progressBlock(box, me());
}

export async function nutritionView(el) {
  const { nutrition } = await api.get(`/plans/athlete/${me()}/current`);
  mount(el, h('h1', {}, 'Plan nutricional'), nutrition ? nutritionPlanView(nutrition.content)
    : h('div', { class: 'card empty' }, 'Aún no tienes un plan nutricional activo. Tu entrenador te avisará cuando esté disponible.'));
}

// ---------- Evaluación inicial: formulario progresivo, guardable y retomable ----------
const STEP_TITLES = { personal: 'Datos personales', goals: 'Objetivos', experience: 'Experiencia', health: 'Salud', availability: 'Disponibilidad', equipment: 'Equipamiento', habits: 'Hábitos' };

export function assessmentForms(data) {
  const d = (k) => data[k] || {};
  const health = d('health');
  return {
    personal: form([
      { name: 'birth_date', label: 'Fecha de nacimiento', type: 'date' }, { name: 'sex', label: 'Sexo', type: 'select', options: opts(L.sex) },
      { name: 'weight_kg', label: 'Peso (kg)', type: 'number', step: 0.1 }, { name: 'height_cm', label: 'Estatura (cm)', type: 'number' },
      { name: 'daily_activity', label: 'Actividad cotidiana (fuera del gimnasio)', type: 'select', options: opts(L.activity) },
      { name: 'occupation_activity', label: 'Describe tu actividad diaria / trabajo', type: 'textarea', full: true }], d('personal')),
    goals: form([
      { name: 'primary_goal', label: 'Objetivo principal', type: 'select', options: opts(L.goal) },
      { name: 'target_weight_kg', label: 'Peso objetivo (opcional)', type: 'number', step: 0.1 },
      { name: 'secondary_goals', label: 'Objetivos secundarios', type: 'multi', options: opts(L.goal), full: true },
      { name: 'target_description', label: '¿Qué te gustaría lograr?', type: 'textarea', full: true }], d('goals')),
    experience: form([
      { name: 'level', label: 'Nivel', type: 'select', options: opts(L.level) }, { name: 'months_training', label: 'Meses entrenando', type: 'number', min: 0 },
      { name: 'current_frequency_per_week', label: 'Entrenamientos por semana actualmente', type: 'number', min: 0 },
      { name: 'history', label: 'Historial deportivo', type: 'textarea', full: true }], d('experience')),
    health: form([
      { name: 'has_injuries', label: '¿Tienes lesiones actuales o recientes?', type: 'yesno' }, { name: 'injuries', label: 'Describe tus lesiones', type: 'textarea', full: true },
      { name: 'pain', label: 'Dolores frecuentes', type: 'textarea', full: true }, { name: 'surgeries', label: 'Operaciones', type: 'textarea', full: true },
      { name: 'has_conditions', label: '¿Tienes enfermedades relevantes diagnosticadas?', type: 'yesno' }, { name: 'conditions', label: 'Descríbelas', type: 'textarea', full: true },
      { name: 'takes_medications', label: '¿Tomas medicamentos?', type: 'yesno' }, { name: 'medications', label: '¿Cuáles?', type: 'textarea', full: true },
      { name: 'limitations', label: 'Limitaciones de movimiento', type: 'textarea', full: true },
      { name: 'allergies', label: 'Alergias', full: true }, { name: 'dietary_restrictions', label: 'Restricciones alimentarias (vegetariano, sin lactosa…)', full: true }], health),
    screening: form(Object.entries(L.screening).map(([k, label]) => ({ name: k, label, type: 'yesno' })), health.screening || {}),
    clinical: form(Object.entries(L.clinical).map(([k, label]) => ({ name: k, label, type: 'yesno' })), health.clinical_nutrition || {}),
    availability: form([
      { name: 'days', label: 'Días disponibles', type: 'multi', options: opts(L.weekday).filter(([k]) => k !== 'any'), full: true },
      { name: 'preferred_time', label: 'Horario preferido', type: 'select', options: opts(L.time) },
      { name: 'session_minutes', label: 'Minutos por sesión', type: 'number', min: 15, max: 240 }], d('availability')),
    equipment: form([
      { name: 'available', label: 'Equipamiento que puedes usar', type: 'multi', options: opts(L.equipment), full: true },
      { name: 'notes', label: 'Notas', type: 'textarea', full: true }], d('equipment')),
    habits: form([
      { name: 'sleep_hours', label: 'Horas de sueño', type: 'number', step: 0.5 }, { name: 'stress_level', label: 'Estrés (1–10)', type: 'number', min: 1, max: 10 },
      { name: 'water_liters', label: 'Agua al día (L)', type: 'number', step: 0.1 }, { name: 'meals_per_day', label: 'Comidas al día', type: 'number' },
      { name: 'food_budget', label: 'Presupuesto para alimentación', type: 'select', options: opts(L.budget) },
      { name: 'alcohol', label: 'Alcohol', type: 'select', options: opts(L.alcohol) }, { name: 'smoking', label: 'Fumo', type: 'checkbox' },
      { name: 'diet_description', label: 'Describe tu alimentación habitual', type: 'textarea', full: true },
      { name: 'food_preferences', label: 'Alimentos que prefieres', type: 'textarea', full: true },
      { name: 'disliked_foods', label: 'Alimentos que no te gustan', type: 'textarea', full: true },
      { name: 'recovery_notes', label: 'Recuperación (descanso, masajes, otros deportes)', type: 'textarea', full: true }], d('habits')),
  };
}

export function sectionPayload(forms, step) {
  if (step !== 'health') return forms[step].values();
  return { ...forms.health.values(), screening: forms.screening.values(), clinical_nutrition: forms.clinical.values() };
}

export async function assessmentView(el, athleteId = me(), { onDone } = {}) {
  const res = await api.get(`/assessments/athlete/${athleteId}/current`);
  const a = res.assessment;
  const steps = res.steps;
  if (a && a.status !== 'draft' && state.user.role === 'athlete') {
    mount(el, h('h1', {}, 'Evaluación inicial'), h('div', { class: 'card stack' },
      h('p', {}, `Tu evaluación fue enviada el ${fmtDate(a.submitted_at)}.`), pill(lab(L.assessment, a.status), 'good'),
      (res.evaluation?.flags || []).map((f) => h('div', { class: 'alert high' }, f.message)),
      h('p', { class: 'muted' }, 'Si necesitas corregir algo, escríbele a tu entrenador.')));
    return;
  }
  const forms = assessmentForms(a?.data || {});
  let idx = Math.max(0, steps.indexOf(a?.current_step || steps[0]));
  const stepBar = h('div', { class: 'steps' });
  const body = h('div', { class: 'card stack' });
  const missingBox = h('div');
  const save = async () => {
    const step = steps[idx];
    const r = await api.put(`/assessments/athlete/${athleteId}/section/${step}`, sectionPayload(forms, step));
    showMissing(r.evaluation.missing);
  };
  const showMissing = (missing) => mount(missingBox, missing?.length ? h('div', { class: 'alert small' }, h('strong', {}, 'Datos pendientes para un plan seguro: '),
    missing.map((m) => m.label).join(' · ')) : h('div', { class: 'alert info small' }, 'Tienes todos los datos críticos. Ya puedes enviar tu evaluación.'));
  const draw = () => {
    mount(stepBar, steps.map((s, i) => h('span', { class: i === idx ? 'on' : '', onclick: async () => { try { await save(); idx = i; draw(); } catch (err) { toastError(err); } } }, `${i + 1}. ${STEP_TITLES[s]}`)));
    const step = steps[idx];
    const isLast = idx === steps.length - 1;
    const next = h('button', { class: 'btn primary' }, isLast ? 'Guardar y enviar' : 'Guardar y continuar');
    next.onclick = async () => {
      next.disabled = true;
      try {
        await save();
        if (!isLast) { idx++; draw(); return; }
        await api.post(`/assessments/athlete/${athleteId}/submit`);
        toast('Evaluación enviada');
        if (onDone) onDone(); else assessmentView(el, athleteId);
      } catch (err) {
        if (err.code === 'missing_critical') showMissing(err.details); else toastError(err);
        if (err.code === 'missing_critical') toast(errorText({ message: 'Faltan datos críticos' }), 'error');
      } finally { next.disabled = false; }
    };
    mount(body, h('h2', {}, STEP_TITLES[step]),
      step === 'health' ? [h('p', { class: 'muted small' }, 'Esta información se guarda cifrada y solo la ven tu entrenador y el administrador.'),
        forms.health.el, h('h3', {}, 'Cuestionario previo a la actividad física'), forms.screening.el,
        h('h3', {}, 'Condiciones relevantes para la nutrición'), forms.clinical.el] : forms[step].el,
      h('div', { class: 'row between' },
        h('button', { class: 'btn', disabled: idx === 0, onclick: async () => { try { await save(); idx--; draw(); } catch (err) { toastError(err); } } }, 'Anterior'),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: async () => { try { await save(); toast('Progreso guardado. Puedes continuar luego.'); } catch (err) { toastError(err); } } }, 'Guardar'), next)));
  };
  mount(el, h('h1', {}, 'Evaluación inicial'), h('p', { class: 'muted' }, 'Puedes guardar y retomar cuando quieras. Los datos marcados como críticos son necesarios para planificar de forma segura.'),
    stepBar, missingBox, body);
  showMissing(res.evaluation?.missing);
  draw();
}
