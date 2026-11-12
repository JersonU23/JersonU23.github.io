import { query } from '../db/pool.js';

// Notificación interna (sin IA). dedupeKey evita repetir el mismo aviso al mismo usuario.
export async function notify(db, { gymId, userId, kind, title, body = null, link = null, dedupeKey = null }) {
  await (db || { query }).query(
    `INSERT INTO notifications (gym_id, user_id, kind, title, body, link, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [gymId, userId, kind, title, body, link, dedupeKey]);
}

export async function notifyRole(db, gymId, role, payload) {
  const { rows } = await (db || { query }).query(
    `SELECT id FROM users WHERE gym_id = $1 AND role = $2 AND status = 'active'`, [gymId, role]);
  for (const u of rows) await notify(db, { ...payload, gymId, userId: u.id });
}
