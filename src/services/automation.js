// Automatizaciones sin IA (recordatorios) y modo automático de IA dentro de límites autorizados.
import { many, one } from '../db/pool.js';
import { notify } from './notifications.js';
import { getSettings } from '../ai/usage.js';

// Recordatorios periódicos (código convencional). Idempotentes gracias a dedupe_key.
export async function runReminders() {
  const gyms = await many(`SELECT id FROM gyms WHERE status = 'active'`);
  let sent = 0;
  for (const { id: gymId } of gyms) {
    const s = await getSettings(gymId);
    // Entrenador: revisión quincenal disponible
    const due = await many(
      `SELECT t.id, t.athlete_id, u.full_name, ap.coach_id FROM training_plans t JOIN users u ON u.id = t.athlete_id
         JOIN athlete_profiles ap ON ap.user_id = t.athlete_id
        WHERE t.gym_id = $1 AND t.status = 'active' AND u.status = 'active' AND ap.coach_id IS NOT NULL
          AND t.activated_at < now() - ($2 || ' days')::interval`, [gymId, String(s.min_days_between_adjustments)]);
    for (const d of due) {
      await notify(null, { gymId, userId: d.coach_id, kind: 'review_due', title: `Revisión quincenal disponible: ${d.full_name}`,
        link: `#/athlete/${d.athlete_id}`, dedupeKey: `review_due_${d.id}` });
      sent++;
    }
    // Deportista: sin registrar entrenamientos en 5 días teniendo plan activo
    const idle = await many(
      `SELECT t.athlete_id FROM training_plans t JOIN users u ON u.id = t.athlete_id
        WHERE t.gym_id = $1 AND t.status = 'active' AND u.status = 'active' AND t.activated_at < now() - interval '5 days'
          AND NOT EXISTS (SELECT 1 FROM workout_sessions ws WHERE ws.athlete_id = t.athlete_id AND ws.performed_on > current_date - 5)`, [gymId]);
    const week = new Date().toISOString().slice(0, 10).slice(0, 8) + String(Math.ceil(new Date().getUTCDate() / 7));
    for (const i of idle) {
      await notify(null, { gymId, userId: i.athlete_id, kind: 'reminder', title: 'Te esperamos en tu próxima sesión',
        body: 'Llevas varios días sin registrar entrenamientos. Recuerda anotar tus series y cargas.', link: '#/today',
        dedupeKey: `idle_${week}` });
      sent++;
    }
  }
  return sent;
}

// Modo automático: al enviar la evaluación se genera la propuesta inicial (siempre requiere aprobación del entrenador).
export async function maybeAutoGenerate(gymId, athleteId, generateInitial) {
  const s = await getSettings(gymId);
  if (s.config_level !== 'automatic' || !s.advanced?.auto_initial_generation) return { skipped: 'not_enabled' };
  const limit = Number(s.advanced.auto_max_cost_per_request_usd ?? 0);
  const avg = await one(`SELECT COALESCE(avg(cost_usd),0)::float AS c FROM ai_requests WHERE gym_id = $1
                          AND operation = 'initial_generation' AND status = 'succeeded'`, [gymId]);
  if (limit && avg.c > limit) return { skipped: 'cost_limit' };
  const systemActor = { user: { id: null, gym_id: gymId, role: 'admin', full_name: 'Automatización' }, ip: null };
  try {
    return await generateInitial(systemActor, athleteId, { includeNutrition: true });
  } catch (err) {
    return { skipped: 'error', error: err.message };
  }
}
