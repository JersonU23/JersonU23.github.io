import { query } from '../db/pool.js';

// Registra una acción en la auditoría. Nunca incluir contraseñas, tokens ni datos de salud en details.
export async function audit(req, action, entity, entityId, details, db = { query }) {
  const u = req?.user;
  await db.query(
    `INSERT INTO audit_logs (gym_id, actor_id, action, entity, entity_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [u?.gym_id || details?.gym_id || null, u?.id || null, action, entity || null,
      entityId ? String(entityId) : null, details ? JSON.stringify(details) : null, req?.ip || null],
  );
}
