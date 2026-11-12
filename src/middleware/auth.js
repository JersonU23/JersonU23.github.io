import { one, query } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { unauthorized, forbidden, notFound } from '../lib/errors.js';
import { config } from '../config.js';

export const SESSION_COOKIE = 'fai_session';

function extractToken(req) {
  const h = req.get('authorization');
  if (h && h.startsWith('Bearer ')) return { token: h.slice(7), viaCookie: false };
  const c = req.cookies?.[SESSION_COOKIE];
  return c ? { token: c, viaCookie: true } : { token: null, viaCookie: false };
}

// Carga el usuario de la sesión (si existe). No exige autenticación.
export async function loadSession(req, _res, next) {
  const { token, viaCookie } = extractToken(req);
  req.authViaCookie = viaCookie;
  if (!token) return next();
  const row = await one(
    `SELECT s.id AS session_id, u.id, u.gym_id, u.email, u.role, u.full_name, u.status, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (row && row.status === 'active') req.user = row;
  next();
}

// Protección CSRF para sesiones por cookie: las peticiones que modifican datos deben llevar
// la cabecera X-Requested-With (un formulario de otro sitio no puede enviarla) y, si hay Origin, debe coincidir.
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.authViaCookie) return next();
  if (req.get('x-requested-with') !== 'fetch') return next(forbidden('Petición rechazada (CSRF)'));
  const origin = req.get('origin');
  if (origin && origin !== config.appOrigin) return next(forbidden('Origen no permitido'));
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

// Verifica que el usuario actual puede acceder a los datos de un deportista:
// - admin: cualquier deportista de su gimnasio
// - coach: solo deportistas asignados
// - athlete: solo a sí mismo
export async function assertAthleteAccess(user, athleteId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(athleteId))) throw notFound('Deportista no encontrado');
  const a = await one(
    `SELECT u.id, u.gym_id, u.full_name, u.email, u.status, ap.coach_id,
            ap.medical_clearance, ap.medical_clearance_note, ap.nutrition_clearance, ap.nutrition_clearance_note, ap.joined_at
       FROM users u JOIN athlete_profiles ap ON ap.user_id = u.id
      WHERE u.id = $1 AND u.role = 'athlete' AND u.status <> 'deleted'`,
    [athleteId],
  );
  if (!a || a.gym_id !== user.gym_id) throw notFound('Deportista no encontrado');
  if (user.role === 'admin') return a;
  if (user.role === 'coach' && a.coach_id === user.id) return a;
  if (user.role === 'athlete' && a.id === user.id) return a;
  throw forbidden('No tienes acceso a este deportista');
}

// Solo personal (admin o entrenador asignado) puede modificar planificación de un deportista.
export async function assertStaffAccess(user, athleteId) {
  if (!['admin', 'coach'].includes(user.role)) throw forbidden();
  return assertAthleteAccess(user, athleteId);
}

export async function revokeSession(sessionId) {
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}
