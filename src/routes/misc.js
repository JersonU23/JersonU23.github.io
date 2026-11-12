// Dashboard, mensajes, notificaciones y auditoría.
import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { parse, z, shortText, pagination, uuid } from '../lib/validate.js';
import { forbidden, notFound } from '../lib/errors.js';
import { requireRole } from '../middleware/auth.js';
import { dashboardMetrics } from '../services/dashboard.js';
import { notify } from '../services/notifications.js';

export const dashboard = Router();
dashboard.get('/', requireRole('admin', 'coach'), async (req, res) => {
  res.json(await dashboardMetrics(req.user.gym_id, { coachId: req.user.role === 'coach' ? req.user.id : null }));
});

// ---------- Mensajería deportista ↔ entrenador (y personal) ----------
export const messages = Router();

async function canMessage(user, otherId) {
  const other = await one(`SELECT u.id, u.role, u.gym_id, u.full_name, ap.coach_id FROM users u LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
                            WHERE u.id = $1 AND u.status = 'active'`, [otherId]);
  if (!other || other.gym_id !== user.gym_id || other.id === user.id) return null;
  if (user.role === 'admin') return other;
  if (user.role === 'coach') {
    if (other.role === 'admin' || other.role === 'coach') return other;
    return other.coach_id === user.id ? other : null;
  }
  // deportista: solo con su entrenador
  const me = await one('SELECT coach_id FROM athlete_profiles WHERE user_id = $1', [user.id]);
  return me?.coach_id === other.id ? other : null;
}

messages.get('/contacts', async (req, res) => {
  const u = req.user;
  let rows;
  if (u.role === 'athlete') {
    rows = await many(`SELECT c.id, c.full_name, c.role FROM athlete_profiles ap JOIN users c ON c.id = ap.coach_id
                        WHERE ap.user_id = $1 AND c.status = 'active'`, [u.id]);
  } else if (u.role === 'coach') {
    rows = await many(`SELECT u.id, u.full_name, u.role FROM users u LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
                        WHERE u.gym_id = $1 AND u.status = 'active' AND u.id <> $2 AND (ap.coach_id = $2 OR u.role = 'admin')
                        ORDER BY u.role, u.full_name`, [u.gym_id, u.id]);
  } else {
    rows = await many(`SELECT id, full_name, role FROM users WHERE gym_id = $1 AND status = 'active' AND id <> $2 ORDER BY role, full_name`, [u.gym_id, u.id]);
  }
  const unread = await many(`SELECT sender_id, count(*)::int AS n FROM messages WHERE recipient_id = $1 AND read_at IS NULL GROUP BY 1`, [u.id]);
  const map = Object.fromEntries(unread.map((x) => [x.sender_id, x.n]));
  res.json({ contacts: rows.map((c) => ({ ...c, unread: map[c.id] || 0 })) });
});

messages.get('/with/:userId', async (req, res) => {
  if (!(await canMessage(req.user, req.params.userId))) throw forbidden('No puedes conversar con este usuario');
  const rows = await many(`SELECT id, sender_id, recipient_id, body, created_at, read_at FROM messages
                            WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
                            ORDER BY created_at DESC LIMIT 200`, [req.user.id, req.params.userId]);
  await query(`UPDATE messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`, [req.user.id, req.params.userId]);
  res.json({ messages: rows.reverse() });
});

messages.post('/', async (req, res) => {
  const body = parse(z.object({ to: uuid, body: shortText(4000) }), req.body);
  const other = await canMessage(req.user, body.to);
  if (!other) throw forbidden('No puedes enviar mensajes a este usuario');
  const { rows: [m] } = await query(`INSERT INTO messages (gym_id, sender_id, recipient_id, body) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user.gym_id, req.user.id, other.id, body.body]);
  await notify(null, { gymId: req.user.gym_id, userId: other.id, kind: 'message', title: `Nuevo mensaje de ${req.user.full_name}`,
    link: `#/messages/${req.user.id}`, dedupeKey: `msg_${req.user.id}_${new Date().toISOString().slice(0, 13)}` });
  res.status(201).json({ message: m });
});

// ---------- Notificaciones ----------
export const notifications = Router();
notifications.get('/', async (req, res) => {
  const rows = await many(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
  const { n } = await one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [req.user.id]);
  res.json({ notifications: rows, unread: n });
});
notifications.post('/read-all', async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
});
notifications.post('/:id/read', async (req, res) => {
  const r = await one('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
  if (!r) throw notFound();
  res.json({ ok: true });
});

// ---------- Auditoría ----------
export const auditLog = Router();
auditLog.get('/', requireRole('admin'), async (req, res) => {
  const q = parse(pagination.extend({ action: z.string().max(80).optional(), actor_id: uuid.optional() }), req.query);
  const params = [req.user.gym_id];
  const where = ['a.gym_id = $1'];
  if (q.action) { params.push(`${q.action}%`); where.push(`a.action LIKE $${params.length}`); }
  if (q.actor_id) { params.push(q.actor_id); where.push(`a.actor_id = $${params.length}`); }
  params.push(q.limit, q.offset);
  const rows = await many(`SELECT a.*, u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
                            WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ entries: rows });
});
