import { Router } from 'express';
import { many, one } from '../db/pool.js';
import { parse, z, pagination } from '../lib/validate.js';
import { requireRole, assertStaffAccess } from '../middleware/auth.js';
import * as engine from '../ai/engine.js';
import { usageSummary } from '../ai/usage.js';

const r = Router();

// Generación inicial (entrenamiento + nutrición)
r.post('/athletes/:athleteId/initial', requireRole('admin', 'coach'), async (req, res) => {
  const body = parse(z.object({ include_nutrition: z.boolean().default(true) }), req.body);
  res.status(201).json(await engine.generateInitial(req, req.params.athleteId, { includeNutrition: body.include_nutrition }));
});

// Estado de cuotas de ajuste quincenal del deportista
r.get('/athletes/:athleteId/quota', requireRole('admin', 'coach'), async (req, res) => {
  const a = await assertStaffAccess(req.user, req.params.athleteId);
  const quota = await engine.adjustmentQuota(a.id, a.gym_id);
  const nutrition = await engine.nutritionRelevantChanges(a.id, a.gym_id);
  res.json({ adjustment: quota, nutrition: { has_active_plan: Boolean(nutrition.plan), relevant_changes: nutrition.reasons } });
});

// Ajuste quincenal
r.post('/athletes/:athleteId/adjustment', requireRole('admin', 'coach'), async (req, res) => {
  const body = parse(z.object({ request: z.string().trim().max(1500).default('') }), req.body);
  res.status(201).json(await engine.biweeklyAdjustment(req, req.params.athleteId, body));
});

// Actualización nutricional
r.post('/athletes/:athleteId/nutrition-update', requireRole('admin', 'coach'), async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().max(1500).default('') }), req.body);
  res.status(201).json(await engine.nutritionUpdate(req, req.params.athleteId, body));
});

// Asistente administrativo
r.post('/assistant', requireRole('admin'), async (req, res) => {
  const body = parse(z.object({ question: z.string().trim().min(3).max(2000) }), req.body);
  res.json(await engine.adminAssistant(req, body.question));
});

// Consumo y costos
r.get('/usage', requireRole('admin'), async (req, res) => {
  res.json(await usageSummary(req.user.gym_id));
});

// Historial de operaciones de IA
r.get('/requests', requireRole('admin'), async (req, res) => {
  const q = parse(pagination.extend({ operation: z.string().max(40).optional(), status: z.string().max(20).optional() }), req.query);
  const params = [req.user.gym_id];
  const where = ['a.gym_id = $1'];
  if (q.operation) { params.push(q.operation); where.push(`a.operation = $${params.length}`); }
  if (q.status) { params.push(q.status); where.push(`a.status = $${params.length}`); }
  params.push(q.limit, q.offset);
  const rows = await many(
    `SELECT a.id, a.operation, a.status, a.model, a.served_model, a.input_tokens, a.output_tokens, a.cache_read_tokens,
            a.cache_write_tokens, a.cost_usd, a.latency_ms, a.error, a.reused_from, a.created_at, u.full_name AS athlete_name,
            c.full_name AS requested_by
       FROM ai_requests a LEFT JOIN users u ON u.id = a.athlete_id LEFT JOIN users c ON c.id = a.created_by
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = await one(`SELECT count(*)::int AS n FROM ai_requests a WHERE ${where.join(' AND ')}`, params.slice(0, -2));
  res.json({ requests: rows, total: total.n });
});

export default r;
