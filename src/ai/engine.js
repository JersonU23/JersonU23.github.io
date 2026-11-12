// Motor de IA: aplica reglas de seguridad y cuotas, construye el contexto mínimo, llama a la IA (vía runAI)
// y guarda las propuestas como planes "pendientes de revisión" del entrenador.
import { one, many, tx } from '../db/pool.js';
import { HttpError, conflict, unprocessable, tooMany, notFound } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { assertStaffAccess } from '../middleware/auth.js';
import { latestAssessment } from '../routes/assessments.js';
import { evaluateAssessment, estimateEnergy } from '../services/assessmentRules.js';
import { retrieveKnowledge, termsForProfile, formatKnowledge, toTerms } from '../services/knowledge.js';
import { periodSummary } from '../services/progress.js';
import { dashboardMetrics } from '../services/dashboard.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import { runAI, getSettings, usageSummary } from './usage.js';
import * as P from './prompts.js';
import * as S from './schemas.js';

const MAX_INITIAL_GENERATIONS = 3;
const MIN_LIBRARY_SIZE = 8;

// ---------- Contexto del deportista (minimización de datos) ----------
// No se envían nombre, correo, teléfono, fecha de nacimiento exacta ni respuestas crudas del cribado.
export function buildProfile(data, age, { includeNutritionData }) {
  const h = data.health || {};
  const profile = {
    age, sex: data.personal?.sex, weight_kg: data.personal?.weight_kg, height_cm: data.personal?.height_cm,
    daily_activity: data.personal?.daily_activity,
    goals: data.goals || {},
    experience: data.experience || {},
    health: {
      injuries: h.has_injuries ? h.injuries : 'ninguna declarada',
      pain: h.pain || 'ninguno declarado',
      surgeries: h.surgeries || 'ninguna declarada',
      relevant_conditions: h.has_conditions ? h.conditions : 'ninguna declarada',
      medications: h.takes_medications ? h.medications : 'ninguno',
      limitations: h.limitations || 'ninguna declarada',
    },
    availability: data.availability || {},
    equipment: data.equipment || {},
    habits: { ...(data.habits || {}) },
  };
  if (includeNutritionData) {
    profile.nutrition = { allergies: h.allergies || 'ninguna declarada', dietary_restrictions: h.dietary_restrictions || 'ninguna' };
  } else {
    for (const k of ['diet_description', 'food_preferences', 'disliked_foods', 'food_budget']) delete profile.habits[k];
  }
  return profile;
}

const restrictionsHash = (h = {}) => sha256(JSON.stringify([h.allergies || '', h.dietary_restrictions || '', h.clinical_nutrition || {}]));

async function activeLibrary(gymId) {
  return many(`SELECT id, name, primary_muscles, equipment, level, contraindications FROM exercises
                WHERE gym_id = $1 AND status = 'active' ORDER BY name`, [gymId]);
}

// Elimina ejercicios que no existen en la biblioteca y cita solo conocimiento entregado.
function sanitizeDays(days, libraryIds, warnings) {
  for (const d of days) {
    const before = d.exercises.length;
    d.exercises = d.exercises.filter((e) => libraryIds.has(e.exercise_id));
    if (d.exercises.length !== before) warnings.push(`Día ${d.key}: se descartaron ${before - d.exercises.length} ejercicio(s) fuera de la biblioteca`);
    if (!d.exercises.length) throw new Error(`El día ${d.key} quedó sin ejercicios válidos de la biblioteca`);
  }
  const keys = days.map((d) => d.key);
  if (new Set(keys).size !== keys.length) throw new Error('Claves de día duplicadas');
}
function sanitizeEvidence(evidence, knowledgeIds, warnings) {
  const valid = evidence.filter((e) => knowledgeIds.has(e.knowledge_id));
  if (valid.length !== evidence.length) warnings.push(`Se descartaron ${evidence.length - valid.length} cita(s) a conocimiento no proporcionado`);
  return valid;
}

async function nextVersion(db, table, athleteId) {
  const { rows: [r] } = await db.query(`SELECT COALESCE(max(version),0) + 1 AS v FROM ${table} WHERE athlete_id = $1`, [athleteId]);
  return r.v;
}

