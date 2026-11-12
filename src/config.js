// Configuración central. Lee variables de entorno y falla temprano si falta algo crítico.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

// Clave de cifrado: 32 bytes en base64 (recomendado). Si el proveedor genera otro formato,
// se acepta un secreto aleatorio de al menos 32 caracteres y se deriva la clave con SHA-256.
const rawKey = required('APP_ENCRYPTION_KEY');
let encryptionKey = Buffer.from(rawKey, 'base64');
if (encryptionKey.length !== 32) {
  if (rawKey.length < 32) {
    throw new Error('APP_ENCRYPTION_KEY debe ser de 32 bytes en base64 o un secreto aleatorio de al menos 32 caracteres.');
  }
  encryptionKey = crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT || 3000),
  appOrigin: env.APP_ORIGIN || `http://localhost:${env.PORT || 3000}`,
  databaseUrl: required('DATABASE_URL'),
  // DATABASE_SSL: false | true (TLS verificando certificado) | no-verify (TLS sin verificar, solo si el proveedor usa certificados propios)
  databaseSsl: ['true', 'no-verify'].includes(env.DATABASE_SSL) ? env.DATABASE_SSL : false,
  encryptionKey,
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 72),
};
