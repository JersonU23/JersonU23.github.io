import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { loadSession, csrfGuard, requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import assessmentRoutes from './routes/assessments.js';
import exerciseRoutes from './routes/exercises.js';
import planRoutes from './routes/plans.js';
import aiRoutes from './routes/ai.js';
import trackingRoutes from './routes/tracking.js';
import knowledgeRoutes from './routes/knowledge.js';
import settingsRoutes from './routes/settings.js';
import reportRoutes from './routes/reports.js';
import privacyRoutes from './routes/privacy.js';
import { dashboard, messages, notifications, auditLog } from './routes/misc.js';
import { pool } from './db/pool.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detrás de un proxy/CDN (Render, Railway, Fly…) para IP real y cookies seguras

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'https:'],
        'media-src': ["'self'", 'https:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Límite general de la API (protege de abuso; el login tiene su propio límite más estricto)
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 10000 : 300, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', loadSession, csrfGuard);

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });
  app.use('/api/auth', authRoutes);
  // Todo lo demás requiere sesión
  app.use('/api', requireAuth);
  app.use('/api/users', userRoutes);
  app.use('/api/assessments', assessmentRoutes);
  app.use('/api/exercises', exerciseRoutes);
  app.use('/api/plans', planRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/tracking', trackingRoutes);
  app.use('/api/knowledge', knowledgeRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/privacy', privacyRoutes);
  app.use('/api/dashboard', dashboard);
  app.use('/api/messages', messages);
  app.use('/api/notifications', notifications);
  app.use('/api/audit', auditLog);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada', 'not_found')));

  // Frontend (PWA)
  app.use(express.static(publicDir, { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // Manejo centralizado de errores: sin filtrar detalles internos al cliente.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido', code: 'bad_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande', code: 'too_large' });
    if (err.code === '22P02') return res.status(400).json({ error: 'Identificador inválido', code: 'bad_id' });
    if (err.code === '23514') return res.status(400).json({ error: 'Valor fuera de rango', code: 'check_violation' });
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'Error interno del servidor', code: 'internal' });
  });
  return app;
}
