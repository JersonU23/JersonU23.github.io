// Recuperación de conocimiento validado para la IA (RAG) con búsqueda de texto completo de PostgreSQL.
// No requiere embeddings ni proveedores adicionales: costo cero por consulta.
import { many } from '../db/pool.js';

const GOAL_TERMS = {
  fat_loss: ['pérdida', 'grasa', 'déficit', 'calórico', 'adelgazamiento'],
  hypertrophy: ['hipertrofia', 'volumen', 'músculo', 'masa'],
  strength: ['fuerza', 'carga', 'intensidad'],
  endurance: ['resistencia', 'aeróbico', 'cardiovascular'],
  recomposition: ['recomposición', 'grasa', 'músculo'],
  general_health: ['salud', 'actividad', 'bienestar'],
};
const LEVEL_TERMS = { none: ['principiante'], beginner: ['principiante'], intermediate: ['intermedio'], advanced: ['avanzado'] };

// Convierte texto libre en términos seguros para to_tsquery (solo letras/números).
export function toTerms(...texts) {
  const words = texts.filter(Boolean).join(' ').toLowerCase()
    .split(/[^a-záéíóúüñ0-9]+/i).filter((w) => w.length >= 4);
  return [...new Set(words)].slice(0, 30);
}

export function termsForProfile(profile) {
  return [...new Set([
    ...(GOAL_TERMS[profile.goals?.primary_goal] || []),
    ...(profile.goals?.secondary_goals || []).flatMap((g) => GOAL_TERMS[g] || []),
    ...(LEVEL_TERMS[profile.experience?.level] || []),
    'periodización', 'progresión', 'recuperación',
    ...toTerms(profile.health?.injuries, profile.health?.limitations, profile.health?.pain),
  ])];
}

export async function retrieveKnowledge(gymId, terms, limit = 8) {
  if (!terms.length) return [];
  const q = terms.map((t) => t.replace(/[^a-záéíóúüñ0-9]/gi, '')).filter(Boolean).join(' | ');
  if (!q) return [];
  return many(
    `SELECT id, kind, title, topic, summary, evidence_level, classification, source, authors, published_on,
            reference_list, applicable_profile, results, limitations, version,
            ts_rank(search, to_tsquery('spanish', $2)) AS rank
       FROM knowledge_entries
      WHERE gym_id = $1 AND validation_status = 'validated' AND NOT archived
        AND search @@ to_tsquery('spanish', $2)
      ORDER BY rank DESC, kind, updated_at DESC LIMIT $3`, [gymId, q, limit]);
}

// Formato compacto para el prompt. Distingue explícitamente evidencia científica de experiencia práctica.
export function formatKnowledge(entries) {
  if (!entries.length) return 'No hay registros validados relevantes en el centro de conocimiento.';
  return entries.map((e) => {
    const head = e.kind === 'scientific'
      ? `[${e.id}] CIENTÍFICO · evidencia: ${e.evidence_level} · fuente: ${e.source}${e.authors ? ` (${e.authors})` : ''}${e.published_on ? `, ${e.published_on}` : ''}`
      : `[${e.id}] EMPÍRICO · clasificación: ${e.classification}${e.applicable_profile ? ` · perfil: ${e.applicable_profile}` : ''}`;
    const extra = e.kind === 'empirical'
      ? `${e.results ? `\n  Resultados observados: ${e.results}` : ''}${e.limitations ? `\n  Limitaciones: ${e.limitations}` : ''}`
      : (e.reference_list?.length ? `\n  Referencias: ${e.reference_list.slice(0, 3).join(' | ')}` : '');
    return `${head}\n  ${e.title}: ${e.summary}${extra}`;
  }).join('\n');
}
