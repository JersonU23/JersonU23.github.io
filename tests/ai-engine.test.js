import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, pool, login, createGym, createUser, submitAssessment, fullAssessment, seedExercises, addKnowledge, FakeProvider, setProvider } from './helpers.js';

let gym, coach, athlete, exIds, knowledge, fake;
const backdate = async (athleteId, days) => {
  await pool.query(`UPDATE training_plans SET activated_at = now() - make_interval(days => $2) WHERE athlete_id = $1 AND status = 'active'`, [athleteId, days]);
  await pool.query(`UPDATE ai_requests SET created_at = created_at - make_interval(days => $2) WHERE athlete_id = $1 AND operation = 'biweekly_adjustment'`, [athleteId, days]);
};

before(async () => {
  await resetDb();
  gym = await createGym();
  await createUser(gym.id, 'admin', { email: 'admin@ai.local' });
  coach = await createUser(gym.id, 'coach', { email: 'coach@ai.local' });
  athlete = await createUser(gym.id, 'athlete', { email: 'ath@ai.local', coachId: coach.id, name: 'Ana Deportista' });
  exIds = await seedExercises(gym.id, 10);
  knowledge = await addKnowledge(gym.id);
  await addKnowledge(gym.id, { validated: false, title: 'No validado hipertrofia', summary: 'hipertrofia sin validar' });
});
after(() => pool.end());
beforeEach(() => { fake = new FakeProvider(); setProvider(fake); });

test('sin proveedor configurado → 503 claro, sin simular', async () => {
  setProvider(null);
  const a = await login('ath@ai.local');
  await submitAssessment(a, athlete.id);
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${athlete.id}/initial`).send({});
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'ai_not_configured');
});

test('el deportista no puede invocar la IA', async () => {
  const a = await login('ath@ai.local');
  assert.equal((await a.post(`/api/ai/athletes/${athlete.id}/initial`).send({})).status, 403);
});

test('generación inicial combinada: planes pendientes, tokens y costo registrados, datos minimizados', async () => {
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${athlete.id}/initial`).send({});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(fake.calls.length, 1, 'una sola solicitud para entrenamiento + nutrición');
  assert.equal(r.body.training_plan.status, 'pending_review');
  assert.equal(r.body.nutrition_plan.status, 'pending_review');
  const { rows: [req] } = await pool.query('SELECT * FROM ai_requests WHERE id = $1', [r.body.ai_request_id]);
  assert.equal(req.status, 'succeeded');
  assert.equal(req.input_tokens, 3000);
  assert.equal(req.output_tokens, 2000);
  // claude-opus-5-5: 3000*4/1e6 + 2000*20/1e6 = 0.052
  assert.equal(req.cost_usd, 0.052);
  assert.equal(req.price_snapshot.model, 'claude-opus-5-5');
  // Minimización: el nombre y el correo no se envían al proveedor
  const sent = fake.calls[0].system + fake.calls[0].user;
  assert.ok(!sent.includes('Ana Deportista') && !sent.includes('ath@ai.local') && !sent.includes('1995-04-10'));
  // Solo conocimiento validado en el contexto
  assert.ok(fake.calls[0].user.includes(knowledge.id));
  assert.ok(!fake.calls[0].user.includes('No validado'));
  // Citas: solo las de registros entregados (la inventada se descarta)
  const { rows: cites } = await pool.query('SELECT * FROM ai_citations WHERE ai_request_id = $1', [req.id]);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].entry_id, knowledge.id);
  // Ejercicio propuesto por IA queda como "propuesto" para validación del admin
  const { rows: [prop] } = await pool.query(`SELECT status, source FROM exercises WHERE name = 'Ejercicio propuesto IA'`);
  assert.deepEqual(prop, { status: 'proposed', source: 'ai_proposed' });
});

test('no se genera otro plan inicial mientras hay uno pendiente', async () => {
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${athlete.id}/initial`).send({});
  assert.equal(r.status, 409);
  assert.equal(fake.calls.length, 0);
});

test('el deportista no ve planes pendientes; el entrenador aprueba y se activa', async () => {
  const a = await login('ath@ai.local');
  assert.equal((await a.get(`/api/plans/athlete/${athlete.id}/current`)).body.training, null);
  const c = await login('coach@ai.local');
  const pending = await c.get('/api/plans/pending');
  assert.equal(pending.body.pending.length, 2);
  const tp = pending.body.pending.find((p) => p.kind === 'training');
  assert.equal((await c.post(`/api/plans/training/${tp.id}/review`).send({ decision: 'reject' })).status, 400, 'rechazar exige motivo');
  assert.equal((await c.post(`/api/plans/training/${tp.id}/review`).send({ decision: 'approve', notes: 'ok' })).status, 200);
  const np = pending.body.pending.find((p) => p.kind === 'nutrition');
  assert.equal((await c.post(`/api/plans/nutrition/${np.id}/review`).send({ decision: 'approve' })).status, 200);
  const cur = await a.get(`/api/plans/athlete/${athlete.id}/current`);
  assert.equal(cur.body.training.status, 'active');
  assert.ok(cur.body.training.exercises[exIds[0]] || Object.keys(cur.body.training.exercises).length, 'incluye detalle de ejercicios');
  assert.equal(cur.body.nutrition.status, 'active');
  assert.ok((await a.get('/api/notifications')).body.notifications.some((n) => n.kind === 'plan_activated'));
});

test('con plan activo, la generación inicial se rechaza (usar ajuste)', async () => {
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${athlete.id}/initial`).send({});
  assert.equal(r.body.code, 'plan_active');
});

