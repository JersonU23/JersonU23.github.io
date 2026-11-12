import { Router } from 'express';
import { one, many, tx } from '../db/pool.js';
import { parse, z, shortText, optText, strList, pagination } from '../lib/validate.js';
import { notFound, conflict } from '../lib/errors.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';

const r = Router();

const mediaUrl = z.string().trim().max(500).refine((u) => /^https:\/\//.test(u) || u.startsWith('/'),
  'La URL del medio debe ser https:// o una ruta interna').optional().nullable();

export const exerciseSchema = z.object({
  name: shortText(120),
  media_url: mediaUrl,
  media_type: z.enum(['image', 'video']).optional().nullable(),
  primary_muscles: strList(10, 60).min(1, 'Indica al menos un músculo principal'),
  secondary_muscles: strList(15, 60).default([]),
  equipment: strList(10, 60).default([]),
  movement_type: optText(60),
  level: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  execution: optText(4000),
  breathing: optText(1000),
  common_errors: strList(20, 300).default([]),
  variations: strList(20, 200).default([]),
  alternatives: strList(20, 200).default([]),
  contraindications: strList(20, 300).default([]),
  status: z.enum(['active', 'inactive', 'proposed']).default('active'),
});

const FIELDS = Object.keys(exerciseSchema.shape);

r.get('/', async (req, res) => {
  const q = parse(pagination.extend({
    status: z.enum(['active', 'inactive', 'proposed', 'all']).default('active'),
    search: z.string().trim().max(100).optional(),
    muscle: z.string().trim().max(60).optional(),
    equipment: z.string().trim().max(60).optional(),
    level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  }), req.query);
  // Solo el personal ve ejercicios inactivos o propuestos
  const status = req.user.role === 'athlete' ? 'active' : q.status;
  const params = [req.user.gym_id];
  const where = ['gym_id = $1'];
  if (status !== 'all') { params.push(status); where.push(`status = $${params.length}`); }
  if (q.search) { params.push(`%${q.search}%`); where.push(`name ILIKE $${params.length}`); }
  if (q.muscle) { params.push(q.muscle); where.push(`($${params.length} = ANY(primary_muscles) OR $${params.length} = ANY(secondary_muscles))`); }
  if (q.equipment) { params.push(q.equipment); where.push(`$${params.length} = ANY(equipment)`); }
  if (q.level) { params.push(q.level); where.push(`level = $${params.length}`); }
  params.push(q.limit, q.offset);
  const rows = await many(`SELECT * FROM exercises WHERE ${where.join(' AND ')} ORDER BY name
                           LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ exercises: rows });
});

r.get('/:id', async (req, res) => {
  const ex = await one('SELECT * FROM exercises WHERE id = $1 AND gym_id = $2', [req.params.id, req.user.gym_id]);
  if (!ex || (req.user.role === 'athlete' && ex.status !== 'active')) throw notFound('Ejercicio no encontrado');
  res.json({ exercise: ex });
});

r.post('/', requireRole('admin'), async (req, res) => {
  const body = parse(exerciseSchema, req.body);
  const ex = await tx(async (db) => {
    const dup = await db.query('SELECT 1 FROM exercises WHERE gym_id = $1 AND lower(name) = lower($2)', [req.user.gym_id, body.name]);
    if (dup.rows[0]) throw conflict('Ya existe un ejercicio con ese nombre', 'duplicate');
    const cols = FIELDS;
    const { rows: [row] } = await db.query(
      `INSERT INTO exercises (gym_id, created_by, ${cols.join(',')})
       VALUES ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')}) RETURNING *`,
      [req.user.gym_id, req.user.id, ...cols.map((c) => body[c] ?? null)]);
    await audit(req, 'exercise.created', 'exercise', row.id, { name: row.name }, db);
    return row;
  });
  res.status(201).json({ exercise: ex });
});

r.patch('/:id', requireRole('admin'), async (req, res) => {
  const body = parse(exerciseSchema.partial(), req.body);
  const cols = Object.keys(body).filter((k) => FIELDS.includes(k));
  const ex = await tx(async (db) => {
    const { rows: [cur] } = await db.query('SELECT * FROM exercises WHERE id = $1 AND gym_id = $2 FOR UPDATE', [req.params.id, req.user.gym_id]);
    if (!cur) throw notFound('Ejercicio no encontrado');
    if (!cols.length) return cur;
    const { rows: [row] } = await db.query(
      `UPDATE exercises SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING *`, [cur.id, ...cols.map((c) => body[c] ?? null)]);
    await audit(req, body.status && body.status !== cur.status ? `exercise.status_${body.status}` : 'exercise.updated',
      'exercise', cur.id, { fields: cols }, db);
    return row;
  });
  res.json({ exercise: ex });
});

export default r;
