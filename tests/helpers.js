// Utilidades de prueba: base de datos de test real (PostgreSQL), usuarios y proveedor de IA determinista.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://fitness:fitness@localhost:5432/fitness_test';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64');
process.env.ANTHROPIC_API_KEY = '';
process.env.APP_ORIGIN = 'http://localhost:3000';

const { pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { setProvider } = await import('../src/ai/provider.js');
const request = (await import('supertest')).default;

export { pool, setProvider };
export const PASSWORD = 'Password123x';
let cachedHash;

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
}

export const app = createApp();

// Cliente autenticado por cookie (como el navegador), con la cabecera anti-CSRF
export async function login(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status} ${JSON.stringify(res.body)}`);
  const wrap = (m) => (url) => agent[m](url).set('X-Requested-With', 'fetch');
  return { agent, user: res.body.user, get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), del: wrap('delete') };
}
export const anon = () => request(app);

export async function createGym({ name = 'Gimnasio Test', capacity = 300 } = {}) {
  const { rows: [g] } = await pool.query('INSERT INTO gyms (name, capacity) VALUES ($1,$2) RETURNING *', [name, capacity]);
  await pool.query('INSERT INTO gym_settings (gym_id) VALUES ($1)', [g.id]);
  return g;
}

export async function createUser(gymId, role, { email, name, coachId = null } = {}) {
  cachedHash ||= await hashPassword(PASSWORD);
  const e = email || `${role}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (gym_id, email, password_hash, role, full_name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [gymId, e, cachedHash, role, name || `${role} ${e.slice(0, 10)}`]);
  if (role === 'athlete') await pool.query('INSERT INTO athlete_profiles (user_id, coach_id) VALUES ($1,$2)', [u.id, coachId]);
  if (role === 'coach') await pool.query('INSERT INTO coach_profiles (user_id) VALUES ($1)', [u.id]);
  return u;
}

// Evaluación completa y válida (sin señales de alerta)
export const fullAssessment = {
  personal: { birth_date: '1995-04-10', sex: 'male', weight_kg: 82, height_cm: 178, daily_activity: 'light' },
  goals: { primary_goal: 'hypertrophy', secondary_goals: ['strength'] },
  experience: { level: 'intermediate', months_training: 18, current_frequency_per_week: 3 },
  health: {
    has_injuries: false, has_conditions: false, takes_medications: false, allergies: '', dietary_restrictions: '',
    screening: { heart_condition: false, chest_pain_activity: false, chest_pain_rest: false, dizziness_or_fainting: false,
      bone_joint_problem: false, blood_pressure_or_heart_medication: false, other_reason: false },
    clinical_nutrition: { diabetes: false, kidney_disease: false, eating_disorder_history: false, pregnant_or_lactating: false,
      severe_food_allergy: false, other_metabolic: false },
  },
  availability: { days: ['mon', 'wed', 'fri'], session_minutes: 60, preferred_time: 'evening' },
  equipment: { available: ['machines', 'free_weights', 'cables', 'barbell', 'dumbbells', 'bench', 'rack'] },
  habits: { sleep_hours: 7, stress_level: 4, water_liters: 2, meals_per_day: 4, food_budget: 'medium' },
};

