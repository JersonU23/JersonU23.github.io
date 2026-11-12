// Exportación y eliminación de información personal.
import { Router } from 'express';
import { many, tx } from '../db/pool.js';
import { decryptJson, hashPassword, randomToken } from '../lib/crypto.js';
import { parse, z } from '../lib/validate.js';
import { forbidden, badRequest } from '../lib/errors.js';
import { assertAthleteAccess, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';

const r = Router();

// Exporta todos los datos del deportista (el propio deportista o un administrador)
r.get('/athlete/:athleteId/export', async (req, res) => {
  const a = await assertAthleteAccess(req.user, req.params.athleteId);
  if (req.user.role === 'coach') throw forbidden('La exportación completa la solicita el deportista o el administrador');
  const id = a.id;
  const q = (sql) => many(sql, [id]);
  const assessments = (await q('SELECT * FROM assessments WHERE athlete_id = $1 ORDER BY created_at')).map(({ health_enc, ...x }) => ({ ...x, health: decryptJson(health_enc) }));
  const data = {
    exported_at: new Date().toISOString(),
    profile: { id: a.id, full_name: a.full_name, email: a.email, joined_at: a.joined_at },
    assessments,
    training_plans: await q('SELECT id, version, status, source, content, rationale, created_at, activated_at FROM training_plans WHERE athlete_id = $1 ORDER BY version'),
    nutrition_plans: await q('SELECT id, version, status, source, content, rationale, created_at, activated_at FROM nutrition_plans WHERE athlete_id = $1 ORDER BY version'),
    workout_sessions: await q(`SELECT ws.*, (SELECT json_agg(sl) FROM set_logs sl WHERE sl.session_id = ws.id) AS sets
                                FROM workout_sessions ws WHERE athlete_id = $1 ORDER BY performed_on`),
    body_measurements: await q('SELECT * FROM body_measurements WHERE athlete_id = $1 ORDER BY measured_on'),
    food_logs: await q('SELECT * FROM food_logs WHERE athlete_id = $1 ORDER BY logged_on'),
    wellness_reports: await q('SELECT * FROM wellness_reports WHERE athlete_id = $1 ORDER BY reported_on'),
    messages: await q('SELECT sender_id, recipient_id, body, created_at FROM messages WHERE sender_id = $1 OR recipient_id = $1 ORDER BY created_at'),
  };
  await audit(req, 'privacy.export', 'user', id);
  res.attachment(`fitness-ai-datos-${id}.json`).json(data);
});

// Elimina la información personal (admin). Se conservan registros agregados de costos sin datos identificables.
r.delete('/athlete/:athleteId', requireRole('admin'), async (req, res) => {
  const body = parse(z.object({ confirm: z.string() }), req.body);
  const a = await assertAthleteAccess(req.user, req.params.athleteId);
  if (body.confirm !== 'ELIMINAR') throw badRequest('Escribe ELIMINAR para confirmar');
  await tx(async (db) => {
    const id = a.id;
    for (const t of ['assessments', 'training_plans', 'nutrition_plans', 'workout_sessions', 'body_measurements', 'food_logs',
      'wellness_reports', 'coach_notes']) {
      await db.query(`DELETE FROM ${t} WHERE athlete_id = $1`, [id]);
    }
    await db.query('DELETE FROM notifications WHERE user_id = $1', [id]);
    await db.query('DELETE FROM messages WHERE sender_id = $1 OR recipient_id = $1', [id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await db.query('UPDATE ai_requests SET response = NULL WHERE athlete_id = $1', [id]);
    await db.query(`UPDATE users SET status = 'deleted', email = $2, full_name = 'Deportista eliminado', phone = NULL,
                    password_hash = $3, updated_at = now() WHERE id = $1`,
    [id, `deleted-${id}@invalid.local`, await hashPassword(randomToken())]);
    await db.query('UPDATE athlete_profiles SET coach_id = NULL, medical_clearance_note = NULL, nutrition_clearance_note = NULL WHERE user_id = $1', [id]);
    await audit(req, 'privacy.athlete_deleted', 'user', id, null, db);
  });
  res.json({ ok: true });
});

export default r;