async function saveCitations(db, requestId, evidence, knowledge) {
  const byId = new Map(knowledge.map((k) => [k.id, k]));
  for (const e of evidence) {
    const k = byId.get(e.knowledge_id);
    if (!k) continue;
    await db.query(`INSERT INTO ai_citations (ai_request_id, entry_id, entry_version, usage_note) VALUES ($1,$2,$3,$4)
                    ON CONFLICT DO NOTHING`, [requestId, k.id, k.version, e.how_applied.slice(0, 1000)]);
  }
}

async function loadAssessmentForPlanning(athlete) {
  const a = await latestAssessment(athlete.id, { submittedOnly: true });
  if (!a) throw unprocessable('El deportista aún no ha enviado su evaluación inicial', 'assessment_missing');
  const ev = evaluateAssessment(a.data);
  if (ev.missing.length) throw unprocessable('Faltan datos críticos para una planificación segura', 'missing_critical', ev.missing);
  const needsMedical = ev.flags.some((f) => f.type === 'medical_clearance_required' || f.type === 'minor');
  if (needsMedical && !athlete.medical_clearance) {
    throw unprocessable('La evaluación indica que se requiere autorización médica (o consentimiento si es menor) antes de planificar. Regístrala en el perfil del deportista.',
      'medical_clearance_required', ev.flags);
  }
  const needsNutritionReferral = ev.flags.some((f) => f.type === 'nutrition_referral_required');
  return { assessment: a, evaluation: ev, needsNutritionReferral };
}