export async function submitAssessment(client, athleteId, data = fullAssessment) {
  for (const [section, values] of Object.entries(data)) {
    const r = await client.put(`/api/assessments/athlete/${athleteId}/section/${section}`).send(values);
    if (r.status !== 200) throw new Error(`section ${section}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return client.post(`/api/assessments/athlete/${athleteId}/submit`).send({});
}

export async function seedExercises(gymId, n = 10) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const { rows: [e] } = await pool.query(
      `INSERT INTO exercises (gym_id, name, primary_muscles, equipment, level) VALUES ($1,$2,$3,$4,'beginner') RETURNING id`,
      [gymId, `Ejercicio ${i + 1}`, [i % 2 ? 'cuádriceps' : 'pectoral'], ['dumbbells']]);
    ids.push(e.id);
  }
  return ids;
}

export async function addKnowledge(gymId, { validated = true, title = 'Volumen e hipertrofia', summary = 'Mayor volumen semanal se asocia a mayor hipertrofia hasta cierto punto.' } = {}) {
  const { rows: [k] } = await pool.query(
    `INSERT INTO knowledge_entries (gym_id, kind, title, topic, summary, source, authors, published_on, reference_list, evidence_level, validation_status)
     VALUES ($1,'scientific',$2,'hipertrofia',$3,'Revista de prueba','Autor A','2020-01-01',$4,'meta_analysis',$5) RETURNING *`,
    [gymId, title, summary, ['Referencia de prueba (entorno de test)'], validated ? 'validated' : 'pending']);
  return k;
}

// Proveedor de IA determinista para pruebas: arma respuestas válidas con los ids de la biblioteca recibida.
export class FakeProvider {
  constructor() { this.calls = []; this.mode = 'ok'; }
  async generateJson(args) {
    this.calls.push(args);
    const ids = [...args.system.matchAll(/^([0-9a-f-]{36}) \|/gm)].map((m) => m[1]);
    const kIds = [...args.user.matchAll(/^\[([0-9a-f-]{36})\]/gm)].map((m) => m[1]);
    const usage = { input_tokens: 3000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (this.mode === 'refusal') {
      const { AIProviderError } = await import('../src/ai/provider.js');
      throw new AIProviderError('declined', { kind: 'refusal', usage, model: args.model });
    }
    const day = (key) => ({
      key, name: `Día ${key}`, focus: 'general', suggested_weekday: 'any', warmup: '5 min', cooldown: '5 min',
      exercises: [
        { exercise_id: ids[0], sets: 3, reps: '8-10', intensity: 'moderada', rir_or_rpe: 'RIR 2', rest_seconds: 90, notes: '' },
        { exercise_id: ids[1], sets: 3, reps: '10-12', intensity: 'moderada', rir_or_rpe: 'RIR 2', rest_seconds: 90, notes: '' },
        ...(this.mode === 'bad_ids' ? [{ exercise_id: '00000000-0000-0000-0000-000000000000', sets: 3, reps: '10', intensity: '', rir_or_rpe: '', rest_seconds: 60, notes: '' }] : []),
      ],
    });
    const evidence = kIds.length ? [{ knowledge_id: kIds[0], source_type: 'scientific', how_applied: 'volumen moderado' }] : [];
    const fakeEvidence = [{ knowledge_id: 'inventado-123', source_type: 'scientific', how_applied: 'x' }];
    const training = {
      summary: 'Plan', rationale: 'Porque sí', weekly_structure: '3 días', duration_weeks: 4, warmup_protocol: 'x', mobility: 'x',
      progression: 'doble progresión', recovery: '48h', days: [day('A'), day('B'), day('C')], safety_notes: [],
      evidence_used: [...evidence, ...fakeEvidence], inferences: ['inferencia'], contradictions: [],
      proposed_exercises: [{ name: 'Ejercicio propuesto IA', primary_muscles: ['glúteo'], equipment: ['bands'], level: 'beginner', execution: 'x', reason: 'falta' }],
    };
    const nutrition = {
      energy_kcal: 2600, energy_rationale: 'TDEE + superávit', macros: { protein_g: 160, carbs_g: 320, fat_g: 75, rationale: 'x' },
      hydration_liters: 2.8, meals: [{ name: 'Desayuno', timing: '7am', options: [{ description: 'Avena', portion_guide: '1 taza' }] }],
      food_alternatives: [], tracking_guidance: 'x', evidence_used: [], inferences: [], disclaimers: ['orientativo'],
      referral_recommended: false, referral_reason: '',
    };
    let json;
    if (args.schema.properties.training) json = args.schema.properties.nutrition ? { training, nutrition } : { training };
    else if (args.schema.properties.changes) {
      json = { summary: 'Ajuste', rationale: 'progreso', changes: [{ change_type: 'load_increase', day_key: 'A', exercise_id: ids[0], before: '40kg', after: '42.5kg', reason: 'RIR alto' }],
        days: [day('A'), day('B'), day('C')], progression: 'x', recovery: 'x', safety_notes: [], coach_attention: [], evidence_used: evidence, inferences: [], contradictions: [] };
    } else if (args.schema.properties.energy_kcal) json = nutrition;
    else json = { answer: 'Respuesta', findings: ['hallazgo'], suggested_actions: [{ action: 'Revisar', reason: 'x', requires_authorization: true }], data_limitations: [] };
    return { json, usage, model: args.model };
  }
}
