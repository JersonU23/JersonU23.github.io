import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, pool, login, createGym, createUser, fullAssessment, submitAssessment } from './helpers.js';

let gym, coach, athlete;
before(async () => {
  await resetDb();
  gym = await createGym();
  await createUser(gym.id, 'admin', { email: 'admin@t.local' });
  coach = await createUser(gym.id, 'coach', { email: 'coach@t.local' });
  athlete = await createUser(gym.id, 'athlete', { email: 'ath@t.local', coachId: coach.id });
});
after(() => pool.end());

test('evaluación progresiva: guarda por secciones y se puede retomar', async () => {
  const a = await login('ath@t.local');
  const r1 = await a.put(`/api/assessments/athlete/${athlete.id}/section/personal`).send({ weight_kg: 80, height_cm: 175 });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.evaluation.missing.length > 0);
  const r2 = await a.put(`/api/assessments/athlete/${athlete.id}/section/personal`).send({ sex: 'male' });
  assert.equal(r2.body.assessment.data.personal.weight_kg, 80, 'conserva lo guardado antes');
  const cur = await a.get(`/api/assessments/athlete/${athlete.id}/current`);
  assert.equal(cur.body.assessment.current_step, 'personal');
  assert.equal(cur.body.assessment.status, 'draft');
});

test('datos fuera de rango o campos desconocidos se rechazan', async () => {
  const a = await login('ath@t.local');
  assert.equal((await a.put(`/api/assessments/athlete/${athlete.id}/section/personal`).send({ weight_kg: 5 })).status, 400);
  assert.equal((await a.put(`/api/assessments/athlete/${athlete.id}/section/personal`).send({ hack: 1 })).status, 400);
  assert.equal((await a.put(`/api/assessments/athlete/${athlete.id}/section/inexistente`).send({})).status, 404);
});

test('no se envía si faltan datos críticos', async () => {
  const a = await login('ath@t.local');
  const r = await a.post(`/api/assessments/athlete/${athlete.id}/submit`).send({});
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'missing_critical');
  assert.ok(r.body.details.some((d) => d.field === 'goals.primary_goal'));
});

test('la sección de salud se guarda cifrada en la base de datos', async () => {
  const a = await login('ath@t.local');
  await a.put(`/api/assessments/athlete/${athlete.id}/section/health`).send({ has_injuries: true, injuries: 'Tendinopatía rotuliana' });
  const { rows: [row] } = await pool.query('SELECT data, health_enc FROM assessments WHERE athlete_id = $1', [athlete.id]);
  assert.ok(row.health_enc.startsWith('v1.'));
  assert.ok(!row.health_enc.includes('rotuliana'));
  assert.equal(row.data.health, undefined);
  const cur = await a.get(`/api/assessments/athlete/${athlete.id}/current`);
  assert.equal(cur.body.assessment.data.health.injuries, 'Tendinopatía rotuliana');
});

test('envío completo, bloqueo de edición para el deportista y notificación al entrenador', async () => {
  const a = await login('ath@t.local');
  const data = { ...fullAssessment, health: { ...fullAssessment.health, has_injuries: true, injuries: 'Tendinopatía rotuliana' } };
  const r = await submitAssessment(a, athlete.id, data);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await a.put(`/api/assessments/athlete/${athlete.id}/section/goals`).send({ primary_goal: 'strength' });
  assert.equal(again.status, 409);
  const c = await login('coach@t.local');
  const n = await c.get('/api/notifications');
  assert.ok(n.body.notifications.some((x) => x.kind === 'assessment_submitted'));
  // el entrenador puede corregir (queda auditado)
  assert.equal((await c.put(`/api/assessments/athlete/${athlete.id}/section/goals`).send({ primary_goal: 'strength' })).status, 200);
  const { rows } = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'assessment.edited_after_submit'`);
  assert.equal(rows.length, 1);
});

test('señales de alerta del cribado de salud', async () => {
  const other = await createUser(gym.id, 'athlete', { email: 'risk@t.local', coachId: coach.id });
  const a = await login('risk@t.local');
  const data = structuredClone(fullAssessment);
  data.health.screening.chest_pain_activity = true;
  data.health.clinical_nutrition.diabetes = true;
  const r = await submitAssessment(a, other.id, data);
  assert.equal(r.status, 200);
  const types = r.body.evaluation.flags.map((f) => f.type);
  assert.ok(types.includes('medical_clearance_required'));
  assert.ok(types.includes('nutrition_referral_required'));
});

test('biblioteca: admin crea, edita y desactiva; deportista solo ve activos', async () => {
  const adm = await login('admin@t.local');
  const ex = {
    name: 'Sentadilla goblet', primary_muscles: ['cuádriceps', 'glúteo'], secondary_muscles: ['core'], equipment: ['dumbbells'],
    movement_type: 'sentadilla', level: 'beginner', execution: 'Mancuerna al pecho, descender con control.',
    breathing: 'Inhalar al bajar, exhalar al subir.', common_errors: ['Rodillas hacia dentro'], variations: ['Con pausa'],
    alternatives: ['Prensa de piernas'], contraindications: ['Dolor agudo de rodilla'], media_url: 'https://example.com/goblet.mp4', media_type: 'video',
  };
  const r = await adm.post('/api/exercises').send(ex);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await adm.post('/api/exercises').send(ex)).status, 409);
  assert.equal((await adm.post('/api/exercises').send({ ...ex, name: 'Malo', media_url: 'javascript:alert(1)' })).status, 400);
  const id = r.body.exercise.id;
  assert.equal((await adm.patch(`/api/exercises/${id}`).send({ level: 'intermediate' })).body.exercise.level, 'intermediate');
  const a = await login('ath@t.local');
  assert.equal((await a.get('/api/exercises')).body.exercises.length, 1);
  assert.equal((await a.post('/api/exercises').send({ ...ex, name: 'X' })).status, 403);
  await adm.patch(`/api/exercises/${id}`).send({ status: 'inactive' });
  assert.equal((await a.get('/api/exercises')).body.exercises.length, 0);
  assert.equal((await a.get(`/api/exercises/${id}`)).status, 404);
  assert.equal((await adm.get('/api/exercises?status=all')).body.exercises.length, 1);
  const filtered = await adm.get('/api/exercises?status=all&muscle=glúteo');
  assert.equal(filtered.body.exercises.length, 1);
});