// ---------- 1) Generación inicial (entrenamiento + nutrición en una sola solicitud) ----------
export async function generateInitial(req, athleteId, { includeNutrition = true } = {}) {
  const athlete = await assertStaffAccess(req.user, athleteId);
  const { assessment, evaluation, needsNutritionReferral } = await loadAssessmentForPlanning(athlete);

  const existing = await one(`SELECT status FROM training_plans WHERE athlete_id = $1 AND status IN ('pending_review','active') LIMIT 1`, [athleteId]);
  if (existing?.status === 'pending_review') throw conflict('Ya hay un plan pendiente de revisión. Apruébalo o recházalo primero.', 'plan_pending');
  if (existing?.status === 'active') throw conflict('El deportista ya tiene un plan activo. Usa el ajuste quincenal.', 'plan_active');
  const { n: generated } = await one(`SELECT count(*)::int AS n FROM ai_requests WHERE athlete_id = $1
                                       AND operation = 'initial_generation' AND status = 'succeeded'`, [athleteId]);
  if (generated >= MAX_INITIAL_GENERATIONS) throw tooMany(`Límite de ${MAX_INITIAL_GENERATIONS} generaciones iniciales alcanzado para este deportista. Planifica manualmente.`, 'initial_limit');

  // Nutrición: solo si no hay condiciones clínicas, o si un profesional ya autorizó.
  const withNutrition = includeNutrition && (!needsNutritionReferral || athlete.nutrition_clearance);
  const nutritionNote = needsNutritionReferral && !athlete.nutrition_clearance
    ? 'El deportista presenta condiciones clínicas: la nutrición debe derivarse a un profesional sanitario.' : '';

  const library = await activeLibrary(athlete.gym_id);
  if (library.length < MIN_LIBRARY_SIZE) {
    throw unprocessable(`La biblioteca tiene ${library.length} ejercicios activos; se necesitan al menos ${MIN_LIBRARY_SIZE} para generar rutinas.`, 'library_too_small');
  }
  const profile = buildProfile(assessment.data, evaluation.age, { includeNutritionData: withNutrition });
  const energy = estimateEnergy({ ...assessment.data.personal, age: evaluation.age });
  const knowledge = await retrieveKnowledge(athlete.gym_id, termsForProfile(profile));
  // Retroalimentación de planes rechazados previamente (para no repetir la misma propuesta)
  const rejections = await many(`SELECT review_notes FROM training_plans WHERE athlete_id = $1 AND status = 'rejected'
                                  AND review_notes IS NOT NULL ORDER BY created_at DESC LIMIT 3`, [athleteId]);
  const feedback = rejections.map((r) => r.review_notes).join(' | ');

  const libraryIds = new Set(library.map((e) => e.id));
  const knowledgeIds = new Set(knowledge.map((k) => k.id));
  const userPrompt = P.initialUserPrompt({ profile, energy, knowledge: formatKnowledge(knowledge), withNutrition, nutritionNote })
    + (feedback ? `\n\nMOTIVOS DE RECHAZO DE PROPUESTAS ANTERIORES (corrígelos):\n${feedback}` : '');

  const result = await runAI({
    gymId: athlete.gym_id, athleteId, userId: req.user.id, operation: 'initial_generation',
    hashPayload: { assessmentId: assessment.id, updated: assessment.updated_at, profile, withNutrition, feedback,
      library: [...libraryIds].sort(), knowledge: knowledge.map((k) => `${k.id}:${k.version}`) },
    prompt: {
      system: P.systemPrompt({ library: P.formatLibrary(library), withNutrition }),
      user: userPrompt,
      schema: S.initialJs(withNutrition),
      maxTokens: 48000,
    },
    validate: (json) => {
      const warnings = [];
      const training = S.trainingZ.parse(json.training);
      sanitizeDays(training.days, libraryIds, warnings);
      training.evidence_used = sanitizeEvidence(training.evidence_used, knowledgeIds, warnings);
      let nutrition = null;
      if (withNutrition) {
        nutrition = S.nutritionZ.parse(json.nutrition);
        if (!S.macrosConsistent(nutrition)) warnings.push('Las calorías no coinciden con los macronutrientes (±15%): revisar');
        nutrition.evidence_used = sanitizeEvidence(nutrition.evidence_used, knowledgeIds, warnings);
      }
      return { training, nutrition, warnings };
    },
  });

  const { training, nutrition, warnings } = result.output;
  const saved = await tx(async (db) => {
    const tv = await nextVersion(db, 'training_plans', athleteId);
    const { rows: [tp] } = await db.query(
      `INSERT INTO training_plans (gym_id, athlete_id, version, status, source, content, rationale, ai_request_id, created_by)
       VALUES ($1,$2,$3,'pending_review','ai_initial',$4,$5,$6,$7) RETURNING id, version, status`,
      [athlete.gym_id, athleteId, tv, JSON.stringify({ ...training, warnings }), training.rationale, result.requestId, req.user.id]);
    let np = null;
    if (nutrition) {
      const nv = await nextVersion(db, 'nutrition_plans', athleteId);
      ({ rows: [np] } = await db.query(
        `INSERT INTO nutrition_plans (gym_id, athlete_id, version, status, source, content, rationale, baseline, ai_request_id, created_by)
         VALUES ($1,$2,$3,'pending_review','ai_initial',$4,$5,$6,$7,$8) RETURNING id, version, status`,
        [athlete.gym_id, athleteId, nv, JSON.stringify({ ...nutrition, energy_estimate: energy }), nutrition.energy_rationale,
          JSON.stringify({ weight_kg: assessment.data.personal.weight_kg, primary_goal: assessment.data.goals.primary_goal,
            restrictions: restrictionsHash(assessment.data.health) }), result.requestId, req.user.id]));
    }
    if (!result.reused) {
      await saveCitations(db, result.requestId, [...training.evidence_used, ...(nutrition?.evidence_used || [])], knowledge);
      for (const pe of training.proposed_exercises) {
        await db.query(
          `INSERT INTO exercises (gym_id, name, primary_muscles, equipment, level, execution, status, source)
           VALUES ($1,$2,$3,$4,$5,$6,'proposed','ai_proposed') ON CONFLICT (gym_id, name) DO NOTHING`,
          [athlete.gym_id, pe.name, pe.primary_muscles, pe.equipment, pe.level, `${pe.execution}\n\nMotivo de la propuesta: ${pe.reason}`]);
      }
    }
    await audit(req, 'ai.initial_generation', 'user', athleteId, { ai_request_id: result.requestId, reused: result.reused }, db);
    if (athlete.coach_id && athlete.coach_id !== req.user.id) {
      await notify(db, { gymId: athlete.gym_id, userId: athlete.coach_id, kind: 'plan_review',
        title: `Plan inicial de ${athlete.full_name} listo para revisión`, link: `#/athlete/${athleteId}` });
    }
    return { training_plan: tp, nutrition_plan: np };
  });
  return { ...saved, ai_request_id: result.requestId, reused: result.reused, warnings,
    nutrition_referral: needsNutritionReferral && !athlete.nutrition_clearance };
}

