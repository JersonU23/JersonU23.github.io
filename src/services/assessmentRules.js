// Reglas de la evaluación inicial: estructura por secciones, datos críticos y señales de alerta.
// Se usan tanto para validar el formulario como para decidir si es seguro generar planes.
import { z } from '../lib/validate.js';

const txt = (max = 500) => z.string().trim().max(max);
const list = (max = 30) => z.array(z.string().trim().min(1).max(120)).max(max);

export const GOALS = ['fat_loss', 'hypertrophy', 'strength', 'endurance', 'recomposition', 'general_health'];
export const EQUIPMENT = ['machines', 'free_weights', 'cables', 'barbell', 'dumbbells', 'kettlebells', 'bands',
  'bodyweight', 'bench', 'rack', 'pullup_bar', 'cardio_machines', 'trx'];
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Esquemas por sección. Todos los campos son opcionales para permitir borradores parciales.
export const SECTION_SCHEMAS = {
  personal: z.object({
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    sex: z.enum(['female', 'male', 'other', 'prefer_not']).optional(),
    weight_kg: z.number().min(25).max(350).optional(),
    height_cm: z.number().min(100).max(250).optional(),
    daily_activity: z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']).optional(),
    occupation_activity: txt(300).optional(),
  }).strict(),
  goals: z.object({
    primary_goal: z.enum(GOALS).optional(),
    secondary_goals: z.array(z.enum(GOALS)).max(5).optional(),
    target_description: txt(500).optional(),
    target_weight_kg: z.number().min(25).max(350).optional(),
  }).strict(),
  experience: z.object({
    level: z.enum(['none', 'beginner', 'intermediate', 'advanced']).optional(),
    months_training: z.number().int().min(0).max(600).optional(),
    current_frequency_per_week: z.number().int().min(0).max(14).optional(),
    history: txt(1000).optional(),
    sports: list().optional(),
  }).strict(),
  // Sección sensible: se guarda cifrada
  health: z.object({
    injuries: txt(1000).optional(),
    has_injuries: z.boolean().optional(),
    pain: txt(1000).optional(),
    surgeries: txt(1000).optional(),
    conditions: txt(1000).optional(),
    has_conditions: z.boolean().optional(),
    medications: txt(1000).optional(),
    takes_medications: z.boolean().optional(),
    limitations: txt(1000).optional(),
    allergies: txt(500).optional(),
    dietary_restrictions: txt(500).optional(),
    // Cribado previo a la actividad física (preguntas tipo PAR-Q). Cualquier "sí" exige autorización médica.
    screening: z.object({
      heart_condition: z.boolean().optional(),
      chest_pain_activity: z.boolean().optional(),
      chest_pain_rest: z.boolean().optional(),
      dizziness_or_fainting: z.boolean().optional(),
      bone_joint_problem: z.boolean().optional(),
      blood_pressure_or_heart_medication: z.boolean().optional(),
      other_reason: z.boolean().optional(),
    }).strict().optional(),
    // Condiciones que requieren derivar la nutrición a un profesional sanitario
    clinical_nutrition: z.object({
      diabetes: z.boolean().optional(),
      kidney_disease: z.boolean().optional(),
      eating_disorder_history: z.boolean().optional(),
      pregnant_or_lactating: z.boolean().optional(),
      severe_food_allergy: z.boolean().optional(),
      other_metabolic: z.boolean().optional(),
    }).strict().optional(),
  }).strict(),
  availability: z.object({
    days: z.array(z.enum(WEEKDAYS)).max(7).optional(),
    preferred_time: z.enum(['morning', 'midday', 'afternoon', 'evening', 'variable']).optional(),
    session_minutes: z.number().int().min(15).max(240).optional(),
  }).strict(),
  equipment: z.object({
    available: z.array(z.enum(EQUIPMENT)).max(EQUIPMENT.length).optional(),
    notes: txt(500).optional(),
  }).strict(),
  habits: z.object({
    sleep_hours: z.number().min(0).max(16).optional(),
    stress_level: z.number().int().min(1).max(10).optional(),
    water_liters: z.number().min(0).max(10).optional(),
    meals_per_day: z.number().int().min(1).max(10).optional(),
    diet_description: txt(1000).optional(),
    food_preferences: txt(500).optional(),
    disliked_foods: txt(500).optional(),
    food_budget: z.enum(['low', 'medium', 'high', 'not_specified']).optional(),
    alcohol: z.enum(['none', 'occasional', 'weekly', 'daily']).optional(),
    smoking: z.boolean().optional(),
    recovery_notes: txt(500).optional(),
  }).strict(),
};

export const STEPS = Object.keys(SECTION_SCHEMAS);

