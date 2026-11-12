// Configuración del gimnasio en tres niveles: básico, avanzado y automático. Todo cambio queda auditado.
import { Router } from 'express';
import { one, tx } from '../db/pool.js';
import { parse, z } from '../lib/validate.js';
import { badRequest, conflict } from '../lib/errors.js';
import { requireRole } from '../middleware/auth.js';
import { getSettings } from '../ai/usage.js';
import { DEFAULT_PRICING, SUPPORTED_MODELS } from '../ai/pricing.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(requireRole('admin'));

const money = z.number().min(0).max(1_000_000);
const priceSchema = z.object({ input: money, output: money, cache_write: money, cache_read: money });

// Nivel básico: lo esencial para operar
const basic = z.object({
  ai_enabled: z.boolean(),
  ai_monthly_budget_usd: money,
  ai_alert_threshold: z.number().min(0.1).max(1),
  monthly_fee_usd: money.nullable(),
}).partial();

// Nivel avanzado: parámetros específicos
const advanced = basic.extend({
  ai_model: z.enum(SUPPORTED_MODELS),
  ai_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  max_adjustments_per_month: z.number().int().min(0).max(4),
  min_days_between_adjustments: z.number().int().min(1).max(60),
  assistant_daily_limit: z.number().int().min(0).max(500),
  nutrition_weight_change_pct: z.number().min(0.5).max(20),
  target_margin: z.number().min(0).max(0.95),
  ai_pricing: z.record(z.string().max(60), priceSchema),
  operating_costs: z.object({
    infrastructure: money, database: money, storage: money, notifications: money,
    payment_gateway: money, maintenance: money, other: money,
  }).partial(),
  capacity: z.number().int().min(1).max(100000),
}).partial();

// Nivel automático: límites dentro de los cuales la IA actúa sin solicitud manual
const automatic = z.object({
  auto_initial_generation: z.boolean(),        // generar propuesta inicial al enviar la evaluación (sigue requiriendo aprobación)
  auto_max_cost_per_request_usd: money,        // si una solicitud previa costó más, se desactiva la automatización
}).partial();

r.get('/', async (req, res) => {
  const s = await getSettings(req.user.gym_id);
  const gym = await one('SELECT name, capacity, timezone, currency FROM gyms WHERE id = $1', [req.user.gym_id]);
  res.json({ settings: s, gym, defaults: { pricing: DEFAULT_PRICING, models: SUPPORTED_MODELS } });
});

r.patch('/', async (req, res) => {
  const body = parse(z.object({
    level: z.enum(['basic', 'advanced', 'automatic']),
    values: z.record(z.string(), z.any()).default({}),
    automatic: z.record(z.string(), z.any()).optional(),
  }), req.body);
  const values = parse(body.level === 'basic' ? basic.strict() : advanced.strict(), body.values);
  const auto = body.automatic ? parse(automatic.strict(), body.automatic) : null;
  if (body.level === 'automatic' && auto?.auto_initial_generation && auto.auto_max_cost_per_request_usd === undefined) {
    throw badRequest('En modo automático define auto_max_cost_per_request_usd (límite autorizado de costo por solicitud).');
  }
  const updated = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM gym_settings WHERE gym_id = $1 FOR UPDATE', [req.user.gym_id]);
    const { capacity, ...settingsValues } = values;
    if (capacity !== undefined) {
      const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM users WHERE gym_id = $1 AND role = 'athlete' AND status = 'active'`, [req.user.gym_id]);
      if (capacity < n) throw conflict(`No puedes fijar una capacidad (${capacity}) menor que los deportistas activos (${n}).`, 'capacity_below_active');
      await db.query('UPDATE gyms SET capacity = $2 WHERE id = $1', [req.user.gym_id, capacity]);
    }
    const sets = ['config_level = $2', 'updated_at = now()', 'updated_by = $3'];
    const params = [req.user.gym_id, body.level, req.user.id];
    for (const [k, v] of Object.entries(settingsValues)) {
      params.push(['ai_pricing', 'operating_costs'].includes(k) ? JSON.stringify(k === 'operating_costs' ? { ...before.operating_costs, ...v } : v) : v);
      sets.push(`${k} = $${params.length}`);
    }
    if (auto) { params.push(JSON.stringify({ ...before.advanced, ...auto })); sets.push(`advanced = $${params.length}`); }
    const { rows: [s] } = await db.query(`UPDATE gym_settings SET ${sets.join(', ')} WHERE gym_id = $1 RETURNING *`, params);
    const changed = Object.keys(settingsValues).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(s[k]));
    await audit(req, 'settings.updated', 'gym_settings', req.user.gym_id, {
      level: body.level, changed, capacity, automatic: auto,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, s[k]])),
    }, db);
    return s;
  });
  res.json({ settings: updated });
});

export default r;