test('ajuste quincenal: respeta el intervalo mínimo', async () => {
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${athlete.id}/adjustment`).send({});
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'adjustment_too_soon');
  assert.equal(fake.calls.length, 0);
});

test('ajuste quincenal: exige datos suficientes de seguimiento', async () => {
  await backdate(athlete.id, 16);
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${athlete.id}/adjustment`).send({});
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'insufficient_data');
  assert.equal(fake.calls.length, 0, 'sin datos no se gasta en IA');
});

test('ajuste quincenal con datos: propuesta pendiente con cambios y resumen calculado', async () => {
  const a = await login('ath@ai.local');
  for (const [d, load] of [[10, 40], [5, 42.5]]) {
    const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const r = await a.post(`/api/tracking/athlete/${athlete.id}/sessions`).send({
      day_key: 'A', performed_on: date, duration_min: 55, fatigue: 6,
      sets: [1, 2, 3].map((n) => ({ exercise_id: exIds[0], set_number: n, reps: 10, load_kg: load, rir: 2 })) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const c = await login('coach@ai.local');
  const q = await c.get(`/api/ai/athletes/${athlete.id}/quota`);
  assert.equal(q.body.adjustment.available, true);
  const r = await c.post(`/api/ai/athletes/${athlete.id}/adjustment`).send({ request: 'Priorizar técnica' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.training_plan.status, 'pending_review');
  assert.equal(r.body.changes[0].change_type, 'load_increase');
  assert.ok(fake.calls[0].user.includes('Priorizar técnica'));
  assert.ok(fake.calls[0].user.includes('e1rm_change_pct'), 'el resumen de seguimiento se calcula en código y se envía');
  // segundo ajuste bloqueado mientras el anterior está pendiente
  assert.equal((await c.post(`/api/ai/athletes/${athlete.id}/adjustment`).send({})).body.code, 'plan_pending');
  // el entrenador modifica antes de aprobar
  const plan = (await c.get(`/api/plans/training/${r.body.training_plan.id}`)).body.plan;
  const content = { ...plan.content, days: plan.content.days.map((d) => ({ ...d, exercises: d.exercises.map((e) => ({ ...e, sets: 2 })) })) };
  const ap = await c.post(`/api/plans/training/${plan.id}/review`).send({ decision: 'approve', content, notes: 'Bajo a 2 series' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const { rows: [active] } = await pool.query(`SELECT version, content FROM training_plans WHERE athlete_id = $1 AND status = 'active'`, [athlete.id]);
  assert.equal(active.version, 2);
  assert.equal(active.content.days[0].exercises[0].sets, 2);
  assert.equal(active.content.modified_by_coach, true);
});

test('máximo de ajustes por mes', async () => {
  await pool.query(`UPDATE gym_settings SET max_adjustments_per_month = 1 WHERE gym_id = $1`, [gym.id]);
  await pool.query(`UPDATE training_plans SET activated_at = now() - interval '20 days' WHERE athlete_id = $1 AND status = 'active'`, [athlete.id]);
  await pool.query(`UPDATE ai_requests SET created_at = now() - interval '20 days' WHERE athlete_id = $1 AND operation = 'biweekly_adjustment'`, [athlete.id]);
  const c = await login('coach@ai.local');
  const q = await c.get(`/api/ai/athletes/${athlete.id}/quota`);
  // si 20 días atrás cae en el mes anterior, la cuota se reinicia; forzamos que cuente en este mes
  await pool.query(`UPDATE ai_requests SET created_at = date_trunc('month', now()) + interval '1 day' WHERE athlete_id = $1 AND operation = 'biweekly_adjustment'`, [athlete.id]);
  await pool.query(`UPDATE training_plans SET activated_at = date_trunc('month', now()) WHERE athlete_id = $1 AND status = 'active'`, [athlete.id]);
  const r = await c.post(`/api/ai/athletes/${athlete.id}/adjustment`).send({});
  assert.equal(r.status, 429, JSON.stringify({ q: q.body, r: r.body }));
  assert.equal(r.body.code, 'adjustment_limit');
  await pool.query(`UPDATE gym_settings SET max_adjustments_per_month = 2 WHERE gym_id = $1`, [gym.id]);
});

test('nutrición: no se regenera sin cambios relevantes; sí con cambio de peso', async () => {
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${athlete.id}/nutrition-update`).send({ reason: 'corto' });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'no_relevant_change');
  const a = await login('ath@ai.local');
  await a.post(`/api/tracking/athlete/${athlete.id}/measurements`).send({ weight_kg: 78 });
  const r2 = await c.post(`/api/ai/athletes/${athlete.id}/nutrition-update`).send({});
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.ok(r2.body.reasons[0].includes('82 kg a 78 kg'));
});

test('deduplicación: entrada idéntica reutiliza la respuesta sin costo', async () => {
  const adm = await login('admin@ai.local');
  const r1 = await adm.post('/api/ai/assistant').send({ question: '¿Cuántos deportistas activos hay?' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.reused, false);
  const r2 = await adm.post('/api/ai/assistant').send({ question: '¿Cuántos deportistas activos hay?' });
  assert.equal(r2.body.reused, true);
  assert.equal(fake.calls.length, 1);
  const { rows: [reused] } = await pool.query(`SELECT cost_usd, reused_from FROM ai_requests WHERE id = $1`, [r2.body.ai_request_id]);
  assert.equal(reused.cost_usd, 0);
  assert.ok(reused.reused_from);
  // el informe del asistente no contiene nombres de deportistas
  assert.ok(!fake.calls[0].user.includes('Ana Deportista'));
});

test('presupuesto agotado bloquea nuevas solicitudes y alerta al admin', async () => {
  await pool.query('UPDATE gym_settings SET ai_monthly_budget_usd = 0.05 WHERE gym_id = $1', [gym.id]);
  const adm = await login('admin@ai.local');
  const r = await adm.post('/api/ai/assistant').send({ question: 'Pregunta nueva sobre costos' });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'budget_exhausted');
  assert.equal(fake.calls.length, 0);
  const n = await adm.get('/api/notifications');
  assert.ok(n.body.notifications.some((x) => x.kind === 'ai_budget'));
  const usage = await adm.get('/api/ai/usage');
  assert.ok(usage.body.month.cost > 0.05);
  assert.equal(usage.body.month.blocked, 1);
  await pool.query('UPDATE gym_settings SET ai_monthly_budget_usd = 50 WHERE gym_id = $1', [gym.id]);
});

test('seguridad clínica: sin autorización médica no se planifica; nutrición derivada si hay condición clínica', async () => {
  const risky = await createUser(gym.id, 'athlete', { email: 'risk@ai.local', coachId: coach.id });
  const a = await login('risk@ai.local');
  const data = structuredClone(fullAssessment);
  data.health.screening.heart_condition = true;
  data.health.clinical_nutrition.diabetes = true;
  await submitAssessment(a, risky.id, data);
  const c = await login('coach@ai.local');
  const r = await c.post(`/api/ai/athletes/${risky.id}/initial`).send({});
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'medical_clearance_required');
  assert.equal(fake.calls.length, 0);
  await c.put(`/api/users/athletes/${risky.id}/clearance`).send({ type: 'medical', granted: true, note: 'Certificado médico del 2026-11-01' });
  const r2 = await c.post(`/api/ai/athletes/${risky.id}/initial`).send({});
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.nutrition_plan, null);
  assert.equal(r2.body.nutrition_referral, true);
  assert.ok(!fake.calls[0].schema.properties.nutrition, 'no se pidió nutrición a la IA');
});

test('ejercicios inexistentes en la respuesta se descartan con advertencia; rechazo del modelo se registra', async () => {
  const b = await createUser(gym.id, 'athlete', { email: 'b@ai.local', coachId: coach.id });
  const a = await login('b@ai.local');
  await submitAssessment(a, b.id);
  const c = await login('coach@ai.local');
  fake.mode = 'refusal';
  const r0 = await c.post(`/api/ai/athletes/${b.id}/initial`).send({});
  assert.equal(r0.status, 422);
  assert.equal(r0.body.code, 'ai_refused');
  const { rows: [ref] } = await pool.query(`SELECT status, input_tokens FROM ai_requests WHERE athlete_id = $1 ORDER BY created_at DESC LIMIT 1`, [b.id]);
  assert.equal(ref.status, 'refused');
  fake.mode = 'bad_ids';
  const r = await c.post(`/api/ai/athletes/${b.id}/initial`).send({});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.warnings.some((w) => w.includes('fuera de la biblioteca')));
  const { rows: [p] } = await pool.query(`SELECT content FROM training_plans WHERE id = $1`, [r.body.training_plan.id]);
  assert.ok(p.content.days.every((d) => d.exercises.every((e) => exIds.includes(e.exercise_id))));
});

test('biblioteca insuficiente impide generar', async () => {
  const g2 = await createGym({ name: 'Vacío' });
  const c2 = await createUser(g2.id, 'coach', { email: 'c2@ai.local' });
  const a2 = await createUser(g2.id, 'athlete', { email: 'a2@ai.local', coachId: c2.id });
  await submitAssessment(await login('a2@ai.local'), a2.id);
  const r = await (await login('c2@ai.local')).post(`/api/ai/athletes/${a2.id}/initial`).send({});
  assert.equal(r.body.code, 'library_too_small');
});

test('historial de operaciones de IA y CSV de consumo', async () => {
  const adm = await login('admin@ai.local');
  const r = await adm.get('/api/ai/requests');
  assert.ok(r.body.total >= 5);
  const csv = await adm.get('/api/reports/ai-usage.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^fecha,operacion,estado/);
});
