// Indicadores del dashboard calculados desde la base de datos (sin IA).
// scope.coachId limita los datos a los deportistas asignados a un entrenador.
import { one, many } from '../db/pool.js';
import { getSettings, monthSpend } from '../ai/usage.js';

export async function dashboardMetrics(gymId, { coachId = null } = {}) {
  const settings = await getSettings(gymId);
  const params = coachId ? [gymId, coachId] : [gymId];
  const scope = coachId ? 'AND ap.coach_id = $2' : '';
  // CTE con los deportistas del alcance
  const athletesCte = `WITH ath AS (
      SELECT u.id, u.status, ap.coach_id FROM users u JOIN athlete_profiles ap ON ap.user_id = u.id
       WHERE u.gym_id = $1 AND u.role = 'athlete' AND u.status <> 'deleted' ${scope})`;

  const counts = await one(`${athletesCte}
    SELECT
      (SELECT count(*) FROM ath WHERE status = 'active')::int AS athletes_active,
      (SELECT count(*) FROM ath)::int AS athletes_registered,
      (SELECT count(*) FROM ath WHERE status = 'active' AND coach_id IS NULL)::int AS athletes_unassigned,
      (SELECT count(*) FROM training_plans t JOIN ath ON ath.id = t.athlete_id WHERE t.status = 'active')::int AS training_plans_active,
      (SELECT count(*) FROM nutrition_plans n JOIN ath ON ath.id = n.athlete_id WHERE n.status = 'active')::int AS nutrition_plans_active,
      (SELECT count(*) FROM training_plans t JOIN ath ON ath.id = t.athlete_id WHERE t.status = 'pending_review')::int
        + (SELECT count(*) FROM nutrition_plans n JOIN ath ON ath.id = n.athlete_id WHERE n.status = 'pending_review')::int AS plans_pending_review,
      (SELECT count(*) FROM ath WHERE status = 'active' AND NOT EXISTS (
          SELECT 1 FROM assessments a WHERE a.athlete_id = ath.id AND a.status IN ('submitted','reviewed')))::int AS assessments_pending,
      (SELECT count(*) FROM assessments a JOIN ath ON ath.id = a.athlete_id WHERE a.status = 'submitted')::int AS assessments_to_review,
      (SELECT count(DISTINCT ws.athlete_id) FROM workout_sessions ws JOIN ath ON ath.id = ws.athlete_id
        WHERE ws.performed_on > current_date - 7)::int AS athletes_training_last_7d`, params);

  const coaches = coachId ? null : (await one(
    `SELECT count(*)::int AS n FROM users WHERE gym_id = $1 AND role = 'coach' AND status = 'active'`, [gymId])).n;

  // Revisiones quincenales pendientes: plan activo con ≥ min_days desde su activación
  params.push(settings.min_days_between_adjustments);
  const reviewsDue = await many(`${athletesCte}
    SELECT t.athlete_id, u.full_name, t.activated_at,
           (current_date - t.activated_at::date) AS days_since
      FROM training_plans t JOIN ath ON ath.id = t.athlete_id JOIN users u ON u.id = t.athlete_id
     WHERE t.status = 'active' AND ath.status = 'active'
       AND t.activated_at < now() - ($${params.length} || ' days')::interval
       AND NOT EXISTS (SELECT 1 FROM training_plans p WHERE p.athlete_id = t.athlete_id AND p.status = 'pending_review')
     ORDER BY t.activated_at LIMIT 100`, params);
  params.pop();

  // Cumplimiento de entrenamiento (últimos 28 días) por deportista con plan activo
  const adherenceRows = await many(`${athletesCte}
    SELECT t.athlete_id, jsonb_array_length(t.content->'days') AS per_week,
           (SELECT count(*) FROM workout_sessions ws WHERE ws.athlete_id = t.athlete_id
              AND ws.performed_on > current_date - 28 AND ws.performed_on >= t.activated_at::date)::int AS done,
           LEAST(28, GREATEST(1, current_date - t.activated_at::date)) AS span
      FROM training_plans t JOIN ath ON ath.id = t.athlete_id WHERE t.status = 'active' AND ath.status = 'active'`, params);
  const adh = adherenceRows.map((r) => {
    const planned = Math.max(1, Math.round((r.per_week * r.span) / 7));
    return Math.min(1, r.done / planned);
  });
  const avgAdherence = adh.length ? adh.reduce((a, b) => a + b, 0) / adh.length : null;

  // Progreso general: deportistas cuyo mejor 1RM estimado de los últimos 14 días supera al de los 14 previos en algún ejercicio
  const progress = await one(`${athletesCte},
    best AS (
      SELECT ws.athlete_id, sl.exercise_id,
             max(sl.load_kg * (1 + sl.reps/30.0)) FILTER (WHERE ws.performed_on > current_date - 14) AS recent,
             max(sl.load_kg * (1 + sl.reps/30.0)) FILTER (WHERE ws.performed_on <= current_date - 14 AND ws.performed_on > current_date - 28) AS prev
        FROM set_logs sl JOIN workout_sessions ws ON ws.id = sl.session_id JOIN ath ON ath.id = ws.athlete_id
       WHERE ws.performed_on > current_date - 28 AND sl.load_kg > 0 GROUP BY 1,2)
    SELECT count(DISTINCT athlete_id) FILTER (WHERE recent IS NOT NULL AND prev IS NOT NULL)::int AS with_data,
           count(DISTINCT athlete_id) FILTER (WHERE recent > prev)::int AS improving
      FROM best`, params);

  const wellnessAlerts = await many(`${athletesCte}
    SELECT w.athlete_id, u.full_name, count(*) FILTER (WHERE w.pain)::int AS pain_reports,
           round(avg(w.fatigue)::numeric, 1)::float AS avg_fatigue
      FROM wellness_reports w JOIN ath ON ath.id = w.athlete_id JOIN users u ON u.id = w.athlete_id
     WHERE w.reported_on > current_date - 7 GROUP BY 1,2
    HAVING count(*) FILTER (WHERE w.pain) > 0 OR avg(w.fatigue) >= 8 ORDER BY pain_reports DESC LIMIT 50`, params);

  const inactive = await many(`${athletesCte}
    SELECT t.athlete_id, u.full_name,
           (SELECT max(performed_on) FROM workout_sessions ws WHERE ws.athlete_id = t.athlete_id) AS last_session
      FROM training_plans t JOIN ath ON ath.id = t.athlete_id JOIN users u ON u.id = t.athlete_id
     WHERE t.status = 'active' AND ath.status = 'active' AND t.activated_at < now() - interval '10 days'
       AND NOT EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.athlete_id = t.athlete_id AND ws.performed_on > current_date - 10)
     LIMIT 50`, params);

  const gym = await one('SELECT capacity FROM gyms WHERE id = $1', [gymId]);
  const ai = await monthSpend(gymId);
  const budget = Number(settings.ai_monthly_budget_usd);

  const alerts = [];
  for (const w of wellnessAlerts) {
    alerts.push({ level: w.pain_reports ? 'high' : 'medium', type: w.pain_reports ? 'pain' : 'fatigue', athlete_id: w.athlete_id,
      message: w.pain_reports ? `${w.full_name}: ${w.pain_reports} reporte(s) de molestias esta semana`
        : `${w.full_name}: fatiga media alta (${w.avg_fatigue}/10)` });
  }
  for (const i of inactive) {
    alerts.push({ level: 'medium', type: 'inactivity', athlete_id: i.athlete_id,
      message: `${i.full_name}: sin sesiones registradas en 10 días${i.last_session ? ` (última: ${i.last_session})` : ''}` });
  }
  if (!coachId) {
    if (counts.athletes_unassigned) alerts.push({ level: 'medium', type: 'unassigned', message: `${counts.athletes_unassigned} deportista(s) sin entrenador asignado` });
    if (counts.athletes_active / gym.capacity >= 0.9) alerts.push({ level: 'medium', type: 'capacity', message: `Capacidad al ${Math.round((counts.athletes_active / gym.capacity) * 100)}% (${counts.athletes_active}/${gym.capacity})` });
    if (budget && ai.spent / budget >= Number(settings.ai_alert_threshold)) alerts.push({ level: 'high', type: 'ai_budget', message: `Consumo de IA al ${Math.round((ai.spent / budget) * 100)}% del presupuesto mensual` });
  }

  return {
    ...counts,
    coaches_active: coaches,
    capacity: gym.capacity,
    biweekly_reviews_due: reviewsDue.length,
    biweekly_reviews_due_list: reviewsDue,
    training_adherence_28d: avgAdherence === null ? null : Math.round(avgAdherence * 100) / 100,
    progress: { athletes_with_data: progress.with_data, athletes_improving: progress.improving },
    ai: coachId ? null : { month_cost_usd: Math.round(ai.spent * 10000) / 10000, budget_usd: budget, calls: ai.calls },
    alerts,
  };
}
