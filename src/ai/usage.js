// Medición y control de consumo de IA: presupuesto, deduplicación, registro de tokens y costos.
import { one, query, many } from '../db/pool.js';
import { sha256, canonicalJson } from '../lib/crypto.js';
import { HttpError, conflict, unavailable } from '../lib/errors.js';
import { computeCost, priceFor } from './pricing.js';
import { getProvider, AIProviderError } from './provider.js';
import { notifyRole } from '../services/notifications.js';

const REUSE_DAYS = 30;

export async function getSettings(gymId) {
  let s = await one('SELECT * FROM gym_settings WHERE gym_id = $1', [gymId]);
  if (!s) {
    await query('INSERT INTO gym_settings (gym_id) VALUES ($1) ON CONFLICT DO NOTHING', [gymId]);
    s = await one('SELECT * FROM gym_settings WHERE gym_id = $1', [gymId]);
  }
  return s;
}

// Mes en la zona horaria del gimnasio
const MONTH_START = `date_trunc('month', now() AT TIME ZONE g.timezone) AT TIME ZONE g.timezone`;

export async function monthSpend(gymId) {
  const r = await one(
    `SELECT COALESCE(sum(a.cost_usd),0)::float AS spent, count(*) FILTER (WHERE a.status IN ('succeeded','refused','failed'))::int AS calls
       FROM ai_requests a JOIN gyms g ON g.id = a.gym_id
      WHERE a.gym_id = $1 AND a.created_at >= ${MONTH_START}`, [gymId]);
  return r;
}

export function requestHash(payload) {
  return sha256(canonicalJson(payload));
}

/**
 * Ejecuta una operación de IA con todos los controles:
 * 1) IA habilitada y proveedor configurado  2) presupuesto mensual  3) reutiliza respuestas idénticas
 * 4) bloquea duplicados simultáneos  5) registra tokens, costo y latencia.
 * Devuelve { requestId, output, reused }.
 */
