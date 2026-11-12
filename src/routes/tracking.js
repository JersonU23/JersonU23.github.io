// Registro diario del deportista y métricas de progreso. Ninguna ruta aquí utiliza IA.
import { Router } from 'express';
import { one, many, tx, query } from '../db/pool.js';
import { parse, z, isoDate, optText, shortText, pagination } from '../lib/validate.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { assertAthleteAccess, assertStaffAccess, requireRole } from '../middleware/auth.js';
import { periodSummary, progressSeries } from '../services/progress.js';
import { notify } from '../services/notifications.js';
import { audit } from '../services/audit.js';

const r = Router();
const today = () => new Date().toISOString().slice(0, 10);
const notFuture = (d) => d <= today();
const dateField = isoDate.refine(notFuture, 'La fecha no puede ser futura').optional();

// ---------- Sesiones de entrenamiento ----------
const sessionSchema = z.object({
  day_key: z.string().trim().max(20).optional().nullable(),
  performed_on: dateField,
  duration_min: z.number().int().min(0).max(600).optional().nullable(),
  fatigue: z.number().int().min(1).max(10).optional().nullable(),
  notes: optText(1000),
  sets: z.array(z.object({
    exercise_id: z.uuid(),
    set_number: z.number().int().min(1).max(50),
    reps: z.number().int().min(0).max(200),
    load_kg: z.number().min(0).max(1000).optional().nullable(),
    rir: z.number().min(0).max(10).optional().nullable(),
    rpe: z.number().min(1).max(10).optional().nullable(),
  })).max(200).default([]),
});

