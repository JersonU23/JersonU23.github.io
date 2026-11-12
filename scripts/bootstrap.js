// Crea el gimnasio y su primer administrador. Uso:
//   node scripts/bootstrap.js --gym "Nombre del gimnasio" --email admin@gimnasio.com --name "Nombre Admin" [--capacity 300]
// La contraseña se pide de forma interactiva (o por la variable BOOTSTRAP_PASSWORD); nunca se guarda en el código.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pool, tx } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/lib/crypto.js';
import { password as passwordSchema } from '../src/lib/validate.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
if (!args.gym || !args.email || !args.name) {
  console.error('Uso: node scripts/bootstrap.js --gym "Gimnasio" --email admin@correo.com --name "Nombre" [--capacity 300]');
  process.exit(1);
}

let pwd = process.env.BOOTSTRAP_PASSWORD;
if (!pwd) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  pwd = await rl.question('Contraseña del administrador (mín. 10, letras y números): ');
  rl.close();
}
const check = passwordSchema.safeParse(pwd);
if (!check.success) { console.error(check.error.issues[0].message); process.exit(1); }

await migrate();
const result = await tx(async (db) => {
  const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [args.email]);
  if (exists.rows[0]) throw new Error('Ya existe un usuario con ese correo');
  const { rows: [gym] } = await db.query('INSERT INTO gyms (name, capacity) VALUES ($1,$2) RETURNING id', [args.gym, Number(args.capacity || 300)]);
  await db.query('INSERT INTO gym_settings (gym_id) VALUES ($1)', [gym.id]);
  const { rows: [u] } = await db.query(
    `INSERT INTO users (gym_id, email, password_hash, role, full_name) VALUES ($1,$2,$3,'admin',$4) RETURNING id`,
    [gym.id, args.email, await hashPassword(pwd), args.name]);
  await db.query(`INSERT INTO audit_logs (gym_id, actor_id, action, entity, entity_id) VALUES ($1,$2,'gym.bootstrap','gym',$3)`, [gym.id, u.id, String(gym.id)]);
  return { gym: gym.id, admin: u.id };
});
console.log('Gimnasio y administrador creados:', result);
await pool.end();
