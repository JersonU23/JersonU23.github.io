// Configuración central. Lee variables de entorno y falla temprano si falta algo crítico.
import fs from 'node:fs';
import path from 'node:path';

// Carga mínima de .env (sin dependencias). Las variables ya definidas en el entorno tienen prioridad.
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Falta la variable de entorno obligatoria ${name}. Revisa .env.example.`);
  return v;
}

const encryptionKey = Buffer.from(required('APP_ENCRYPTION_KEY'), 'base64');
if (encryptionKey.length !== 32) {
  throw new Error('APP_ENCRYPTION_KEY debe ser de 32 bytes codificados en base64.');
}

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT || 3000),
  appOrigin: env.APP_ORIGIN || `http://localhost:${env.PORT || 3000}`,
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: env.DATABASE_SSL === 'true',
  encryptionKey,
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 72),
};