// ---------- Cuotas de ajuste ----------
export async function adjustmentQuota(athleteId, gymId) {
  const settings = await getSettings(gymId);
  const { used } = await one(
    `SELECT count(*)::int AS used FROM ai_requests a JOIN gyms g ON g.id = a.gym_id
      WHERE a.athlete_id = $1 AND a.operation = 'biweekly_adjustment' AND a.status IN ('succeeded','reused','pending')
        AND a.created_at >= date_trunc('month', now() AT TIME ZONE g.timezone) AT TIME ZONE g.timezone`, [athleteId]);
  const plan = await one(`SELECT activated_at FROM training_plans WHERE athlete_id = $1 AND status = 'active'`, [athleteId]);
  const last = await one(`SELECT max(created_at) AS at FROM ai_requests WHERE athlete_id = $1 AND operation = 'biweekly_adjustment'
                           AND status IN ('succeeded','reused')`, [athleteId]);
  const ref = [plan?.activated_at, last?.at].filter(Boolean).map((d) => new Date(d).getTime());
  const since = ref.length ? Math.max(...ref) : null;
  const nextAt = since ? new Date(since + settings.min_days_between_adjustments * 86400000) : null;
  return {
    used, max: settings.max_adjustments_per_month, remaining: Math.max(0, settings.max_adjustments_per_month - used),
    min_days: settings.min_days_between_adjustments, next_available_at: nextAt,
    available: Boolean(plan) && used < settings.max_adjustments_per_month && (!nextAt || nextAt <= new Date()),
    has_active_plan: Boolean(plan), reference_date: since ? new Date(since) : null,
  };
}

