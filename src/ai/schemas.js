// Esquemas de salida de IA.
// - JSON Schema (para salidas estructuradas del proveedor: el modelo está obligado a cumplirlos)
// - Zod (validación propia antes de guardar; nunca se confía ciegamente en la respuesta)
import { z } from '../lib/validate.js';
import { WEEKDAYS } from '../services/assessmentRules.js';

// ---- helpers JSON Schema (todas las propiedades requeridas, sin propiedades adicionales)
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });
const str = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const en = (values) => ({ type: 'string', enum: values });

const evidenceJs = arr(obj({ knowledge_id: str, source_type: en(['scientific', 'empirical']), how_applied: str }));

const dayJs = obj({
  key: str,
  name: str,
  focus: str,
  suggested_weekday: en([...WEEKDAYS, 'any']),
  warmup: str,
  exercises: arr(obj({
    exercise_id: str, sets: int, reps: str, intensity: str, rir_or_rpe: str, rest_seconds: int, notes: str,
  })),
  cooldown: str,
});

export const trainingJs = obj({
  summary: str,
  rationale: str,
  weekly_structure: str,
  duration_weeks: int,
  warmup_protocol: str,
  mobility: str,
  progression: str,
  recovery: str,
  days: arr(dayJs),
  safety_notes: arr(str),
  evidence_used: evidenceJs,
  inferences: arr(str),
  contradictions: arr(str),
  proposed_exercises: arr(obj({
    name: str, primary_muscles: arr(str), equipment: arr(str), level: en(['beginner', 'intermediate', 'advanced']),
    execution: str, reason: str,
  })),
});

export const nutritionJs = obj({
  energy_kcal: int,
  energy_rationale: str,
  macros: obj({ protein_g: int, carbs_g: int, fat_g: int, rationale: str }),
  hydration_liters: num,
  meals: arr(obj({ name: str, timing: str, options: arr(obj({ description: str, portion_guide: str })) })),
  food_alternatives: arr(str),
  tracking_guidance: str,
  evidence_used: evidenceJs,
  inferences: arr(str),
  disclaimers: arr(str),
  referral_recommended: bool,
  referral_reason: str,
});

export const initialJs = (withNutrition) => withNutrition
  ? obj({ training: trainingJs, nutrition: nutritionJs })
  : obj({ training: trainingJs });

export const adjustmentJs = obj({
  summary: str,
  rationale: str,
  changes: arr(obj({
    change_type: en(['load_increase', 'load_decrease', 'volume_change', 'exercise_swap', 'frequency_change',
      'intensity_change', 'rest_change', 'recovery_change', 'deload', 'no_change', 'other']),
    day_key: str, exercise_id: str, before: str, after: str, reason: str,
  })),
  days: arr(dayJs),
  progression: str,
  recovery: str,
  safety_notes: arr(str),
  coach_attention: arr(str),
  evidence_used: evidenceJs,
  inferences: arr(str),
  contradictions: arr(str),
});

export const assistantJs = obj({
  answer: str,
  findings: arr(str),
  suggested_actions: arr(obj({ action: str, reason: str, requires_authorization: bool })),
  data_limitations: arr(str),
});

// ---- Validación Zod (reglas de negocio adicionales a la forma)
const s = (max) => z.string().max(max);
const evidenceZ = z.array(z.object({ knowledge_id: s(64), source_type: z.enum(['scientific', 'empirical']), how_applied: s(1000) })).max(40);
const dayZ = z.object({
  key: s(20).min(1),
  name: s(120),
  focus: s(300),
  suggested_weekday: z.enum([...WEEKDAYS, 'any']),
  warmup: s(1500),
  exercises: z.array(z.object({
    exercise_id: s(64),
    sets: z.number().int().min(1).max(10),
    reps: s(40),
    intensity: s(120),
    rir_or_rpe: s(60),
    rest_seconds: z.number().int().min(0).max(600),
    notes: s(600),
  })).min(1).max(15),
  cooldown: s(1500),
});

export const trainingZ = z.object({
  summary: s(2000), rationale: s(6000), weekly_structure: s(2000), duration_weeks: z.number().int().min(1).max(16),
  warmup_protocol: s(2000), mobility: s(2000), progression: s(3000), recovery: s(2000),
  days: z.array(dayZ).min(1).max(7),
  safety_notes: z.array(s(600)).max(20), evidence_used: evidenceZ, inferences: z.array(s(800)).max(20),
  contradictions: z.array(s(800)).max(20),
  proposed_exercises: z.array(z.object({
    name: s(120).min(2), primary_muscles: z.array(s(60)).max(10), equipment: z.array(s(60)).max(10),
    level: z.enum(['beginner', 'intermediate', 'advanced']), execution: s(3000), reason: s(800),
  })).max(5),
});

export const nutritionZ = z.object({
  energy_kcal: z.number().int().min(1000).max(6000),
  energy_rationale: s(3000),
  macros: z.object({
    protein_g: z.number().int().min(20).max(400), carbs_g: z.number().int().min(0).max(900),
    fat_g: z.number().int().min(20).max(300), rationale: s(3000),
  }),
  hydration_liters: z.number().min(0.5).max(8),
  meals: z.array(z.object({ name: s(80), timing: s(120), options: z.array(z.object({ description: s(600), portion_guide: s(400) })).min(1).max(6) })).min(1).max(8),
  food_alternatives: z.array(s(400)).max(30), tracking_guidance: s(2000), evidence_used: evidenceZ,
  inferences: z.array(s(800)).max(20), disclaimers: z.array(s(800)).max(10),
  referral_recommended: z.boolean(), referral_reason: s(1000),
});

export const adjustmentZ = z.object({
  summary: s(2000), rationale: s(6000),
  changes: z.array(z.object({
    change_type: z.string().max(40), day_key: s(20), exercise_id: s(64), before: s(400), after: s(400), reason: s(1000),
  })).max(60),
  days: z.array(dayZ).min(1).max(7),
  progression: s(3000), recovery: s(2000), safety_notes: z.array(s(600)).max(20),
  coach_attention: z.array(s(600)).max(20), evidence_used: evidenceZ,
  inferences: z.array(s(800)).max(20), contradictions: z.array(s(800)).max(20),
});

export const assistantZ = z.object({
  answer: s(8000), findings: z.array(s(1000)).max(20),
  suggested_actions: z.array(z.object({ action: s(500), reason: s(1000), requires_authorization: z.boolean() })).max(10),
  data_limitations: z.array(s(600)).max(10),
});

// Comprueba que la energía y macros sean coherentes (4/4/9 kcal por gramo, ±15%).
export function macrosConsistent(n) {
  const kcal = n.macros.protein_g * 4 + n.macros.carbs_g * 4 + n.macros.fat_g * 9;
  return Math.abs(kcal - n.energy_kcal) / n.energy_kcal <= 0.15;
}
