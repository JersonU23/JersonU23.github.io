import { Router } from 'express';
import { one, many, tx } from '../db/pool.js';
import { parse, z, shortText, optText, strList, isoDate, pagination } from '../lib/validate.js';
import { notFound, forbidden } from '../lib/errors.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { retrieveKnowledge, toTerms } from '../services/knowledge.js';

const r = Router();
r.use(requireRole('admin', 'coach'));

const common = {
  title: shortText(200),
  topic: z.enum(['anatomia', 'fisiologia', 'biomecanica', 'hipertrofia', 'fuerza', 'resistencia', 'movilidad',
    'recuperacion', 'nutricion', 'periodizacion', 'lesiones', 'tecnica', 'otro']),
  summary: shortText(2000),
  body: optText(20000),
  tags: strList(20, 40).default([]),
};
// Registro científico: fuente, autores, fecha, referencias y nivel de evidencia son obligatorios.
const scientific = z.object({
  kind: z.literal('scientific'),
  ...common,
  source: shortText(300),
  authors: shortText(500),
  published_on: isoDate,
  reference_list: strList(30, 600).min(1, 'Incluye al menos una referencia verificable (DOI, PubMed o cita completa)'),
  evidence_level: z.enum(['meta_analysis', 'systematic_review', 'rct', 'cohort', 'case_series', 'expert_opinion', 'consensus']),
});
// Experiencia empírica de entrenadores
const empirical = z.object({
  kind: z.literal('empirical'),
  ...common,
  specialty: optText(200),
  objective: shortText(500),
  context: shortText(2000),
  applicable_profile: shortText(1000),
  results: shortText(3000),
  limitations: shortText(2000),
  classification: z.enum(['individual', 'repeated', 'evidence_backed', 'hypothesis']),
});
const entrySchema = z.discriminatedUnion('kind', [scientific, empirical]);
const COLS = ['kind', 'title', 'topic', 'summary', 'body', 'tags', 'source', 'authors', 'published_on', 'reference_list',
  'evidence_level', 'specialty', 'objective', 'context', 'applicable_profile', 'results', 'limitations', 'classification'];

const snapshot = (e) => Object.fromEntries([...COLS, 'validation_status', 'version'].map((c) => [c, e[c]]));

r.get('/', async (req, res) => {
  const q = parse(pagination.extend({
    kind: z.enum(['scientific', 'empirical']).optional(),
    status: z.enum(['pending', 'validated', 'rejected']).optional(),
    topic: z.string().max(40).optional(),
    q: z.string().trim().max(200).optional(),
  }), req.query);
  const params = [req.user.gym_id];
  const where = ['k.gym_id = $1', 'NOT k.archived'];
  if (q.kind) { params.push(q.kind); where.push(`k.kind = $${params.length}`); }
  if (q.status) { params.push(q.status); where.push(`k.validation_status = $${params.length}`); }
  if (q.topic) { params.push(q.topic); where.push(`k.topic = $${params.length}`); }
  if (q.q) { params.push(q.q); where.push(`k.search @@ websearch_to_tsquery('spanish', $${params.length})`); }
  params.push(q.limit, q.offset);
  const rows = await many(
    `SELECT k.id, k.kind, k.title, k.topic, k.summary, k.evidence_level, k.classification, k.validation_status, k.version,
            k.source, k.authors, k.published_on, k.updated_at, u.full_name AS author_name,
            (SELECT count(*)::int FROM ai_citations c WHERE c.entry_id = k.id) AS times_cited
       FROM knowledge_entries k LEFT JOIN users u ON u.id = COALESCE(k.author_id, k.created_by)
      WHERE ${where.join(' AND ')} ORDER BY k.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ entries: rows });
});

// Vista previa de lo que la IA recuperaría para unos términos (transparencia del RAG)
r.get('/retrieval-preview', async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().min(2).max(300) }), req.query);
  res.json({ entries: await retrieveKnowledge(req.user.gym_id, toTerms(q.q), 10) });
});

r.get('/:id', async (req, res) => {
  const e = await one(`SELECT k.*, u.full_name AS author_name FROM knowledge_entries k LEFT JOIN users u ON u.id = COALESCE(k.author_id, k.created_by)
                        WHERE k.id = $1 AND k.gym_id = $2`, [req.params.id, req.user.gym_id]);
  if (!e) throw notFound('Registro no encontrado');
  delete e.search;
  const versions = await many(`SELECT v.version, v.created_at, u.full_name AS changed_by FROM knowledge_versions v
                               LEFT JOIN users u ON u.id = v.changed_by WHERE v.entry_id = $1 ORDER BY v.version DESC`, [e.id]);
  const citations = await many(`SELECT c.ai_request_id, c.entry_version, c.usage_note, a.operation, a.created_at FROM ai_citations c
                                JOIN ai_requests a ON a.id = c.ai_request_id WHERE c.entry_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [e.id]);
  res.json({ entry: e, versions, citations });
});