// ---------- 2) Ajuste quincenal del entrenamiento ----------
export async function biweeklyAdjustment(req, athleteId, { request = '' } = {}) {
  const athlete = await assertStaffAccess(req.user, athleteId);
  const plan = await one(`SELECT * FROM training_plans WHERE athlete_id = $1 AND status = 'active'`, [athleteId]);
  if (!plan) throw unprocessable('El deportista no tiene un plan activo', 'no_active_plan');
  const pending = await one(`SELECT 1 FROM training_plans WHERE athlete_id = $1 AND status = 'pending_review'`, [athleteId]);
  if (pending) throw conflict('Hay un plan pendiente de revisión. Resuélvelo antes de solicitar otro ajuste.', 'plan_pending');
  const quota = await adjustmentQuota(athleteId, athlete.gym_id);
  if (quota.used >= quota.max) throw tooMany(`Se alcanzó el máximo de ${quota.max} ajustes este mes para el deportista.`, 'adjustment_limit', quota);
  if (quota.next_available_at && quota.next_available_at > new Date()) {
    throw tooMany(`El próximo ajuste estará disponible el ${quota.next_available_at.toISOString().slice(0, 10)} (mínimo ${quota.min_days} días entre ajustes).`, 'adjustment_too_soon', quota);
  }
  const days = Math.min(30, Math.max(quota.min_days, Math.round((Date.now() - quota.reference_date) / 86400000)));
  const summary = await periodSummary(athleteId, { days });
  if (summary.sessions.done < 2) {
    throw unprocessable('Datos insuficientes: se necesitan al menos 2 sesiones registradas en el periodo para un ajuste fundamentado.', 'insufficient_data');
  }
  const { assessment, evaluation } = await loadAssessmentForPlanning(athlete);
  const profile = buildProfile(assessment.data, evaluation.age, { includeNutritionData: false });
  const lastWeight = await one(`SELECT weight_kg FROM body_measurements WHERE athlete_id = $1 AND weight_kg IS NOT NULL ORDER BY measured_on DESC LIMIT 1`, [athleteId]);
  if (lastWeight) profile.weight_kg = lastWeight.weight_kg;
  const notes = await many(`SELECT created_at::date AS date, body FROM coach_notes WHERE athlete_id = $1 AND created_at > now() - ($2 || ' days')::interval
                            ORDER BY created_at DESC LIMIT 10`, [athleteId, String(days)]);
  const library = await activeLibrary(athlete.gym_id);
  const libraryIds = new Set(library.map((e) => e.id));
  const knowledge = await retrieveKnowledge(athlete.gym_id, [...termsForProfile(profile), ...toTerms(summary.wellness.pains.map((p) => p.pain_location).join(' '))]);
  const knowledgeIds = new Set(knowledge.map((k) => k.id));
  const currentPlan = { days: plan.content.days, progression: plan.content.progression, recovery: plan.content.recovery, duration_weeks: plan.content.duration_weeks };

  const result = await runAI({
    gymId: athlete.gym_id, athleteId, userId: req.user.id, operation: 'biweekly_adjustment',
    hashPayload: { planId: plan.id, summary, request, notes, knowledge: knowledge.map((k) => `${k.id}:${k.version}`) },
    prompt: {
      system: P.systemPrompt({ library: P.formatLibrary(library), withNutrition: false }),
      user: P.adjustmentUserPrompt({ profile, currentPlan, summary, request,
        coachNotes: notes.map((n) => `${n.date}: ${n.body}`).join('\n'), knowledge: formatKnowledge(knowledge) }),
      schema: S.adjustmentJs,
      maxTokens: 40000,
    },
    validate: (json) => {
      const warnings = [];
      const adj = S.adjustmentZ.parse(json);
      sanitizeDays(adj.days, libraryIds, warnings);
      adj.evidence_used = sanitizeEvidence(adj.evidence_used, knowledgeIds, warnings);
      return { ...adj, warnings };
    },
  });

  const adj = result.output;
  const saved = await tx(async (db) => {
    const v = await nextVersion(db, 'training_plans', athleteId);
    const content = { ...plan.content, days: adj.days, progression: adj.progression, recovery: adj.recovery,
      summary: adj.summary, safety_notes: adj.safety_notes, coach_attention: adj.coach_attention,
      evidence_used: adj.evidence_used, inferences: adj.inferences, contradictions: adj.contradictions,
      warnings: adj.warnings, period_summary: summary };
    const { rows: [tp] } = await db.query(
      `INSERT INTO training_plans (gym_id, athlete_id, version, status, source, content, rationale, change_summary, ai_request_id, parent_plan_id, created_by)
       VALUES ($1,$2,$3,'pending_review','ai_adjustment',$4,$5,$6,$7,$8,$9) RETURNING id, version, status`,
      [athlete.gym_id, athleteId, v, JSON.stringify(content), adj.rationale, JSON.stringify(adj.changes), result.requestId, plan.id, req.user.id]);
    if (!result.reused) await saveCitations(db, result.requestId, adj.evidence_used, knowledge);
    await audit(req, 'ai.biweekly_adjustment', 'user', athleteId, { ai_request_id: result.requestId, reused: result.reused }, db);
    return tp;
  });
  return { training_plan: saved, changes: adj.changes, ai_request_id: result.requestId, reused: result.reused, warnings: adj.warnings };
}

// ---------- 3) Actualización nutricional (solo con cambios relevantes) ----------
export async function nutritionRelevantChanges(athleteId, gymId, coachReason = '') {
  const settings = await getSettings(gymId);
  const plan = await one(`SELECT * FROM nutrition_plans WHERE athlete_id = $1 AND status = 'active'`, [athleteId]);
  if (!plan) return { plan: null, reasons: [] };
  const a = await latestAssessment(athleteId, { submittedOnly: true });
  const base = plan.baseline || {};
  const reasons = [];
  const w = await one(`SELECT weight_kg, measured_on FROM body_measurements WHERE athlete_id = $1 AND weight_kg IS NOT NULL
                        AND measured_on >= $2::date ORDER BY measured_on DESC LIMIT 1`, [athleteId, plan.activated_at || plan.created_at]);
  if (w && base.weight_kg) {
    const pct = ((w.weight_kg - base.weight_kg) / base.weight_kg) * 100;
    if (Math.abs(pct) >= Number(settings.nutrition_weight_change_pct)) {
      reasons.push(`Cambio de peso de ${base.weight_kg} kg a ${w.weight_kg} kg (${pct.toFixed(1)}%), supera el umbral de ${settings.nutrition_weight_change_pct}%`);
    }
  }
  if (a && base.primary_goal && a.data.goals?.primary_goal !== base.primary_goal) {
    reasons.push(`Cambio de objetivo principal: ${base.primary_goal} → ${a.data.goals.primary_goal}`);
  }
  if (a && base.restrictions && restrictionsHash(a.data.health) !== base.restrictions) {
    reasons.push('Cambios en alergias, restricciones alimentarias o condiciones clínicas');
  }
  if (coachReason && coachReason.trim().length >= 20) reasons.push(`Justificación del entrenador: ${coachReason.trim()}`);
  return { plan, reasons, current_weight: w?.weight_kg ?? null, assessment: a };
}

