// Reportes (CSV/JSON) y análisis económico. Todo calculado desde datos reales.
import { Router } from 'express';
import { many } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { getSettings, usageSummary } from '../ai/usage.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(requireRole('admin'));

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en hojas de cálculo
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

// Economía del servicio: costo real medido de IA + costos operativos declarados vs. tarifa → margen
r.get('/economics', async (req, res) => {
  const s = await getSettings(req.user.gym_id);
  const usage = await usageSummary(req.user.gym_id);
  const op = s.operating_costs || {};
  const declared = Object.values(op).reduce((a, b) => a + Number(b || 0), 0);
  const aiCost = usage.month.cost;
  const total = declared + aiCost;
  const fee = s.monthly_fee_usd === null ? null : Number(s.monthly_fee_usd);
  const target = Number(s.target_margin);
  const missing = ['infrastructure', 'database', 'storage', 'notifications', 'payment_gateway', 'maintenance'].filter((k) => op[k] === undefined);
  res.json({
    month_ai_cost_usd: aiCost,
    operating_costs: op,
    operating_costs_missing: missing,
    total_cost_usd: Math.round(total * 100) / 100,
    monthly_fee_usd: fee,
    margin: fee ? Math.round(((fee - total) / fee) * 1000) / 1000 : null,
    target_margin: target,
    min_fee_for_target_usd: Math.round((total / (1 - target)) * 100) / 100,
    ai_cost_per_active_athlete_usd: usage.cost_per_active_athlete,
    active_athletes: usage.active_athletes,
    note: missing.length ? 'Faltan costos operativos reales; el margen está incompleto hasta registrarlos.' : null,
  });
});

r.get('/athletes.csv', async (req, res) => {
  const rows = await many(
    `SELECT u.full_name AS deportista, u.email, u.status AS estado, c.full_name AS entrenador, ap.joined_at AS alta,
            (SELECT status FROM assessments a WHERE a.athlete_id = u.id ORDER BY created_at DESC LIMIT 1) AS evaluacion,
            (SELECT version FROM training_plans t WHERE t.athlete_id = u.id AND t.status = 'active') AS version_plan,
            (SELECT count(*) FROM workout_sessions ws WHERE ws.athlete_id = u.id AND ws.performed_on > current_date - 28) AS sesiones_28d,
            (SELECT weight_kg FROM body_measurements b WHERE b.athlete_id = u.id AND weight_kg IS NOT NULL ORDER BY measured_on DESC LIMIT 1) AS ultimo_peso,
            (SELECT COALESCE(sum(cost_usd),0) FROM ai_requests x WHERE x.athlete_id = u.id) AS costo_ia_total_usd
       FROM users u JOIN athlete_profiles ap ON ap.user_id = u.id LEFT JOIN users c ON c.id = ap.coach_id
      WHERE u.gym_id = $1 AND u.role = 'athlete' AND u.status <> 'deleted' ORDER BY u.full_name`, [req.user.gym_id]);
  await audit(req, 'report.athletes_exported', 'report', null, { rows: rows.length });
  res.type('text/csv').attachment('deportistas.csv').send(toCsv(rows));
});

r.get('/ai-usage.csv', async (req, res) => {
  const rows = await many(
    `SELECT a.created_at AS fecha, a.operation AS operacion, a.status AS estado, a.model AS modelo, a.served_model AS modelo_servido,
            u.full_name AS deportista, a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_write_tokens, a.cost_usd, a.latency_ms
       FROM ai_requests a LEFT JOIN users u ON u.id = a.athlete_id WHERE a.gym_id = $1 ORDER BY a.created_at DESC`, [req.user.gym_id]);
  res.type('text/csv').attachment('consumo-ia.csv').send(toCsv(rows));
});

export default r;