export async function runAI({ gymId, athleteId = null, userId, operation, hashPayload, prompt, validate }) {
  const settings = await getSettings(gymId);
  if (!settings.ai_enabled) throw new HttpError(403, 'La IA está deshabilitada en la configuración del gimnasio', 'ai_disabled');
  const model = settings.ai_model;
  const hash = requestHash({ operation, athleteId, model, ...hashPayload });

  // Reutilización: misma entrada exacta ya respondida recientemente → no se vuelve a pagar.
  const prev = await one(
    `SELECT id, response FROM ai_requests WHERE request_hash = $1 AND status = 'succeeded'
       AND created_at > now() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT 1`, [hash, String(REUSE_DAYS)]);
  if (prev) {
    const { rows: [row] } = await query(
      `INSERT INTO ai_requests (gym_id, athlete_id, operation, status, model, request_hash, reused_from, response, created_by, completed_at)
       VALUES ($1,$2,$3,'reused',$4,$5,$6,$7,$8,now()) RETURNING id`,
      [gymId, athleteId, operation, model, `${hash}:reuse:${Date.now()}`, prev.id, prev.response, userId]);
    return { requestId: row.id, sourceRequestId: prev.id, output: prev.response, reused: true };
  }

  const provider = getProvider();
  if (!provider) throw unavailable('IA no configurada: falta ANTHROPIC_API_KEY en el servidor', 'ai_not_configured');

  const { spent } = await monthSpend(gymId);
  if (spent >= Number(settings.ai_monthly_budget_usd)) {
    await query(
      `INSERT INTO ai_requests (gym_id, athlete_id, operation, status, model, request_hash, error, created_by, completed_at)
       VALUES ($1,$2,$3,'blocked',$4,$5,'Presupuesto mensual agotado',$6,now())`,
      [gymId, athleteId, operation, model, `${hash}:blocked:${Date.now()}`, userId]);
    await checkBudgetAlerts(gymId, settings);
    throw new HttpError(402, `Presupuesto mensual de IA agotado (USD ${spent.toFixed(2)} de ${settings.ai_monthly_budget_usd}).`, 'budget_exhausted');
  }

  // Solicitudes pendientes huérfanas (p. ej. reinicio del servidor durante una llamada) se marcan como fallidas.
  await query(`UPDATE ai_requests SET status = 'failed', error = 'Expirada (sin respuesta)', completed_at = now()
                WHERE status = 'pending' AND created_at < now() - interval '20 minutes'`);

  let requestId;
  try {
    ({ rows: [{ id: requestId }] } = await query(
      `INSERT INTO ai_requests (gym_id, athlete_id, operation, status, model, request_hash, created_by)
       VALUES ($1,$2,$3,'pending',$4,$5,$6) RETURNING id`, [gymId, athleteId, operation, model, hash, userId]));
  } catch (err) {
    if (err.code === '23505') throw conflict('Ya hay una solicitud idéntica en proceso. Espera a que termine.', 'duplicate_in_progress');
    throw err;
  }

  const started = Date.now();
  const pricingOverrides = settings.ai_pricing || {};
  const finish = async (status, { usage = {}, servedModel = null, response = null, error = null }) => {
    const price = priceFor(servedModel || model, pricingOverrides);
    const cost = computeCost(usage, price);
    await query(
      `UPDATE ai_requests SET status = $2, served_model = $3, input_tokens = $4, output_tokens = $5,
              cache_read_tokens = $6, cache_write_tokens = $7, cost_usd = $8, price_snapshot = $9,
              latency_ms = $10, response = $11, error = $12, completed_at = now() WHERE id = $1`,
      [requestId, status, servedModel, usage.input_tokens || 0, usage.output_tokens || 0,
        usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, cost,
        price ? JSON.stringify({ model: servedModel || model, ...price }) : null, Date.now() - started,
        response ? JSON.stringify(response) : null, error]);
    await checkBudgetAlerts(gymId, settings);
    return cost;
  };

  let result;
  try {
    result = await provider.generateJson({ model, effort: settings.ai_effort, ...prompt });
  } catch (err) {
    const isProv = err instanceof AIProviderError;
    await finish(isProv && err.kind === 'refusal' ? 'refused' : 'failed', {
      usage: isProv ? err.usage || {} : {}, servedModel: isProv ? err.model : null, error: String(err.message).slice(0, 1000) });
    if (isProv && err.kind === 'refusal') throw new HttpError(422, 'La IA declinó generar esta respuesta. Revisa los datos o planifica manualmente.', 'ai_refused');
    throw new HttpError(502, err.message, 'ai_failed');
  }

  let output;
  try {
    output = validate ? validate(result.json) : result.json;
  } catch (err) {
    await finish('failed', { usage: result.usage, servedModel: result.model, response: result.json, error: `Validación: ${err.message}`.slice(0, 1000) });
    throw new HttpError(502, `La respuesta de IA no superó la validación: ${err.message}`, 'ai_invalid_output');
  }
  const cost = await finish('succeeded', { usage: result.usage, servedModel: result.model, response: output });
  return { requestId, sourceRequestId: requestId, output, reused: false, cost, usage: result.usage };
}

// Avisa a los administradores al superar el umbral y al agotar el presupuesto (una vez por mes y nivel).
export async function checkBudgetAlerts(gymId, settings) {
  const { spent } = await monthSpend(gymId);
  const budget = Number(settings.ai_monthly_budget_usd);
  if (!budget) return;
  const month = new Date().toISOString().slice(0, 7);
  const ratio = spent / budget;
  if (ratio >= 1) {
    await notifyRole(null, gymId, 'admin', { kind: 'ai_budget', title: 'Presupuesto de IA agotado',
      body: `Consumo del mes: USD ${spent.toFixed(2)} de ${budget.toFixed(2)}. Las nuevas solicitudes se bloquearán.`,
      link: '#/ai', dedupeKey: `ai_budget_100_${month}` });
  } else if (ratio >= Number(settings.ai_alert_threshold)) {
    await notifyRole(null, gymId, 'admin', { kind: 'ai_budget', title: 'Alerta de presupuesto de IA',
      body: `Se consumió el ${Math.round(ratio * 100)}% del presupuesto mensual (USD ${spent.toFixed(2)}).`,
      link: '#/ai', dedupeKey: `ai_budget_alert_${month}` });
  }
}

