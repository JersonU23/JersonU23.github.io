import { Router } from 'express';
import { one, tx } from '../db/pool.js';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { parse, z, optText } from '../lib/validate.js';
import { notFound, conflict, unprocessable, forbidden } from '../lib/errors.js';
import { assertAthleteAccess, requireRole } from '../middleware/auth.js';
import { SECTION_SCHEMAS, STEPS, evaluateAssessment } from '../services/assessmentRules.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notifications.js';

const r = Router();

export function hydrate(row) {
  if (!row) return null;
  const { health_enc, ...rest } = row;
  return { ...rest, data: { ...row.data, health: decryptJson(health_enc) || {} } };
}

export async function latestAssessment(athleteId, { submittedOnly = false } = {}) {
  const row = await one(
    `SELECT * FROM assessments WHERE athlete_id = $1 ${submittedOnly ? `AND status IN ('submitted','reviewed')` : ''}
      ORDER BY created_at DESC LIMIT 1`, [athleteId]);
  return hydrate(row);
}

// Evaluación vigente (borrador o enviada) del deportista
r.get('/athlete/:athleteId/current', async (req, res) => {
  await assertAthleteAccess(req.user, req.params.athleteId);
  const a = await latestAssessment(req.params.athleteId);
  if (!a) return res.json({ assessment: null, steps: STEPS });
  const evaluation = evaluateAssessment(a.data);
  res.json({ assessment: a, steps: STEPS, evaluation });
});

// Guarda una sección (autoguardado progresivo). Crea el borrador si no existe.
r.put('/athlete/:athleteId/section/:section', async (req, res) => {
  const { athleteId, section } = req.params;
  const athlete = await assertAthleteAccess(req.user, athleteId);
  const schema = SECTION_SCHEMAS[section];
  if (!schema) throw notFound('Sección desconocida');
  const values = parse(schema, req.body);

  const saved = await tx(async (db) => {
    let { rows: [row] } = await db.query(
      `SELECT * FROM assessments WHERE athlete_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [athleteId]);
    if (row && row.status !== 'draft') {
      // Una evaluación enviada solo la modifica el personal (y queda auditado)
      if (req.user.role === 'athlete') throw conflict('La evaluación ya fue enviada. Pide a tu entrenador que la reabra.', 'assessment_locked');
    }
    if (!row) {
      ({ rows: [row] } = await db.query(
        `INSERT INTO assessments (gym_id, athlete_id, kind) VALUES ($1,$2,'initial') RETURNING *`, [athlete.gym_id, athleteId]));
    }
    const current = hydrate(row).data;
    const merged = { ...current, [section]: { ...(current[section] || {}), ...values } };
    const { health, ...nonSensitive } = merged;
    const evaluation = evaluateAssessment(merged);
    const { rows: [upd] } = await db.query(
      `UPDATE assessments SET data = $2, health_enc = $3, current_step = $4, missing_critical = $5,
              risk_flags = $6, updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, nonSensitive, encryptJson(health || {}), section, JSON.stringify(evaluation.missing), JSON.stringify(evaluation.flags)]);
    if (row.status !== 'draft') await audit(req, 'assessment.edited_after_submit', 'assessment', row.id, { section }, db);
    return { assessment: hydrate(upd), evaluation };
  });
  res.json(saved);
});

// Envía la evaluación. Si faltan datos críticos, no se envía y se devuelve la lista.
r.post('/athlete/:athleteId/submit', async (req, res) => {
  const athlete = await assertAthleteAccess(req.user, req.params.athleteId);
  const a = await latestAssessment(req.params.athleteId);
  if (!a) throw notFound('No hay evaluación para enviar');
  if (a.status !== 'draft') throw conflict('La evaluación ya fue enviada', 'already_submitted');
  const evaluation = evaluateAssessment(a.data);
  if (evaluation.missing.length) {
    throw unprocessable('Faltan datos críticos para una planificación segura', 'missing_critical', evaluation.missing);
  }
  await tx(async (db) => {
    await db.query(`UPDATE assessments SET status = 'submitted', submitted_at = now(), missing_critical = '[]',
                    risk_flags = $2, updated_at = now() WHERE id = $1`, [a.id, JSON.stringify(evaluation.flags)]);
    await audit(req, 'assessment.submitted', 'assessment', a.id, { flags: evaluation.flags.map((f) => f.type) }, db);
    if (athlete.coach_id) {
      await notify(db, { gymId: athlete.gym_id, userId: athlete.coach_id, kind: 'assessment_submitted',
        title: `${athlete.full_name} completó su evaluación`, link: `#/athlete/${athlete.id}` });
    }
  });
  res.json({ ok: true, evaluation });
  // Modo automático (si está habilitado): genera la propuesta inicial en segundo plano.
  setImmediate(async () => {
    try {
      const [{ generateInitial }, { maybeAutoGenerate }] = await Promise.all([import('../ai/engine.js'), import('../services/automation.js')]);
      await maybeAutoGenerate(athlete.gym_id, athlete.id, generateInitial);
    } catch (err) {
      console.error('Automatización de generación inicial:', err.message);
    }
  });
});

// Revisión por el personal
r.post('/athlete/:athleteId/review', requireRole('admin', 'coach'), async (req, res) => {
  const body = parse(z.object({ notes: optText(2000) }), req.body);
  await assertAthleteAccess(req.user, req.params.athleteId);
  const a = await latestAssessment(req.params.athleteId);
  if (!a || a.status === 'draft') throw conflict('La evaluación aún no fue enviada', 'not_submitted');
  await tx(async (db) => {
    await db.query(`UPDATE assessments SET status = 'reviewed', reviewed_by = $2, reviewed_at = now(), review_notes = $3 WHERE id = $1`,
      [a.id, req.user.id, body.notes || null]);
    await audit(req, 'assessment.reviewed', 'assessment', a.id, null, db);
  });
  res.json({ ok: true });
});

// Reabrir para corrección (personal) o iniciar una evaluación de seguimiento copiando los datos previos.
r.post('/athlete/:athleteId/reopen', requireRole('admin', 'coach'), async (req, res) => {
  const body = parse(z.object({ mode: z.enum(['reopen', 'followup']) }), req.body);
  const athlete = await assertAthleteAccess(req.user, req.params.athleteId);
  const a = await latestAssessment(req.params.athleteId);
  if (!a) throw notFound('No hay evaluación');
  if (a.status === 'draft') throw conflict('La evaluación ya está en borrador');
  if (req.user.role === 'athlete') throw forbidden();
  await tx(async (db) => {
    if (body.mode === 'reopen') {
      await db.query(`UPDATE assessments SET status = 'draft', updated_at = now() WHERE id = $1`, [a.id]);
    } else {
      const { health, ...rest } = a.data;
      await db.query(`INSERT INTO assessments (gym_id, athlete_id, kind, data, health_enc) VALUES ($1,$2,'followup',$3,$4)`,
        [athlete.gym_id, athlete.id, rest, encryptJson(health)]);
    }
    await audit(req, `assessment.${body.mode}`, 'assessment', a.id, null, db);
  });
  res.json({ ok: true });
});

export default r;
