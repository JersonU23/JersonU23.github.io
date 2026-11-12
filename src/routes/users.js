import { Router } from 'express';
import { one, many, tx } from '../db/pool.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { parse, z, shortText, optText, uuid, pagination } from '../lib/validate.js';
import { conflict, notFound, badRequest, forbidden } from '../lib/errors.js';
import { requireRole, assertAthleteAccess } from '../middleware/auth.js';
import { audit } from '../services/audit.js';

const r = Router();

const newUserSchema = z.object({
  email: z.email().max(200),
  full_name: shortText(120),
  phone: z.string().trim().max(30).optional().nullable(),
  role: z.enum(['coach', 'athlete', 'admin']),
  coach_id: uuid.optional().nullable(),
  specialty: optText(200),
});

// Contraseña temporal legible; se muestra una sola vez y obliga a cambiarla en el primer acceso.
const tempPassword = () => `Fa-${randomToken(9)}1`;

async function activeAthleteCount(gymId, db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM users WHERE gym_id = $1 AND role = 'athlete' AND status = 'active'`, [gymId]);
  return rows[0].n;
}

async function assertCoachInGym(coachId, gymId, db) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE id = $1 AND gym_id = $2 AND role = 'coach' AND status = 'active'`, [coachId, gymId]);
  if (!rows[0]) throw badRequest('Entrenador no válido o inactivo');
}

// Crear usuario (admin)
r.post('/', requireRole('admin'), async (req, res) => {
  const body = parse(newUserSchema, req.body);
  const gymId = req.user.gym_id;
  const pwd = tempPassword();
  const hash = await hashPassword(pwd);
  const user = await tx(async (db) => {
    if (body.role === 'athlete') {
      // Bloqueo de fila del gimnasio para que dos altas simultáneas no superen la capacidad
      const { rows: [gym] } = await db.query('SELECT capacity FROM gyms WHERE id = $1 FOR UPDATE', [gymId]);
      if ((await activeAthleteCount(gymId, db)) >= gym.capacity) {
        throw conflict(`Se alcanzó la capacidad contratada (${gym.capacity} deportistas activos).`, 'capacity_reached');
      }
      if (body.coach_id) await assertCoachInGym(body.coach_id, gymId, db);
    }
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists.rows[0]) throw conflict('Ya existe un usuario con ese correo', 'email_taken');
    const { rows: [u] } = await db.query(
      `INSERT INTO users (gym_id, email, password_hash, role, full_name, phone, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id, gym_id, email, role, full_name, phone, status, created_at`,
      [gymId, body.email, hash, body.role, body.full_name, body.phone || null]);
    if (body.role === 'athlete') {
      await db.query('INSERT INTO athlete_profiles (user_id, coach_id) VALUES ($1,$2)', [u.id, body.coach_id || null]);
    } else if (body.role === 'coach') {
      await db.query('INSERT INTO coach_profiles (user_id, specialty) VALUES ($1,$2)', [u.id, body.specialty || null]);
    }
    await audit(req, 'user.created', 'user', u.id, { role: body.role }, db);
    return u;
  });
  res.status(201).json({ user, temporary_password: pwd });
});