r.get('/:id/versions/:version', async (req, res) => {
  const e = await one('SELECT id FROM knowledge_entries WHERE id = $1 AND gym_id = $2', [req.params.id, req.user.gym_id]);
  if (!e) throw notFound();
  const v = await one('SELECT * FROM knowledge_versions WHERE entry_id = $1 AND version = $2', [e.id, Number(req.params.version)]);
  if (!v) throw notFound('Versión no encontrada');
  res.json({ version: v });
});

r.post('/', async (req, res) => {
  const body = parse(entrySchema, req.body);
  // Las prácticas empíricas las registran entrenadores (o admin); la evidencia científica requiere validación del admin.
  const entry = await tx(async (db) => {
    const vals = COLS.map((c) => body[c] ?? (['tags', 'reference_list'].includes(c) ? [] : null));
    const { rows: [e] } = await db.query(
      `INSERT INTO knowledge_entries (gym_id, created_by, author_id, ${COLS.join(',')})
       VALUES ($1,$2,$3,${COLS.map((_, i) => `$${i + 4}`).join(',')}) RETURNING *`,
      [req.user.gym_id, req.user.id, body.kind === 'empirical' ? req.user.id : null, ...vals]);
    await db.query('INSERT INTO knowledge_versions (entry_id, version, snapshot, changed_by) VALUES ($1,1,$2,$3)', [e.id, snapshot(e), req.user.id]);
    await audit(req, 'knowledge.created', 'knowledge', e.id, { kind: e.kind }, db);
    return e;
  });
  delete entry.search;
  res.status(201).json({ entry });
});

// Editar crea una nueva versión y vuelve a "pendiente de validación"
r.patch('/:id', async (req, res) => {
  const updated = await tx(async (db) => {
    const { rows: [cur] } = await db.query('SELECT * FROM knowledge_entries WHERE id = $1 AND gym_id = $2 FOR UPDATE', [req.params.id, req.user.gym_id]);
    if (!cur) throw notFound('Registro no encontrado');
    if (req.user.role === 'coach' && cur.created_by !== req.user.id) throw forbidden('Solo puedes editar tus propios registros');
    const body = parse(entrySchema, { ...snapshot(cur), ...req.body, kind: cur.kind });
    const cols = COLS.filter((c) => c !== 'kind');
    const { rows: [e] } = await db.query(
      `UPDATE knowledge_entries SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1,
              validation_status = 'pending', validated_by = NULL, validated_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [cur.id, ...cols.map((c) => body[c] ?? (['tags', 'reference_list'].includes(c) ? [] : null))]);
    await db.query('INSERT INTO knowledge_versions (entry_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4)', [e.id, e.version, snapshot(e), req.user.id]);
    await audit(req, 'knowledge.updated', 'knowledge', e.id, { version: e.version }, db);
    return e;
  });
  delete updated.search;
  res.json({ entry: updated });
});

// Validación (admin). Solo los registros validados alimentan a la IA.
r.post('/:id/validate', requireRole('admin'), async (req, res) => {
  const body = parse(z.object({ status: z.enum(['validated', 'rejected']), classification: z.enum(['individual', 'repeated', 'evidence_backed', 'hypothesis']).optional() }), req.body);
  await tx(async (db) => {
    const { rows: [cur] } = await db.query('SELECT * FROM knowledge_entries WHERE id = $1 AND gym_id = $2 FOR UPDATE', [req.params.id, req.user.gym_id]);
    if (!cur) throw notFound('Registro no encontrado');
    await db.query(`UPDATE knowledge_entries SET validation_status = $2, validated_by = $3, validated_at = now(),
                    classification = CASE WHEN kind = 'empirical' THEN COALESCE($4, classification) ELSE classification END WHERE id = $1`,
    [cur.id, body.status, req.user.id, body.classification || null]);
    await audit(req, `knowledge.${body.status}`, 'knowledge', cur.id, { version: cur.version }, db);
  });
  res.json({ ok: true });
});

r.post('/:id/archive', requireRole('admin'), async (req, res) => {
  const e = await one('UPDATE knowledge_entries SET archived = true, updated_at = now() WHERE id = $1 AND gym_id = $2 RETURNING id', [req.params.id, req.user.gym_id]);
  if (!e) throw notFound();
  await audit(req, 'knowledge.archived', 'knowledge', e.id);
  res.json({ ok: true });
});

export default r;