const SCREENING_KEYS = ['heart_condition', 'chest_pain_activity', 'chest_pain_rest', 'dizziness_or_fainting',
  'bone_joint_problem', 'blood_pressure_or_heart_medication', 'other_reason'];
const CLINICAL_KEYS = ['diabetes', 'kidney_disease', 'eating_disorder_history', 'pregnant_or_lactating',
  'severe_food_allergy', 'other_metabolic'];

// Datos sin los cuales no se puede planificar de forma segura.
const CRITICAL = [
  ['personal.birth_date', 'Fecha de nacimiento'],
  ['personal.sex', 'Sexo (necesario para estimar requerimientos energéticos)'],
  ['personal.weight_kg', 'Peso'],
  ['personal.height_cm', 'Estatura'],
  ['personal.daily_activity', 'Actividad cotidiana'],
  ['goals.primary_goal', 'Objetivo principal'],
  ['experience.level', 'Nivel de experiencia'],
  ['health.has_injuries', 'Lesiones (responder sí o no)'],
  ['health.has_conditions', 'Enfermedades relevantes (responder sí o no)'],
  ['health.takes_medications', 'Medicamentos (responder sí o no)'],
  ['availability.days', 'Días disponibles'],
  ['availability.session_minutes', 'Duración de las sesiones'],
  ['equipment.available', 'Equipamiento disponible'],
];

const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function ageFrom(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00Z`);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

// Evalúa completitud y riesgos. full = { ...data, health }
export function evaluateAssessment(full) {
  const missing = [];
  for (const [path, label] of CRITICAL) {
    const v = get(full, path);
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) missing.push({ field: path, label });
  }
  const h = full.health || {};
  if (h.has_injuries && !h.injuries) missing.push({ field: 'health.injuries', label: 'Describe tus lesiones' });
  if (h.has_conditions && !h.conditions) missing.push({ field: 'health.conditions', label: 'Describe las enfermedades' });
  if (h.takes_medications && !h.medications) missing.push({ field: 'health.medications', label: 'Indica los medicamentos' });
  const screening = h.screening || {};
  const unanswered = SCREENING_KEYS.filter((k) => typeof screening[k] !== 'boolean');
  if (unanswered.length) missing.push({ field: 'health.screening', label: 'Completa el cuestionario de salud previo a la actividad' });
  const clinical = h.clinical_nutrition || {};
  if (CLINICAL_KEYS.some((k) => typeof clinical[k] !== 'boolean')) {
    missing.push({ field: 'health.clinical_nutrition', label: 'Completa las preguntas de condiciones clínicas para nutrición' });
  }

  const age = ageFrom(get(full, 'personal.birth_date'));
  if (age !== null && (age < 14 || age > 100)) missing.push({ field: 'personal.birth_date', label: 'Fecha de nacimiento fuera de rango (14–100 años)' });

  const flags = [];
  const screeningYes = SCREENING_KEYS.filter((k) => screening[k] === true);
  if (screeningYes.length) flags.push({ type: 'medical_clearance_required', items: screeningYes,
    message: 'El cuestionario de salud indica que se requiere autorización médica antes de entrenar.' });
  const clinicalYes = CLINICAL_KEYS.filter((k) => clinical[k] === true);
  if (clinicalYes.length) flags.push({ type: 'nutrition_referral_required', items: clinicalYes,
    message: 'Existen condiciones clínicas: el plan nutricional debe ser supervisado por un profesional sanitario o nutricionista.' });
  if (age !== null && age < 18) flags.push({ type: 'minor', message: 'Deportista menor de edad: requiere consentimiento y supervisión.' });

  return { missing, flags, age };
}

// Requerimiento energético estimado (Mifflin-St Jeor, 1990) × factor de actividad.
// Es una estimación de referencia; la IA y el entrenador pueden ajustarla con justificación.
const ACTIVITY_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
export function estimateEnergy({ sex, weight_kg: w, height_cm: h, age, daily_activity: act }) {
  if (!w || !h || !age || !act) return null;
  const base = 10 * w + 6.25 * h - 5 * age;
  // Para "otro / prefiero no decir" se usa el promedio de ambas fórmulas y se indica la incertidumbre.
  const bmr = sex === 'male' ? base + 5 : sex === 'female' ? base - 161 : base - 78;
  const tdee = bmr * ACTIVITY_FACTORS[act];
  return {
    method: 'Mifflin-St Jeor × factor de actividad',
    bmr_kcal: Math.round(bmr),
    tdee_kcal: Math.round(tdee),
    activity_factor: ACTIVITY_FACTORS[act],
    uncertain: !['male', 'female'].includes(sex),
  };
}