// Listado (admin: todos; coach: sus deportistas)
r.get('/', requireRole('admin', 'coach'), async (req, res) => {
  const q = parse(pagination.extend({
    role: z.enum(['admin', 'coach', 'athlete']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    search: z.string().trim().max(100).optional(),
    coach_id: uuid.optional(),
  }), req.query);
  const params = [req.user.gym_id];
  const where = [`u.gym_id = $1`, `u.status <> 'deleted'`];
  if (req.user.role === 'coach') {
    params.push(req.user.id);
    where.push(`u.role = 'athlete'`, `ap.coach_id = $${params.length}`);
  } else {
    if (q.role) { params.push(q.role); where.push(`u.role = $${params.length}`); }
    if (q.coach_id) { params.push(q.coach_id); where.push(`ap.coach_id = $${params.length}`); }
  }
  if (q.status) { params.push(q.status); where.push(`u.status = $${params.length}`); }
  if (q.search) { params.push(`%${q.search}%`); where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  params.push(q.limit, q.offset);
  const rows = await many(
    `SELECT u.id, u.email, u.role, u.full_name, u.phone, u.status, u.last_login_at, u.created_at,
            ap.coach_id, c.full_name AS coach_name, cp.specialty,
            (SELECT status FROM assessments a WHERE a.athlete_id = u.id ORDER BY created_at DESC LIMIT 1) AS assessment_status,
            EXISTS (SELECT 1 FROM training_plans t WHERE t.athlete_id = u.id AND t.status = 'active') AS has_active_plan,
            (SELECT count(*)::int FROM athlete_profiles x WHERE x.coach_id = u.id) AS athletes_assigned
       FROM users u
       LEFT JOIN athlete_profiles ap ON ap.user_id = u.id
       LEFT JOIN users c ON c.id = ap.coach_id
       LEFT JOIN coach_profiles cp ON cp.user_id = u.id
      WHERE ${where.join(' AND ')}
      ORDER BY u.full_name
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ users: rows });
});

// Detalle de un deportista (con control de acceso)
r.get('/athletes/:id', async (req, res) => {
  const a = await assertAthleteAccess(req.user, req.params.id);
  const coach = a.coach_id ? await one('SELECT id, full_name, email FROM users WHERE id = $1', [a.coach_id]) : null;
  res.json({ athlete: { ...a, coach } });
});

// Actualizar usuario (admin)
r.patch('/:id', requireRole('admin'), async (req, res) => {
  const body = parse(z.object({
    full_name: shortText(120).optional(),
    phone: z.string().trim().max(30).optional().nullable(),
    status: z.enum(['active', 'inactive']).optional(),
    specialty: optText(200),
  }), req.body);
  const target = await one(`SELECT * FROM users WHERE id = $1 AND gym_id = $2 AND status <> 'deleted'`, [req.params.id, req.user.gym_id]);
  if (!target) throw notFound('Usuario no encontrado');
  if (target.id === req.user.id && body.status === 'inactive') throw badRequest('No puedes desactivar tu propia cuenta');
  const updated = await tx(async (db) => {
    if (target.role === 'athlete' && body.status === 'active' && target.status !== 'active') {
      const { rows: [gym] } = await db.query('SELECT capacity FROM gyms WHERE id = $1 FOR UPDATE', [target.gym_id]);
      if ((await activeAthleteCount(target.gym_id, db)) >= gym.capacity) {
        throw conflict(`Se alcanzó la capacidad contratada (${gym.capacity}).`, 'capacity_reached');
      }
    }
    const { rows: [u] } = await db.query(
      `UPDATE users SET full_name = COALESCE($2, full_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
              status = COALESCE($5, status), updated_at = now()
        WHERE id = $1 RETURNING id, email, role, full_name, phone, status`,
      [target.id, body.full_name ?? null, body.phone !== undefined, body.phone ?? null, body.status ?? null]);
    if (target.role === 'coach' && body.specialty !== undefined) {
      await db.query('UPDATE coach_profiles SET specialty = $2 WHERE user_id = $1', [target.id, body.specialty]);
    }
    if (body.status === 'inactive') await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
    await audit(req, 'user.updated', 'user', target.id, { fields: Object.keys(body) }, db);
    return u;
  });
  res.json({ user: updated });
});

// Asignar / reasignar entrenador (admin)
r.put('/athletes/:id/coach', requireRole('admin'), async (req, res) => {
  const body = parse(z.object({ coach_id: uuid.nullable() }), req.body);
  await assertAthleteAccess(req.user, req.params.id);
  await tx(async (db) => {
    if (body.coach_id) await assertCoachInGym(body.coach_id, req.user.gym_id, db);
    await db.query('UPDATE athlete_profiles SET coach_id = $2 WHERE user_id = $1', [req.params.id, body.coach_id]);
    await audit(req, 'athlete.coach_assigned', 'user', req.params.id, { coach_id: body.coach_id }, db);
    if (body.coach_id) {
      await db.query(`INSERT INTO notifications (gym_id, user_id, kind, title, link)
                      VALUES ($1,$2,'assignment','Se te asignó un nuevo deportista',$3)`,
      [req.user.gym_id, body.coach_id, `#/athlete/${req.params.id}`]);
    }
  });
  res.json({ ok: true });
});

// Autorizaciones médica / nutricional (admin o entrenador asignado). Se registran en auditoría.
r.put('/athletes/:id/clearance', requireRole('admin', 'coach'), async (req, res) => {
  const body = parse(z.object({
    type: z.enum(['medical', 'nutrition']),
    granted: z.boolean(),
    note: shortText(1000),
  }), req.body);
  await assertAthleteAccess(req.user, req.params.id);
  const col = body.type === 'medical' ? 'medical_clearance' : 'nutrition_clearance';
  await tx(async (db) => {
    await db.query(`UPDATE athlete_profiles SET ${col} = $2, ${col}_note = $3 WHERE user_id = $1`,
      [req.params.id, body.granted, body.note]);
    await audit(req, `athlete.${col}`, 'user', req.params.id, { granted: body.granted }, db);
  });
  res.json({ ok: true });
});

// Restablecer contraseña (admin): genera temporal y revoca sesiones
r.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  const target = await one(`SELECT id, role FROM users WHERE id = $1 AND gym_id = $2 AND status <> 'deleted'`, [req.params.id, req.user.gym_id]);
  if (!target) throw notFound('Usuario no encontrado');
  if (target.id === req.user.id) throw forbidden('Usa "cambiar contraseña" para tu propia cuenta');
  const pwd = tempPassword();
  await tx(async (db) => {
    await db.query('UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1',
      [target.id, await hashPassword(pwd)]);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
    await audit(req, 'user.password_reset', 'user', target.id, null, db);
  });
  res.json({ temporary_password: pwd });
});

export default r;
