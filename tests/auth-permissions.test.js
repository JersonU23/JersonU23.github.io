import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, pool, app, login, anon, createGym, createUser, PASSWORD } from './helpers.js';
import request from 'supertest';

let gym, gym2, admin, coach, coach2, athlete, athlete2, outsider;

before(async () => {
  await resetDb();
  gym = await createGym({ capacity: 3 });
  gym2 = await createGym({ name: 'Otro' });
  admin = await createUser(gym.id, 'admin', { email: 'admin@test.local' });
  coach = await createUser(gym.id, 'coach', { email: 'coach@test.local' });
  coach2 = await createUser(gym.id, 'coach', { email: 'coach2@test.local' });
  athlete = await createUser(gym.id, 'athlete', { email: 'ath@test.local', coachId: coach.id });
  athlete2 = await createUser(gym.id, 'athlete', { email: 'ath2@test.local', coachId: coach2.id });
  outsider = await createUser(gym2.id, 'athlete', { email: 'out@test.local' });
});
after(() => pool.end());

test('login correcto, /me y contraseña almacenada con hash', async () => {
  const c = await login('admin@test.local');
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
  const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [admin.id]);
  assert.match(u.password_hash, /^scrypt\$/);
  assert.ok(!u.password_hash.includes(PASSWORD));
});

test('credenciales incorrectas → 401 genérico y bloqueo tras 5 fallos', async () => {
  const u = await createUser(gym.id, 'coach', { email: 'lock@test.local' });
  for (let i = 0; i < 5; i++) {
    const r = await anon().post('/api/auth/login').send({ email: 'lock@test.local', password: 'mala-clave-1' });
    assert.equal(r.status, 401);
  }
  const r = await anon().post('/api/auth/login').send({ email: 'lock@test.local', password: PASSWORD });
  assert.equal(r.status, 423, 'cuenta bloqueada aunque la contraseña sea correcta');
  const noUser = await anon().post('/api/auth/login').send({ email: 'nadie@test.local', password: 'x' });
  assert.equal(noUser.status, 401);
  assert.equal(noUser.body.error, 'Correo o contraseña incorrectos');
  await pool.query('UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = $1', [u.id]);
});

test('sin sesión → 401; CSRF: petición con cookie sin cabecera → 403', async () => {
  assert.equal((await anon().get('/api/users')).status, 401);
  const c = await login('admin@test.local');
  const r = await c.agent.post('/api/users').send({ email: 'x@test.local', full_name: 'X', role: 'coach' });
  assert.equal(r.status, 403);
  const r2 = await c.agent.post('/api/users').set('X-Requested-With', 'fetch').set('Origin', 'https://evil.example')
    .send({ email: 'x@test.local', full_name: 'X', role: 'coach' });
  assert.equal(r2.status, 403);
});

test('token Bearer para clientes móviles', async () => {
  const r = await request(app).post('/api/auth/login').set('X-Client', 'mobile').send({ email: 'coach@test.local', password: PASSWORD });
  assert.ok(r.body.token);
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r.body.token}`);
  assert.equal(me.body.user.email, 'coach@test.local');
});

test('logout revoca la sesión', async () => {
  const c = await login('coach2@test.local');
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('admin crea usuarios con contraseña temporal; respeta capacidad contratada', async () => {
  const c = await login('admin@test.local');
  const r = await c.post('/api/users').send({ email: 'nuevo@test.local', full_name: 'Nuevo', role: 'athlete', coach_id: coach.id });
  assert.equal(r.status, 201);
  assert.ok(r.body.temporary_password);
  // capacidad 3: ya hay 3 deportistas activos
  const full = await c.post('/api/users').send({ email: 'otro@test.local', full_name: 'Otro', role: 'athlete' });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'capacity_reached');
  const dup = await c.post('/api/users').send({ email: 'coach@test.local', full_name: 'Dup', role: 'coach' });
  assert.equal(dup.status, 409);
  const nuevo = await login('nuevo@test.local', r.body.temporary_password);
  assert.equal(nuevo.user.must_change_password, true);
  const ch = await nuevo.post('/api/auth/change-password').send({ current_password: r.body.temporary_password, new_password: 'OtraClave2024' });
  assert.equal(ch.status, 200);
});

test('roles: deportista y entrenador no pueden administrar usuarios', async () => {
  const a = await login('ath@test.local');
  assert.equal((await a.post('/api/users').send({ email: 'z@test.local', full_name: 'Z', role: 'admin' })).status, 403);
  assert.equal((await a.get('/api/users')).status, 403);
  const c = await login('coach@test.local');
  assert.equal((await c.post('/api/users').send({ email: 'z@test.local', full_name: 'Z', role: 'athlete' })).status, 403);
  assert.equal((await c.get('/api/settings')).status, 403);
  assert.equal((await c.get('/api/audit')).status, 403);
});

test('entrenador solo ve a sus deportistas asignados', async () => {
  const c = await login('coach@test.local');
  const list = await c.get('/api/users');
  assert.ok(list.body.users.every((u) => u.coach_id === coach.id));
  assert.equal((await c.get(`/api/users/athletes/${athlete.id}`)).status, 200);
  assert.equal((await c.get(`/api/users/athletes/${athlete2.id}`)).status, 403);
  assert.equal((await c.get(`/api/tracking/athlete/${athlete2.id}/progress`)).status, 403);
  assert.equal((await c.get(`/api/assessments/athlete/${athlete2.id}/current`)).status, 403);
});

test('deportista solo accede a sus propios datos; aislamiento entre gimnasios', async () => {
  const a = await login('ath@test.local');
  assert.equal((await a.get(`/api/tracking/athlete/${athlete.id}/progress`)).status, 200);
  assert.equal((await a.get(`/api/tracking/athlete/${athlete2.id}/progress`)).status, 403);
  const adm = await login('admin@test.local');
  assert.equal((await adm.get(`/api/users/athletes/${outsider.id}`)).status, 404, 'admin no ve deportistas de otro gimnasio');
});

test('reasignación de entrenador cambia el acceso', async () => {
  const adm = await login('admin@test.local');
  assert.equal((await adm.put(`/api/users/athletes/${athlete2.id}/coach`).send({ coach_id: coach.id })).status, 200);
  const c = await login('coach@test.local');
  assert.equal((await c.get(`/api/users/athletes/${athlete2.id}`)).status, 200);
  const notif = await c.get('/api/notifications');
  assert.ok(notif.body.notifications.some((n) => n.kind === 'assignment'));
  const audit = await adm.get('/api/audit?action=athlete.coach_assigned');
  assert.equal(audit.body.entries.length, 1);
});

test('desactivar usuario revoca sus sesiones', async () => {
  const c = await login('coach2@test.local');
  const adm = await login('admin@test.local');
  assert.equal((await adm.patch(`/api/users/${coach2.id}`).send({ status: 'inactive' })).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('validación de entradas', async () => {
  const adm = await login('admin@test.local');
  const r = await adm.post('/api/users').send({ email: 'no-es-correo', full_name: '', role: 'root' });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.body.details));
  assert.equal((await adm.get('/api/users/athletes/no-uuid')).status, 404);
});
