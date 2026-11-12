import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one, query } from '../db/pool.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../lib/crypto.js';
import { parse, z, password } from '../lib/validate.js';
import { unauthorized, HttpError } from '../lib/errors.js';
import { requireAuth, revokeSession, SESSION_COOKIE } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { config } from '../config.js';

const r = Router();
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.', code: 'rate_limited' },
});

// Hash ficticio para igualar tiempos cuando el correo no existe (evita enumeración de usuarios).
let dummyHash;
const getDummyHash = async () => (dummyHash ||= await hashPassword('dummy-password-0000'));

export async function createSession(res, user, req) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  await query(
    'INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [user.id, sha256(token), req.ip, (req.get('user-agent') || '').slice(0, 300), expires],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: config.isProd, sameSite: 'lax', expires, path: '/',
  });
  return { token, expires };
}

r.post('/login', loginLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.email().max(200), password: z.string().min(1).max(200) }), req.body);
  const user = await one('SELECT * FROM users WHERE email = $1', [body.email]);
  if (!user) {
    await verifyPassword(body.password, await getDummyHash());
    throw unauthorized('Correo o contraseña incorrectos');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(423, 'Cuenta bloqueada temporalmente por intentos fallidos. Intenta más tarde.', 'locked');
  }
  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok || user.status !== 'active') {
    if (!ok) {
      const failed = user.failed_logins + 1;
      await query(
        `UPDATE users SET failed_logins = $2::int,
           locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END
         WHERE id = $1`, [user.id, failed, MAX_FAILED, LOCK_MINUTES]);
      await audit({ ip: req.ip, user: null }, 'auth.login_failed', 'user', user.id, { gym_id: user.gym_id });
    }
    throw unauthorized('Correo o contraseña incorrectos');
  }
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  const { token, expires } = await createSession(res, user, req);
  await audit({ ip: req.ip, user }, 'auth.login', 'user', user.id);
  // El token se devuelve también para clientes móviles (Authorization: Bearer). La web usa la cookie httpOnly.
  res.json({
    user: publicUser(user),
    token: req.get('x-client') === 'mobile' ? token : undefined,
    expires_at: expires,
  });
});

r.post('/logout', requireAuth, async (req, res) => {
  await revokeSession(req.user.session_id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  await audit(req, 'auth.logout', 'user', req.user.id);
  res.json({ ok: true });
});

r.get('/me', requireAuth, async (req, res) => {
  const gym = await one('SELECT id, name, country, timezone, currency, capacity FROM gyms WHERE id = $1', [req.user.gym_id]);
  res.json({ user: publicUser(req.user), gym });
});

r.post('/change-password', requireAuth, async (req, res) => {
  const body = parse(z.object({ current_password: z.string().min(1), new_password: password }), req.body);
  const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(body.current_password, user.password_hash))) throw unauthorized('La contraseña actual no es correcta');
  await query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1',
    [user.id, await hashPassword(body.new_password)]);
  // Revoca las demás sesiones
  await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
    [user.id, req.user.session_id]);
  await audit(req, 'auth.password_changed', 'user', user.id);
  res.json({ ok: true });
});

export function publicUser(u) {
  return {
    id: u.id, gym_id: u.gym_id, email: u.email, role: u.role, full_name: u.full_name,
    must_change_password: u.must_change_password,
  };
}

export default r;
