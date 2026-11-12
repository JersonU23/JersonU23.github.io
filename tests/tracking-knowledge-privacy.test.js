import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, pool, login, createGym, createUser, seedExercises, submitAssessment } from './helpers.js';
import { e1rm } from '../src/services/progress.js';
import { estimateEnergy } from '../src/services/assessmentRules.js';
import { computeCost } from '../src/ai/pricing.js';
import { runReminders } from '../src/services/automation.js';

let gym, coach, athlete, exIds, planId;
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

before(async () => {
  await resetDb();
  gym = await createGym();
  await createUser(gym.id, 'admin', { email: 'admin@tk.local' });
  coach = await createUser(gym.id, 'coach', { email: 'coach@tk.local' });
  athlete = await createUser(gym.id, 'athlete', { email: 'ath@tk.local', coachId: coach.id, name: 'Luis Atleta' });
  exIds = await seedExercises(gym.id, 3);
  // Plan activo creado manualmente por el entrenador (sin IA)
  const c = await login('coach@tk.local');
  const r = await c.post(`/api/plans/training/athlete/${athlete.id}/manual`).send({ content: {
    summary: 'Plan manual', duration_weeks: 4,
    days: [{ key: 'A', name: 'Full body', exercises: [{ exercise_id: exIds[0], sets: 3, reps: '8', rest_seconds: 120 }] },
      { key: 'B', name: 'Full body 2', exercises: [{ exercise_id: exIds[1], sets: 3, reps: '10' }] }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  planId = r.body.plan.id;
  await pool.query(`UPDATE training_plans SET activated_at = now() - interval '28 days' WHERE id = $1`, [planId]);
});
after(() => pool.end());

test('fórmulas: 1RM (Epley), Mifflin-St Jeor y costo por tokens', () => {
  assert.equal(Math.round(e1rm(100, 10) * 10) / 10, 133.3);
  const en = estimateEnergy({ sex: 'male', weight_kg: 80, height_cm: 180, age: 30, daily_activity: 'moderate' });
  assert.equal(en.bmr_kcal, 1780); // 10*80 + 6.25*180 - 5*30 + 5
  assert.equal(en.tdee_kcal, Math.round(1780 * 1.55));
  assert.equal(computeCost({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0 },
    { input: 4, output: 20, cache_write: 5, cache_read: 0.2 }), 24.2);
});

test('el plan manual exige ejercicios activos de la biblioteca', async () => {
  const c = await login('coach@tk.local');
  const r = await c.post(`/api/plans/training/athlete/${athlete.id}/manual`).send({ content: {
    days: [{ key: 'A', name: 'x', exercises: [{ exercise_id: '00000000-0000-0000-0000-000000000000', sets: 3, reps: '8' }] }] } });
  assert.equal(r.status, 400);
});

test('registro de sesiones, series y cargas; progreso calculado sin IA', async () => {
  const a = await login('ath@tk.local');
  const plan = [[20, 60], [14, 62.5], [6, 65], [2, 67.5]];
  for (const [d, load] of plan) {
    const r = await a.post(`/api/tracking/athlete/${athlete.id}/sessions`).send({
      day_key: 'A', performed_on: daysAgo(d), duration_min: 50, fatigue: 5,
      sets: [{ exercise_id: exIds[0], set_number: 1, reps: 8, load_kg: load, rir: 2 }, { exercise_id: exIds[0], set_number: 2, reps: 8, load_kg: load, rir: 1 }] });
    assert.equal(r.status, 201);
  }
  assert.equal((await a.post(`/api/tracking/athlete/${athlete.id}/sessions`).send({ performed_on: '2999-01-01' })).status, 400, 'fecha futura');
  const p = await a.get(`/api/tracking/athlete/${athlete.id}/progress?days=28`);
  assert.equal(p.status, 200);
  const ex = p.body.summary.exercises.find((x) => x.exercise_id === exIds[0]);
  assert.equal(ex.sets, 8);
  assert.equal(ex.top_load_kg, 67.5);
  assert.ok(ex.e1rm_change_pct > 0);
  assert.equal(p.body.summary.sessions.done, 4);
  assert.equal(p.body.summary.sessions.planned, 8); // 2 días/semana × 4 semanas
  assert.equal(p.body.summary.sessions.adherence, 0.5);
  assert.equal(p.body.series.exercises[0].points.length, 4);
  const { n } = (await pool.query('SELECT count(*)::int AS n FROM ai_requests')).rows[0];
  assert.equal(n, 0, 'el seguimiento no usa IA');
});

test('medidas corporales, alimentación y bienestar con alerta de dolor al entrenador', async () => {
  const a = await login('ath@tk.local');
  assert.equal((await a.post(`/api/tracking/athlete/${athlete.id}/measurements`).send({})).status, 400);
  assert.equal((await a.post(`/api/tracking/athlete/${athlete.id}/measurements`).send({ weight_kg: 80, waist_cm: 85, measured_on: daysAgo(20) })).status, 201);
  assert.equal((await a.post(`/api/tracking/athlete/${athlete.id}/measurements`).send({ weight_kg: 79.2 })).status, 201);
  assert.equal((await a.post(`/api/tracking/athlete/${athlete.id}/food`).send({ meal: 'Almuerzo', kcal: 700, protein_g: 45, adherence: 'followed' })).status, 201);
  const food = await a.get(`/api/tracking/athlete/${athlete.id}/food`);
  assert.equal(food.body.daily[0].kcal, 700);
  assert.equal((await a.post(`/api/tracking/athlete/${athlete.id}/wellness`).send({ pain: true })).status, 400, 'dolor sin ubicación');
  assert.equal((await a.post(`/api/tracking/athlete/${athlete.id}/wellness`).send({ fatigue: 7, pain: true, pain_location: 'hombro derecho', pain_intensity: 7 })).status, 201);
  const c = await login('coach@tk.local');
  const n = await c.get('/api/notifications');
  assert.ok(n.body.notifications.some((x) => x.kind === 'pain_alert'));
  const p = await a.get(`/api/tracking/athlete/${athlete.id}/progress?days=30`);
  assert.equal(p.body.summary.body.weight_change_kg, -0.8);
  assert.equal(p.body.summary.wellness.pain_reports, 1);
});

test('observaciones: solo personal', async () => {
  const c = await login('coach@tk.local');
  assert.equal((await c.post(`/api/tracking/athlete/${athlete.id}/notes`).send({ body: 'Buena técnica en sentadilla' })).status, 201);
  const a = await login('ath@tk.local');
  assert.equal((await a.get(`/api/tracking/athlete/${athlete.id}/notes`)).status, 403);
});

test('dashboard con indicadores reales y alertas', async () => {
  const adm = await login('admin@tk.local');
  const d = await adm.get('/api/dashboard');
  assert.equal(d.status, 200);
  assert.equal(d.body.athletes_active, 1);
  assert.equal(d.body.coaches_active, 1);
  assert.equal(d.body.training_plans_active, 1);
  assert.equal(d.body.assessments_pending, 1);
  assert.equal(d.body.biweekly_reviews_due, 1);
  assert.equal(d.body.training_adherence_28d, 0.5);
  assert.equal(d.body.progress.athletes_improving, 1);
  assert.ok(d.body.alerts.some((x) => x.type === 'pain'));
  const c = await login('coach@tk.local');
  const dc = await c.get('/api/dashboard');
  assert.equal(dc.body.ai, null, 'el entrenador no ve costos');
  assert.equal((await login('ath@tk.local')).user.role, 'athlete');
});

test('recordatorios sin IA, idempotentes', async () => {
  await runReminders();
  await runReminders();
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'review_due'`);
  assert.equal(rows[0].n, 1);
});

test('mensajería: deportista solo con su entrenador', async () => {
  const other = await createUser(gym.id, 'coach', { email: 'otro@tk.local' });
  const a = await login('ath@tk.local');
  assert.equal((await a.post('/api/messages').send({ to: coach.id, body: 'Hola profe' })).status, 201);
  assert.equal((await a.post('/api/messages').send({ to: other.id, body: 'Hola' })).status, 403);
  const c = await login('coach@tk.local');
  const contacts = await c.get('/api/messages/contacts');
  assert.equal(contacts.body.contacts.find((x) => x.id === athlete.id).unread, 1);
  const conv = await c.get(`/api/messages/with/${athlete.id}`);
  assert.equal(conv.body.messages[0].body, 'Hola profe');
});

test('conocimiento: científico exige referencias; versionado; solo validado alimenta la IA', async () => {
  const c = await login('coach@tk.local');
  const bad = await c.post('/api/knowledge').send({ kind: 'scientific', title: 'X', topic: 'fuerza', summary: 'y', source: 's', authors: 'a', published_on: '2020-01-01', reference_list: [], evidence_level: 'rct' });
  assert.equal(bad.status, 400);
  const emp = await c.post('/api/knowledge').send({
    kind: 'empirical', title: 'Pausa en sentadilla para principiantes', topic: 'tecnica', summary: 'Pausas de 2 s mejoran el control en principiantes',
    objective: 'Mejorar técnica', context: 'Grupo de 12 principiantes', applicable_profile: 'principiante', results: 'Menos valgo de rodilla',
    limitations: 'Observación no controlada', classification: 'repeated' });
  assert.equal(emp.status, 201, JSON.stringify(emp.body));
  const id = emp.body.entry.id;
  const before = await c.get('/api/knowledge/retrieval-preview?q=sentadilla principiante');
  assert.equal(before.body.entries.length, 0, 'pendiente de validación: no se usa');
  const adm = await login('admin@tk.local');
  assert.equal((await c.post(`/api/knowledge/${id}/validate`).send({ status: 'validated' })).status, 403);
  assert.equal((await adm.post(`/api/knowledge/${id}/validate`).send({ status: 'validated' })).status, 200);
  const after = await c.get('/api/knowledge/retrieval-preview?q=sentadilla principiante');
  assert.equal(after.body.entries[0].id, id);
  const upd = await c.patch(`/api/knowledge/${id}`).send({ results: 'Menos valgo y más profundidad' });
  assert.equal(upd.body.entry.version, 2);
  assert.equal(upd.body.entry.validation_status, 'pending', 'editar vuelve a pendiente');
  const detail = await c.get(`/api/knowledge/${id}`);
  assert.equal(detail.body.versions.length, 2);
  const v1 = await c.get(`/api/knowledge/${id}/versions/1`);
  assert.equal(v1.body.version.snapshot.results, 'Menos valgo de rodilla');
  const coach2 = await createUser(gym.id, 'coach', { email: 'c3@tk.local' });
  assert.ok(coach2);
  assert.equal((await (await login('c3@tk.local')).patch(`/api/knowledge/${id}`).send({ results: 'x' })).status, 403);
});

test('configuración por niveles, auditada; capacidad no menor que activos', async () => {
  const adm = await login('admin@tk.local');
  assert.equal((await adm.patch('/api/settings').send({ level: 'basic', values: { ai_model: 'claude-haiku-5-5' } })).status, 400, 'modelo es parámetro avanzado');
  const r = await adm.patch('/api/settings').send({ level: 'advanced', values: { ai_model: 'claude-sonnet-5-5', min_days_between_adjustments: 15,
    operating_costs: { infrastructure: 25, database: 19 }, monthly_fee_usd: 300 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.ai_model, 'claude-sonnet-5-5');
  assert.equal((await adm.patch('/api/settings').send({ level: 'advanced', values: { capacity: 0 } })).status, 400);
  const audit = await adm.get('/api/audit?action=settings.updated');
  assert.ok(audit.body.entries[0].details.changed.includes('ai_model'));
  assert.equal((await adm.patch('/api/settings').send({ level: 'automatic', automatic: { auto_initial_generation: true } })).status, 400, 'automático exige límite de costo');
  assert.equal((await adm.patch('/api/settings').send({ level: 'automatic', automatic: { auto_initial_generation: true, auto_max_cost_per_request_usd: 0.5 } })).status, 200);
  const eco = await adm.get('/api/reports/economics');
  assert.equal(eco.body.total_cost_usd, 44);
  assert.equal(eco.body.margin, Math.round(((300 - 44) / 300) * 1000) / 1000);
  assert.equal(eco.body.min_fee_for_target_usd, 110);
  assert.ok(eco.body.operating_costs_missing.includes('payment_gateway'));
  const csv = await adm.get('/api/reports/athletes.csv');
  assert.match(csv.text, /Luis Atleta/);
});

test('privacidad: exportación por el deportista y eliminación por el admin', async () => {
  const a = await login('ath@tk.local');
  await submitAssessment(a, athlete.id);
  const exp = await a.get(`/api/privacy/athlete/${athlete.id}/export`);
  assert.equal(exp.status, 200);
  assert.equal(exp.body.profile.full_name, 'Luis Atleta');
  assert.equal(exp.body.assessments[0].health.has_injuries, false, 'salud descifrada en la exportación');
  assert.ok(exp.body.workout_sessions.length >= 4);
  const c = await login('coach@tk.local');
  assert.equal((await c.get(`/api/privacy/athlete/${athlete.id}/export`)).status, 403);
  const adm = await login('admin@tk.local');
  assert.equal((await adm.del(`/api/privacy/athlete/${athlete.id}`).send({ confirm: 'no' })).status, 400);
  assert.equal((await adm.del(`/api/privacy/athlete/${athlete.id}`).send({ confirm: 'ELIMINAR' })).status, 200);
  const { rows: [u] } = await pool.query('SELECT status, full_name, email FROM users WHERE id = $1', [athlete.id]);
  assert.equal(u.status, 'deleted');
  assert.ok(!u.email.includes('ath@tk.local'));
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM workout_sessions WHERE athlete_id = $1', [athlete.id]);
  assert.equal(n, 0);
  assert.equal((await a.get('/api/auth/me')).status, 401, 'sesiones eliminadas');
});
