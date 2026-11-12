import { Router } from 'express';
import { one, many, tx } from '../db/pool.js';
import { parse, z, optText } from '../lib/validate.js';
import { notFound, conflict, badRequest } from '../lib/errors.js';
import { assertAthleteAccess, assertStaffAccess, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import { WEEKDAYS } from '../services/assessmentRules.js';

const r = Router();
const TABLE = { training: 'training_plans', nutrition: 'nutrition_plans' };
const kindParam = (k) => { if (!TABLE[k]) throw notFound(); return TABLE[k]; };

// Esquemas para planes creados o editados manualmente por el entrenador
const manualDay = z.object({
  key: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  focus: z.string().max(300).default(''),
  suggested_weekday: z.enum([...WEEKDAYS, 'any']).default('any'),
  warmup: z.string().max(1500).default(''),
  exercises: z.array(z.object({
    exercise_id: z.uuid(),
    sets: z.number().int().min(1).max(10),
    reps: z.string().trim().min(1).max(40),
    intensity: z.string().max(120).default(''),
    rir_or_rpe: z.string().max(60).default(''),
    rest_seconds: z.number().int().min(0).max(600).default(90),
    notes: z.string().max(600).default(''),
  })).min(1).max(15),
  cooldown: z.string().max(1500).default(''),
});
const trainingContent = z.object({
  summary: z.string().max(2000).default(''),
  rationale: z.string().max(6000).default(''),
  weekly_structure: z.string().max(2000).default(''),
  duration_weeks: z.number().int().min(1).max(16).default(4),
  warmup_protocol: z.string().max(2000).default(''),
  mobility: z.string().max(2000).default(''),
  progression: z.string().max(3000).default(''),
  recovery: z.string().max(2000).default(''),
  days: z.array(manualDay).min(1).max(7),
  safety_notes: z.array(z.string().max(600)).max(20).default([]),
}).passthrough();
const nutritionContent = z.object({
  energy_kcal: z.number().int().min(1000).max(6000),
  macros: z.object({ protein_g: z.number().int().min(0), carbs_g: z.number().int().min(0), fat_g: z.number().int().min(0) }).passthrough(),
  hydration_liters: z.number().min(0.5).max(8),
  meals: z.array(z.object({ name: z.string().max(80), timing: z.string().max(120).default(''),
    options: z.array(z.object({ description: z.string().max(600), portion_guide: z.string().max(400).default('') })).min(1) })).min(1).max(8),
}).passthrough();

async function assertExercisesInLibrary(gymId, content) {
  const ids = [...new Set(content.days.flatMap((d) => d.exercises.map((e) => e.exercise_id)))];
  const { n } = await one(`SELECT count(*)::int AS n FROM exercises WHERE gym_id = $1 AND status = 'active' AND id = ANY($2::uuid[])`, [gymId, ids]);
  if (n !== ids.length) throw badRequest('El plan contiene ejercicios que no están activos en la biblioteca');
}

// Enriquecer días con detalles del ejercicio (para mostrar técnica, respiración, errores, etc.)
async function withExerciseDetails(plan) {
  if (!plan?.content?.days) return plan;
  const ids = [...new Set(plan.content.days.flatMap((d) => d.exercises.map((e) => e.exercise_id)))];
  const rows = ids.length ? await many(`SELECT * FROM exercises WHERE id = ANY($1::uuid[])`, [ids]) : [];
  const map = Object.fromEntries(rows.map((x) => [x.id, x]));
  return { ...plan, exercises: map };
}

// Planes vigentes del deportista (lo que ve el deportista)
r.get('/athlete/:athleteId/current', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  const training = await one(`SELECT * FROM training_plans WHERE athlete_id = $1 AND status = 'active'`, [req.params.athleteId]);
  const nutrition = await one(`SELECT * FROM nutrition_plans WHERE athlete_id = $1 AND status = 'active'`, [req.params.athleteId]);
  res.json({ training: await withExerciseDetails(training), nutrition });
});

// Historial completo (personal: todos los estados; deportista: activos y archivados)
r.get('/athlete/:athleteId/history', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  const filter = req.user.role === 'athlete' ? `AND status IN ('active','archived')` : '';
  const cols = 'id, version, status, source, rationale, created_at, reviewed_at, review_notes, activated_at';
  const training = await many(`SELECT ${cols}, change_summary FROM training_plans WHERE athlete_id = $1 ${filter} ORDER BY version DESC`, [req.params.athleteId]);
  const nutrition = await many(`SELECT ${cols}, update_reason FROM nutrition_plans WHERE athlete_id = $1 ${filter} ORDER BY version DESC`, [req.params.athleteId]);
  res.json({ training, nutrition });
});

// Planes pendientes de revisión (bandeja del entrenador / admin)
r.get('/pending', requireRole('admin', 'coach'), async (req, res) => {
  const params = [req.user.gym_id];
  const scope = req.user.role === 'coach' ? (params.push(req.user.id), 'AND ap.coach_id = $2') : '';
  const sql = (t, kind) => `SELECT p.id, '${kind}' AS kind, p.athlete_id, u.full_name, p.version, p.source, p.created_at
      FROM ${t} p JOIN users u ON u.id = p.athlete_id JOIN athlete_profiles ap ON ap.user_id = p.athlete_id
     WHERE p.gym_id = $1 AND p.status = 'pending_review' ${scope}`;
  const rows = await many(`${sql('training_plans', 'training')} UNION ALL ${sql('nutrition_plans', 'nutrition')} ORDER BY created_at`, params);
  res.json({ pending: rows });
});