export async function nutritionUpdate(req, athleteId, { reason = '' } = {}) {
  const athlete = await assertStaffAccess(req.user, athleteId);
  const { plan, reasons, current_weight: currentWeight } = await nutritionRelevantChanges(athleteId, athlete.gym_id, reason);
  if (!plan) throw unprocessable('No hay plan nutricional activo para actualizar', 'no_active_plan');
  if (!reasons.length) {
    throw unprocessable('No hay cambios relevantes que justifiquen actualizar el plan nutricional (peso, objetivo, restricciones o justificación del entrenador de al menos 20 caracteres).', 'no_relevant_change');
  }
  const pending = await one(`SELECT 1 FROM nutrition_plans WHERE athlete_id = $1 AND status = 'pending_review'`, [athleteId]);
  if (pending) throw conflict('Hay un plan nutricional pendiente de revisión', 'plan_pending');
  const { assessment, evaluation, needsNutritionReferral } = await loadAssessmentForPlanning(athlete);
  if (needsNutritionReferral && !athlete.nutrition_clearance) {
    throw unprocessable('Existen condiciones clínicas: la nutrición debe derivarse a un profesional sanitario.', 'nutrition_referral_required');
  }
  const profile = buildProfile(assessment.data, evaluation.age, { includeNutritionData: true });
  if (currentWeight) profile.weight_kg = currentWeight;
  const energy = estimateEnergy({ ...assessment.data.personal, weight_kg: profile.weight_kg, age: evaluation.age });
  const summary = await periodSummary(athleteId, { days: 30 });
  const knowledge = await retrieveKnowledge(athlete.gym_id, termsForProfile(profile));
  const knowledgeIds = new Set(knowledge.map((k) => k.id));
  const { evidence_used: _e, ...currentPlan } = plan.content;

  const result = await runAI({
    gymId: athlete.gym_id, athleteId, userId: req.user.id, operation: 'nutrition_update',
    hashPayload: { planId: plan.id, reasons, profile, knowledge: knowledge.map((k) => `${k.id}:${k.version}`) },
    prompt: {
      system: P.systemPrompt({ library: 'No aplica a esta tarea.', withNutrition: true }),
      user: P.nutritionUpdateUserPrompt({ profile, energy, currentPlan, reasons,
        summary: { body: summary.body, nutrition_adherence: summary.nutrition_adherence, training_sessions: summary.sessions },
        knowledge: formatKnowledge(knowledge) }),
      schema: S.nutritionJs,
      maxTokens: 24000,
    },
    validate: (json) => {
      const warnings = [];
      const n = S.nutritionZ.parse(json);
      if (!S.macrosConsistent(n)) warnings.push('Las calorías no coinciden con los macronutrientes (±15%): revisar');
      n.evidence_used = sanitizeEvidence(n.evidence_used, knowledgeIds, warnings);
      return { ...n, warnings };
    },
  });

  const n = result.output;
  const saved = await tx(async (db) => {
    const v = await nextVersion(db, 'nutrition_plans', athleteId);
    const { rows: [np] } = await db.query(
      `INSERT INTO nutrition_plans (gym_id, athlete_id, version, status, source, content, rationale, update_reason, baseline, ai_request_id, parent_plan_id, created_by)
       VALUES ($1,$2,$3,'pending_review','ai_update',$4,$5,$6,$7,$8,$9,$10) RETURNING id, version, status`,
      [athlete.gym_id, athleteId, v, JSON.stringify({ ...n, energy_estimate: energy }), n.energy_rationale, reasons.join('\n'),
        JSON.stringify({ weight_kg: profile.weight_kg, primary_goal: assessment.data.goals.primary_goal, restrictions: restrictionsHash(assessment.data.health) }),
        result.requestId, plan.id, req.user.id]);
    if (!result.reused) await saveCitations(db, result.requestId, n.evidence_used, knowledge);
    await audit(req, 'ai.nutrition_update', 'user', athleteId, { ai_request_id: result.requestId, reasons: reasons.length }, db);
    return np;
  });
  return { nutrition_plan: saved, reasons, ai_request_id: result.requestId, reused: result.reused, warnings: n.warnings };
}

