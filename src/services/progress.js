// Métricas de seguimiento calculadas con SQL/JS convencional. Ninguna función aquí llama a IA.
import { one, many } from '../db/pool.js';

// 1RM estimado (fórmula de Epley). Solo se usa para comparar tendencias del mismo ejercicio.
export const e1rm = (load, reps) => (load && reps ? load * (1 + reps / 30) : 0);

const round = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

// Sesiones planificadas por semana según el plan activo
function plannedPerWeek(plan) {
  return plan?.content?.days?.length || 0;
}

export async function activePlan(athleteId) {
  return one(`SELECT * FROM training_plans WHERE athlete_id = $1 AND status = 'active'`, [athleteId]);
}

/** Resumen de un periodo (por defecto últimos 15 días). */
export async function periodSummary(athleteId, { days = 15, since = null } = {}) {
  const from = since ? new Date(since) : new Date(Date.now() - days * 86400000);
  const fromStr = from.toISOString().slice(0, 10);
  const spanDays = Math.max(1, Math.round((Date.now() - from.getTime()) / 86400000));
  const plan = await activePlan(athleteId);

  const sessions = await many(
    `SELECT id, performed_on, day_key, duration_min, fatigue FROM workout_sessions
      WHERE athlete_id = $1 AND performed_on >= $2 ORDER BY performed_on`, [athleteId, fromStr]);
  // Lo planificado se cuenta solo desde que el plan está activo (un plan nuevo no arrastra semanas previas).
  const planDays = plan?.activated_at ? Math.max(1, Math.ceil((Date.now() - new Date(plan.activated_at).getTime()) / 86400000)) : spanDays;
  const planned = Math.round((plannedPerWeek(plan) * Math.min(spanDays, planDays)) / 7);
  const adherence = planned ? Math.min(1, sessions.length / planned) : null;

  // Progreso por ejercicio: mejor e1RM de la primera vs. la segunda mitad del periodo
  const sets = await many(
    `SELECT sl.exercise_id, e.name, e.primary_muscles, ws.performed_on, sl.reps, sl.load_kg, sl.rir, sl.rpe
       FROM set_logs sl JOIN workout_sessions ws ON ws.id = sl.session_id
       LEFT JOIN exercises e ON e.id = sl.exercise_id
      WHERE ws.athlete_id = $1 AND ws.performed_on >= $2 ORDER BY ws.performed_on`, [athleteId, fromStr]);
  const mid = new Date(from.getTime() + (Date.now() - from.getTime()) / 2).toISOString().slice(0, 10);
  const byEx = new Map();
  for (const st of sets) {
    if (!st.exercise_id) continue;
    const k = st.exercise_id;
    if (!byEx.has(k)) byEx.set(k, { exercise_id: k, name: st.name, muscles: st.primary_muscles || [], sets: 0, reps: 0, volume_kg: 0, first: 0, second: 0, rir: [], top_load: 0 });
    const x = byEx.get(k);
    x.sets += 1;
    x.reps += st.reps;
    x.volume_kg += (st.load_kg || 0) * st.reps;
    x.top_load = Math.max(x.top_load, st.load_kg || 0);
    const est = e1rm(st.load_kg, st.reps);
    if (st.performed_on < mid) x.first = Math.max(x.first, est); else x.second = Math.max(x.second, est);
    if (st.rir !== null) x.rir.push(st.rir);
  }
  const exercises = [...byEx.values()].map((x) => ({
    exercise_id: x.exercise_id, name: x.name, muscles: x.muscles, sets: x.sets, total_reps: x.reps,
    volume_kg: round(x.volume_kg, 0), top_load_kg: x.top_load,
    e1rm_change_pct: x.first && x.second ? round(((x.second - x.first) / x.first) * 100, 1) : null,
    avg_rir: x.rir.length ? round(x.rir.reduce((a, b) => a + b, 0) / x.rir.length, 1) : null,
  }));

  // Volumen semanal por grupo muscular (series efectivas)
  const muscleSets = {};
  for (const x of exercises) for (const m of x.muscles) muscleSets[m] = (muscleSets[m] || 0) + x.sets;
  const weeks = spanDays / 7;
  const sets_per_muscle_week = Object.fromEntries(Object.entries(muscleSets).map(([m, n]) => [m, round(n / weeks, 1)]));

  const wellness = await one(
    `SELECT count(*)::int AS reports, avg(fatigue)::float AS fatigue, avg(sleep_hours)::float AS sleep,
            avg(stress)::float AS stress, avg(soreness)::float AS soreness, count(*) FILTER (WHERE pain)::int AS pain_reports
       FROM wellness_reports WHERE athlete_id = $1 AND reported_on >= $2`, [athleteId, fromStr]);
  const pains = await many(
    `SELECT reported_on, pain_location, pain_intensity FROM wellness_reports
      WHERE athlete_id = $1 AND reported_on >= $2 AND pain ORDER BY reported_on`, [athleteId, fromStr]);
  const sessionFatigue = sessions.filter((s) => s.fatigue).map((s) => s.fatigue);

  const weights = await many(
    `SELECT measured_on, weight_kg FROM body_measurements WHERE athlete_id = $1 AND weight_kg IS NOT NULL
      ORDER BY measured_on`, [athleteId]);
  const inPeriod = weights.filter((w) => w.measured_on >= fromStr);
  const lastBefore = weights.filter((w) => w.measured_on < fromStr).pop();
  const startW = lastBefore?.weight_kg ?? inPeriod[0]?.weight_kg ?? null;
  const endW = inPeriod.at(-1)?.weight_kg ?? null;

  const food = await one(
    `SELECT count(*)::int AS entries, count(*) FILTER (WHERE adherence = 'followed')::int AS followed,
            count(*) FILTER (WHERE adherence = 'partial')::int AS partial, count(*) FILTER (WHERE adherence = 'skipped')::int AS skipped
       FROM food_logs WHERE athlete_id = $1 AND logged_on >= $2`, [athleteId, fromStr]);

  return {
    period: { from: fromStr, days: spanDays },
    plan: plan ? { id: plan.id, version: plan.version, days_per_week: plannedPerWeek(plan), activated_at: plan.activated_at } : null,
    sessions: { done: sessions.length, planned, adherence: adherence === null ? null : round(adherence, 2),
      avg_duration_min: round(avg(sessions.map((s) => s.duration_min).filter(Boolean)), 0),
      avg_session_fatigue: round(avg(sessionFatigue), 1) },
    exercises,
    sets_per_muscle_week,
    wellness: { reports: wellness.reports, avg_fatigue: round(wellness.fatigue), avg_sleep_hours: round(wellness.sleep),
      avg_stress: round(wellness.stress), avg_soreness: round(wellness.soreness), pain_reports: wellness.pain_reports,
      pains },
    body: { start_weight_kg: startW, end_weight_kg: endW,
      weight_change_kg: startW !== null && endW !== null ? round(endW - startW, 1) : null },
    nutrition_adherence: food.entries ? { ...food, followed_ratio: round(food.followed / food.entries, 2) } : null,
  };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Series históricas para gráficos de progreso. */
export async function progressSeries(athleteId) {
  const body = await many(
    `SELECT measured_on, weight_kg, body_fat_pct, waist_cm, hip_cm, chest_cm, arm_cm, thigh_cm
       FROM body_measurements WHERE athlete_id = $1 ORDER BY measured_on`, [athleteId]);
  const loads = await many(
    `SELECT sl.exercise_id, e.name, ws.performed_on,
            max(sl.load_kg)::float AS top_load, max(sl.load_kg * (1 + sl.reps / 30.0))::float AS e1rm
       FROM set_logs sl JOIN workout_sessions ws ON ws.id = sl.session_id JOIN exercises e ON e.id = sl.exercise_id
      WHERE ws.athlete_id = $1 AND sl.load_kg > 0 GROUP BY 1,2,3 ORDER BY 3`, [athleteId]);
  const exercises = {};
  for (const l of loads) {
    (exercises[l.exercise_id] ||= { exercise_id: l.exercise_id, name: l.name, points: [] })
      .points.push({ date: l.performed_on, top_load: l.top_load, e1rm: round(l.e1rm, 1) });
  }
  const weekly = await many(
    `SELECT to_char(date_trunc('week', performed_on), 'YYYY-MM-DD') AS week, count(*)::int AS sessions
       FROM workout_sessions WHERE athlete_id = $1 AND performed_on > current_date - 120 GROUP BY 1 ORDER BY 1`, [athleteId]);
  const plans = await many(
    `SELECT id, version, status, source, created_at, activated_at, change_summary FROM training_plans
      WHERE athlete_id = $1 ORDER BY version DESC`, [athleteId]);
  return { body, exercises: Object.values(exercises), weekly_sessions: weekly, plan_history: plans };
}