r.get('/:kind/:id', async (req, res) => {
  const table = kindParam(req.params.kind);
  const plan = await one(`SELECT * FROM ${table} WHERE id = $1 AND gym_id = $2`, [req.params.id, req.user.gym_id]);
  if (!plan) throw notFound('Plan no encontrado');
  await assertAthleteAccess(req.user, plan.athlete_id);
  if (req.user.role === 'athlete' && !['active', 'archived'].includes(plan.status)) throw notFound('Plan no encontrado');
  const citations = plan.ai_request_id ? await many(
    `SELECT c.entry_id, c.entry_version, c.usage_note, k.title, k.kind, k.evidence_level, k.classification
       FROM ai_citations c JOIN knowledge_entries k ON k.id = c.entry_id WHERE c.ai_request_id = $1`, [plan.ai_request_id]) : [];
  const parent = plan.parent_plan_id ? await one(`SELECT id, version, content FROM ${table} WHERE id = $1`, [plan.parent_plan_id]) : null;
  res.json({ plan: await withExerciseDetails(plan), citations, parent });
});

// Revisión del entrenador: aprobar (opcionalmente con modificaciones) o rechazar
r.post('/:kind/:id/review', requireRole('admin', 'coach'), async (req, res) => {
  const table = kindParam(req.params.kind);
  const body = parse(z.object({
    decision: z.enum(['approve', 'reject']),
    notes: optText(2000),
    content: z.record(z.string(), z.any()).optional(),
  }), req.body);
  const plan = await one(`SELECT * FROM ${table} WHERE id = $1 AND gym_id = $2`, [req.params.id, req.user.gym_id]);
  if (!plan) throw notFound('Plan no encontrado');
  const athlete = await assertStaffAccess(req.user, plan.athlete_id);
  if (plan.status !== 'pending_review') throw conflict('El plan no está pendiente de revisión', 'not_pending');
  if (body.decision === 'reject' && !body.notes) throw badRequest('Indica el motivo del rechazo (sirve para mejorar la siguiente propuesta)');

  let content = null;
  if (body.decision === 'approve' && body.content) {
    content = req.params.kind === 'training' ? parse(trainingContent, body.content) : parse(nutritionContent, body.content);
    if (req.params.kind === 'training') await assertExercisesInLibrary(req.user.gym_id, content);
  }
  await tx(async (db) => {
    if (body.decision === 'approve') {
      await db.query(`UPDATE ${table} SET status = 'archived' WHERE athlete_id = $1 AND status = 'active'`, [plan.athlete_id]);
      await db.query(
        `UPDATE ${table} SET status = 'active', activated_at = now(), reviewed_by = $2, reviewed_at = now(), review_notes = $3,
                content = COALESCE($4, content) WHERE id = $1`,
        [plan.id, req.user.id, body.notes || null, content ? JSON.stringify({ ...plan.content, ...content, modified_by_coach: true }) : null]);
      await notify(db, { gymId: plan.gym_id, userId: plan.athlete_id, kind: 'plan_activated',
        title: req.params.kind === 'training' ? 'Tu plan de entrenamiento fue actualizado' : 'Tu plan nutricional fue actualizado',
        link: req.params.kind === 'training' ? '#/today' : '#/nutrition' });
    } else {
      await db.query(`UPDATE ${table} SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_notes = $3 WHERE id = $1`,
        [plan.id, req.user.id, body.notes]);
    }
    await audit(req, `plan.${req.params.kind}.${body.decision}${content ? '_modified' : ''}`, table, plan.id,
      { athlete_id: athlete.id, version: plan.version }, db);
  });
  res.json({ ok: true });
});

// Plan creado manualmente por el entrenador (sin IA): queda activo de inmediato.
r.post('/:kind/athlete/:athleteId/manual', requireRole('admin', 'coach'), async (req, res) => {
  const table = kindParam(req.params.kind);
  const athlete = await assertStaffAccess(req.user, req.params.athleteId);
  const content = req.params.kind === 'training' ? parse(trainingContent, req.body.content) : parse(nutritionContent, req.body.content);
  if (req.params.kind === 'training') await assertExercisesInLibrary(req.user.gym_id, content);
  const created = await tx(async (db) => {
    const { rows: [{ v }] } = await db.query(`SELECT COALESCE(max(version),0)+1 AS v FROM ${table} WHERE athlete_id = $1`, [athlete.id]);
    const active = await db.query(`SELECT id FROM ${table} WHERE athlete_id = $1 AND status = 'active'`, [athlete.id]);
    await db.query(`UPDATE ${table} SET status = 'archived' WHERE athlete_id = $1 AND status = 'active'`, [athlete.id]);
    const { rows: [p] } = await db.query(
      `INSERT INTO ${table} (gym_id, athlete_id, version, status, source, content, rationale, parent_plan_id, created_by, reviewed_by, reviewed_at, activated_at)
       VALUES ($1,$2,$3,'active','manual',$4,$5,$6,$7,$7,now(),now()) RETURNING id, version, status`,
      [athlete.gym_id, athlete.id, v, JSON.stringify(content), content.rationale || null, active.rows[0]?.id || null, req.user.id]);
    await audit(req, `plan.${req.params.kind}.manual_created`, table, p.id, { athlete_id: athlete.id }, db);
    await notify(db, { gymId: athlete.gym_id, userId: athlete.id, kind: 'plan_activated', title: 'Tienes un plan actualizado',
      link: req.params.kind === 'training' ? '#/today' : '#/nutrition' });
    return p;
  });
  res.status(201).json({ plan: created });
});

export default r;