// ---------- 4) Asistente administrativo (solo lectura, datos agregados) ----------
export async function adminAssistant(req, question) {
  const gymId = req.user.gym_id;
  const settings = await getSettings(gymId);
  const { n: today } = await one(
    `SELECT count(*)::int AS n FROM ai_requests a JOIN gyms g ON g.id = a.gym_id WHERE a.gym_id = $1 AND a.operation = 'admin_assistant'
        AND a.status IN ('succeeded','pending') AND a.created_at >= date_trunc('day', now() AT TIME ZONE g.timezone) AT TIME ZONE g.timezone`, [gymId]);
  if (today >= settings.assistant_daily_limit) throw tooMany(`Límite diario del asistente alcanzado (${settings.assistant_daily_limit} consultas).`, 'assistant_limit');

  const metrics = await dashboardMetrics(gymId);
  const usage = await usageSummary(gymId);
  // Informe agregado: sin nombres ni datos personales de deportistas.
  const report = {
    fecha: new Date().toISOString().slice(0, 10),
    indicadores: { ...metrics, alerts: metrics.alerts.map((a) => ({ level: a.level, type: a.type })),
      biweekly_reviews_due_list: undefined },
    consumo_ia_mes: { costo_usd: usage.month.cost, presupuesto_usd: usage.budget_usd, solicitudes_ok: usage.month.succeeded,
      reutilizadas: usage.month.reused, fallidas: usage.month.failed, bloqueadas: usage.month.blocked,
      costo_por_deportista_activo: usage.cost_per_active_athlete, por_operacion: usage.by_operation, historial: usage.history },
    configuracion: { nivel: settings.config_level, modelo: settings.ai_model, esfuerzo: settings.ai_effort,
      ajustes_max_mes: settings.max_adjustments_per_month, dias_minimos_entre_ajustes: settings.min_days_between_adjustments,
      umbral_alerta: Number(settings.ai_alert_threshold), umbral_cambio_peso_nutricion_pct: Number(settings.nutrition_weight_change_pct),
      cuota_mensual_usd: settings.monthly_fee_usd, margen_objetivo: Number(settings.target_margin), costos_operativos: settings.operating_costs },
  };
  const result = await runAI({
    gymId, userId: req.user.id, operation: 'admin_assistant',
    // Misma pregunta el mismo día con los mismos indicadores → se reutiliza la respuesta.
    // (El consumo de IA se excluye de la clave porque cambia con cada consulta.)
    hashPayload: { question: question.toLowerCase().replace(/\s+/g, ' '), day: report.fecha, indicadores: { ...report.indicadores, ai: undefined }, configuracion: report.configuracion },
    prompt: { system: P.ASSISTANT_SYSTEM, user: `INFORME DE DATOS:\n${JSON.stringify(report, null, 1)}\n\nPREGUNTA DEL ADMINISTRADOR:\n${question}`,
      schema: S.assistantJs, maxTokens: 12000 },
    validate: (json) => S.assistantZ.parse(json),
  });
  await audit(req, 'ai.admin_assistant', 'ai_request', result.requestId, { reused: result.reused });
  return { ...result.output, ai_request_id: result.requestId, reused: result.reused };
}

export { HttpError, notFound };
