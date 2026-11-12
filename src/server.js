import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { runReminders } from './services/automation.js';
import { getProvider } from './ai/provider.js';

await migrate();
const app = createApp();
app.listen(config.port, () => {
  console.log(`FITNESS AI escuchando en http://localhost:${config.port} (${config.env})`);
  if (!getProvider()) console.warn('Aviso: ANTHROPIC_API_KEY no configurada. Las funciones de IA responderán "IA no configurada".');
});

// Recordatorios sin IA cada hora
const tick = () => runReminders().catch((e) => console.error('Recordatorios:', e.message));
setTimeout(tick, 10_000);
setInterval(tick, 60 * 60 * 1000);