r.post('/athlete/:athleteId/sessions', async (req, res) => {
  const athlete = await assertAthleteAccess(req.user, req.params.athleteId);
  const body = parse(sessionSchema, req.body);
  const exIds = [...new Set(body.sets.map((s) => s.exercise_id))];
  if (exIds.length) {
    const { n } = await one(`SELECT count(*)::int AS n FROM exercises WHERE gym_id = $1 AND id = ANY($2::uuid[])`, [athlete.gym_id, exIds]);
    if (n !== exIds.length) throw badRequest('Algún ejercicio no existe en la biblioteca');
  }
  const plan = await one(`SELECT id FROM training_plans WHERE athlete_id = $1 AND status = 'active'`, [athlete.id]);
  const session = await tx(async (db) => {
    const { rows: [s] } = await db.query(
      `INSERT INTO workout_sessions (gym_id, athlete_id, plan_id, day_key, performed_on, duration_min, fatigue, notes)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, current_date),$6,$7,$8) RETURNING *`,
      [athlete.gym_id, athlete.id, plan?.id || null, body.day_key || null, body.performed_on || null,
        body.duration_min ?? null, body.fatigue ?? null, body.notes || null]);
    for (const st of body.sets) {
      await db.query(`INSERT INTO set_logs (session_id, exercise_id, set_number, reps, load_kg, rir, rpe) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [s.id, st.exercise_id, st.set_number, st.reps, st.load_kg ?? null, st.rir ?? null, st.rpe ?? null]);
    }
    return s;
  });
  res.status(201).json({ session });
});

r.get('/athlete/:athleteId/sessions', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  const q = parse(pagination, req.query);
  const sessions = await many(
    `SELECT ws.*, COALESCE(json_agg(json_build_object('id', sl.id, 'exercise_id', sl.exercise_id, 'name', e.name,
              'set_number', sl.set_number, 'reps', sl.reps, 'load_kg', sl.load_kg, 'rir', sl.rir, 'rpe', sl.rpe)
              ORDER BY e.name, sl.set_number) FILTER (WHERE sl.id IS NOT NULL), '[]') AS sets
       FROM workout_sessions ws LEFT JOIN set_logs sl ON sl.session_id = ws.id LEFT JOIN exercises e ON e.id = sl.exercise_id
      WHERE ws.athlete_id = $1 GROUP BY ws.id ORDER BY ws.performed_on DESC, ws.created_at DESC LIMIT $2 OFFSET $3`,
    [req.params.athleteId, q.limit, q.offset]);
  res.json({ sessions });
});

r.delete('/sessions/:id', async (req, res) => {
  const s = await one('SELECT * FROM workout_sessions WHERE id = $1 AND gym_id = $2', [req.params.id, req.user.gym_id]);
  if (!s) throw notFound('Sesión no encontrada');
  await assertAthleteAccess(req.user, s.athlete_id);
  if (req.user.role === 'athlete' && Date.now() - new Date(s.created_at).getTime() > 7 * 86400000) {
    throw forbidden('Solo puedes eliminar sesiones registradas en los últimos 7 días');
  }
  await query('DELETE FROM workout_sessions WHERE id = $1', [s.id]);
  await audit(req, 'tracking.session_deleted', 'workout_session', s.id, { athlete_id: s.athlete_id });
  res.json({ ok: true });
});

// ---------- Medidas corporales ----------
const measurementSchema = z.object({
  measured_on: dateField,
  weight_kg: z.number().min(20).max(400).optional().nullable(),
  body_fat_pct: z.number().min(2).max(75).optional().nullable(),
  waist_cm: z.number().min(30).max(250).optional().nullable(),
  hip_cm: z.number().min(30).max(250).optional().nullable(),
  chest_cm: z.number().min(30).max(250).optional().nullable(),
  arm_cm: z.number().min(10).max(80).optional().nullable(),
  thigh_cm: z.number().min(20).max(120).optional().nullable(),
  notes: optText(500),
}).refine((m) => ['weight_kg', 'body_fat_pct', 'waist_cm', 'hip_cm', 'chest_cm', 'arm_cm', 'thigh_cm'].some((k) => m[k] != null),
  'Registra al menos una medida');

r.post('/athlete/:athleteId/measurements', async (req, res) => {
  const athlete = await assertAthleteAccess(req.user, req.params.athleteId);
  const m = parse(measurementSchema, req.body);
  const { rows: [row] } = await query(
    `INSERT INTO body_measurements (gym_id, athlete_id, measured_on, weight_kg, body_fat_pct, waist_cm, hip_cm, chest_cm, arm_cm, thigh_cm, notes, created_by)
     VALUES ($1,$2,COALESCE($3::date,current_date),$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [athlete.gym_id, athlete.id, m.measured_on || null, m.weight_kg ?? null, m.body_fat_pct ?? null, m.waist_cm ?? null,
      m.hip_cm ?? null, m.chest_cm ?? null, m.arm_cm ?? null, m.thigh_cm ?? null, m.notes || null, req.user.id]);
  res.status(201).json({ measurement: row });
});

r.get('/athlete/:athleteId/measurements', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  res.json({ measurements: await many(`SELECT * FROM body_measurements WHERE athlete_id = $1 ORDER BY measured_on DESC LIMIT 200`, [req.params.athleteId]) });
});

// ---------- Alimentación ----------
const foodSchema = z.object({
  logged_on: dateField,
  meal: shortText(60),
  description: optText(1000),
  kcal: z.number().int().min(0).max(10000).optional().nullable(),
  protein_g: z.number().min(0).max(500).optional().nullable(),
  carbs_g: z.number().min(0).max(1000).optional().nullable(),
  fat_g: z.number().min(0).max(500).optional().nullable(),
  adherence: z.enum(['followed', 'partial', 'skipped']).optional().nullable(),
});

r.post('/athlete/:athleteId/food', async (req, res) => {
  const athlete = await assertAthleteAccess(req.user, req.params.athleteId);
  const f = parse(foodSchema, req.body);
  const { rows: [row] } = await query(
    `INSERT INTO food_logs (gym_id, athlete_id, logged_on, meal, description, kcal, protein_g, carbs_g, fat_g, adherence)
     VALUES ($1,$2,COALESCE($3::date,current_date),$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [athlete.gym_id, athlete.id, f.logged_on || null, f.meal, f.description || null, f.kcal ?? null, f.protein_g ?? null,
      f.carbs_g ?? null, f.fat_g ?? null, f.adherence || null]);
  res.status(201).json({ food: row });
});

r.get('/athlete/:athleteId/food', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  const rows = await many(`SELECT * FROM food_logs WHERE athlete_id = $1 ORDER BY logged_on DESC, created_at DESC LIMIT 200`, [req.params.athleteId]);
  const daily = await many(
    `SELECT logged_on, sum(kcal)::int AS kcal, sum(protein_g)::float AS protein_g, sum(carbs_g)::float AS carbs_g, sum(fat_g)::float AS fat_g
       FROM food_logs WHERE athlete_id = $1 AND logged_on > current_date - 30 GROUP BY 1 ORDER BY 1`, [req.params.athleteId]);
  res.json({ food: rows, daily });
});

// ---------- Bienestar: fatiga, sueño, estrés, molestias ----------
const wellnessSchema = z.object({
  reported_on: dateField,
  fatigue: z.number().int().min(1).max(10).optional().nullable(),
  sleep_hours: z.number().min(0).max(24).optional().nullable(),
  stress: z.number().int().min(1).max(10).optional().nullable(),
  soreness: z.number().int().min(1).max(10).optional().nullable(),
  pain: z.boolean().default(false),
  pain_location: optText(200),
  pain_intensity: z.number().int().min(0).max(10).optional().nullable(),
  notes: optText(1000),
}).refine((w) => !w.pain || w.pain_location, { message: 'Indica dónde sientes la molestia', path: ['pain_location'] });

r.post('/athlete/:athleteId/wellness', async (req, res) => {
  const athlete = await assertAthleteAccess(req.user, req.params.athleteId);
  const w = parse(wellnessSchema, req.body);
  const row = await tx(async (db) => {
    const { rows: [x] } = await db.query(
      `INSERT INTO wellness_reports (gym_id, athlete_id, reported_on, fatigue, sleep_hours, stress, soreness, pain, pain_location, pain_intensity, notes)
       VALUES ($1,$2,COALESCE($3::date,current_date),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [athlete.gym_id, athlete.id, w.reported_on || null, w.fatigue ?? null, w.sleep_hours ?? null, w.stress ?? null,
        w.soreness ?? null, w.pain, w.pain_location || null, w.pain_intensity ?? null, w.notes || null]);
    // Alerta inmediata al entrenador ante dolor moderado/alto (regla convencional, sin IA)
    if (w.pain && (w.pain_intensity ?? 0) >= 6 && athlete.coach_id) {
      await notify(db, { gymId: athlete.gym_id, userId: athlete.coach_id, kind: 'pain_alert',
        title: `${athlete.full_name} reportó dolor ${w.pain_intensity}/10`, body: w.pain_location, link: `#/athlete/${athlete.id}` });
    }
    return x;
  });
  res.status(201).json({ wellness: row });
});

r.get('/athlete/:athleteId/wellness', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  res.json({ wellness: await many(`SELECT * FROM wellness_reports WHERE athlete_id = $1 ORDER BY reported_on DESC, created_at DESC LIMIT 200`, [req.params.athleteId]) });
});

// ---------- Observaciones del entrenador ----------
r.post('/athlete/:athleteId/notes', requireRole('admin', 'coach'), async (req, res) => {
  const athlete = await assertStaffAccess(req.user, req.params.athleteId);
  const body = parse(z.object({ body: shortText(3000) }), req.body);
  const { rows: [n] } = await query(`INSERT INTO coach_notes (gym_id, athlete_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING *`,
    [athlete.gym_id, athlete.id, req.user.id, body.body]);
  res.status(201).json({ note: n });
});

r.get('/athlete/:athleteId/notes', requireRole('admin', 'coach'), async (req, res) => {
  await assertStaffAccess(req.user, req.params.athleteId);
  res.json({ notes: await many(`SELECT n.*, u.full_name AS author_name FROM coach_notes n JOIN users u ON u.id = n.author_id
                                 WHERE n.athlete_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [req.params.athleteId]) });
});

// ---------- Progreso ----------
r.get('/athlete/:athleteId/progress', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  const q = parse(z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }), req.query);
  const [summary, series] = await Promise.all([periodSummary(req.params.athleteId, { days: q.days }), progressSeries(req.params.athleteId)]);
  const goals = await one(`SELECT data->'goals' AS goals FROM assessments WHERE athlete_id = $1 AND status IN ('submitted','reviewed')
                           ORDER BY created_at DESC LIMIT 1`, [req.params.athleteId]);
  res.json({ summary, series, goals: goals?.goals || null });
});

export default r;