// Resumen de consumo para el panel de costos
export async function usageSummary(gymId) {
  const settings = await getSettings(gymId);
  const month = await one(
    `SELECT COALESCE(sum(a.cost_usd),0)::float AS cost, COALESCE(sum(a.input_tokens),0)::int AS input_tokens,
            COALESCE(sum(a.output_tokens),0)::int AS output_tokens, COALESCE(sum(a.cache_read_tokens),0)::int AS cache_read_tokens,
            count(*) FILTER (WHERE a.status = 'succeeded')::int AS succeeded, count(*) FILTER (WHERE a.status = 'reused')::int AS reused,
            count(*) FILTER (WHERE a.status IN ('failed','refused'))::int AS failed, count(*) FILTER (WHERE a.status = 'blocked')::int AS blocked,
            count(DISTINCT a.athlete_id)::int AS athletes
       FROM ai_requests a JOIN gyms g ON g.id = a.gym_id WHERE a.gym_id = $1 AND a.created_at >= ${MONTH_START}`, [gymId]);
  const byOperation = await many(
    `SELECT a.operation, count(*) FILTER (WHERE a.status = 'succeeded')::int AS calls, COALESCE(sum(a.cost_usd),0)::float AS cost,
            COALESCE(avg(a.cost_usd) FILTER (WHERE a.status = 'succeeded'),0)::float AS avg_cost,
            COALESCE(avg(a.input_tokens) FILTER (WHERE a.status = 'succeeded'),0)::int AS avg_input,
            COALESCE(avg(a.output_tokens) FILTER (WHERE a.status = 'succeeded'),0)::int AS avg_output
       FROM ai_requests a JOIN gyms g ON g.id = a.gym_id WHERE a.gym_id = $1 AND a.created_at >= ${MONTH_START}
      GROUP BY a.operation ORDER BY a.operation`, [gymId]);
  const history = await many(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COALESCE(sum(a.cost_usd),0)::float AS cost,
            count(*) FILTER (WHERE a.status = 'succeeded')::int AS calls
       FROM ai_requests a WHERE a.gym_id = $1 AND a.created_at > now() - interval '12 months'
      GROUP BY 1 ORDER BY 1`, [gymId]);
  const topAthletes = await many(
    `SELECT a.athlete_id, u.full_name, COALESCE(sum(a.cost_usd),0)::float AS cost, count(*)::int AS calls
       FROM ai_requests a JOIN users u ON u.id = a.athlete_id JOIN gyms g ON g.id = a.gym_id
      WHERE a.gym_id = $1 AND a.created_at >= ${MONTH_START} GROUP BY 1,2 ORDER BY cost DESC LIMIT 10`, [gymId]);
  const activeAthletes = (await one(`SELECT count(*)::int AS n FROM users WHERE gym_id = $1 AND role = 'athlete' AND status = 'active'`, [gymId])).n;
  return {
    budget_usd: Number(settings.ai_monthly_budget_usd),
    alert_threshold: Number(settings.ai_alert_threshold),
    model: settings.ai_model,
    month,
    cost_per_active_athlete: activeAthletes ? month.cost / activeAthletes : 0,
    active_athletes: activeAthletes,
    by_operation: byOperation,
    history,
    top_athletes: topAthletes,
    provider_configured: Boolean(getProvider()),
  };
}
