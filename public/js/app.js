// FITNESS AI — aplicación web (PWA). Enrutador por hash y navegación según rol.
import { api } from './api.js';
import { h, mount, toast, toastError, modal, form, loading } from './ui.js';
import { L } from './labels.js';
import * as admin from './views/admin.js';
import * as staff from './views/staff.js';
import * as athlete from './views/athlete.js';
import * as common from './views/common.js';

export const state = { user: null, gym: null };
const root = document.getElementById('app');

const NAV = {
  admin: [
    ['dashboard', '◧', 'Dashboard'], ['athletes', '◎', 'Deportistas'], ['coaches', '◈', 'Entrenadores'], ['reviews', '✓', 'Revisiones'],
    ['exercises', '⚑', 'Biblioteca'], ['knowledge', '❖', 'Conocimiento'], ['ai', '✦', 'IA y costos'], ['reports', '▤', 'Reportes'],
    ['settings', '⚙', 'Configuración'], ['audit', '☰', 'Auditoría'], ['messages', '✉', 'Mensajes'],
  ],
  coach: [
    ['dashboard', '◧', 'Panel'], ['athletes', '◎', 'Mis deportistas'], ['reviews', '✓', 'Revisiones'], ['exercises', '⚑', 'Biblioteca'],
    ['knowledge', '❖', 'Conocimiento'], ['messages', '✉', 'Mensajes'],
  ],
  athlete: [
    ['today', '▶', 'Hoy'], ['log', '✎', 'Registrar'], ['progress', '↗', 'Progreso'], ['nutrition', '◍', 'Nutrición'],
    ['assessment', '☑', 'Evaluación'], ['messages', '✉', 'Mensajes'],
  ],
};

const ROUTES = {
  dashboard: { roles: ['admin', 'coach'], view: (el) => staff.dashboardView(el) },
  athletes: { roles: ['admin', 'coach'], view: (el) => staff.athletesView(el) },
  athlete: { roles: ['admin', 'coach'], view: (el, id) => staff.athleteDetailView(el, id) },
  reviews: { roles: ['admin', 'coach'], view: (el) => staff.reviewsView(el) },
  plan: { roles: ['admin', 'coach'], view: (el, kind, id) => staff.planReviewView(el, kind, id) },
  coaches: { roles: ['admin'], view: (el) => admin.coachesView(el) },
  exercises: { roles: ['admin', 'coach'], view: (el) => admin.exercisesView(el) },
  knowledge: { roles: ['admin', 'coach'], view: (el) => admin.knowledgeView(el) },
  ai: { roles: ['admin'], view: (el) => admin.aiView(el) },
  reports: { roles: ['admin'], view: (el) => admin.reportsView(el) },
  settings: { roles: ['admin'], view: (el) => admin.settingsView(el) },
  audit: { roles: ['admin'], view: (el) => admin.auditView(el) },
  today: { roles: ['athlete'], view: (el) => athlete.todayView(el) },
  log: { roles: ['athlete'], view: (el) => athlete.logView(el) },
  progress: { roles: ['athlete'], view: (el) => athlete.progressView(el) },
  nutrition: { roles: ['athlete'], view: (el) => athlete.nutritionView(el) },
  assessment: { roles: ['athlete'], view: (el) => athlete.assessmentView(el) },
  messages: { roles: ['admin', 'coach', 'athlete'], view: (el, id) => common.messagesView(el, id) },
  notifications: { roles: ['admin', 'coach', 'athlete'], view: (el) => common.notificationsView(el) },
};

const home = () => (state.user.role === 'athlete' ? 'today' : 'dashboard');

async function boot() {
  try {
    const me = await api.get('/auth/me');
    state.user = me.user; state.gym = me.gym;
    renderShell();
    if (state.user.must_change_password) changePasswordDialog(true);
  } catch {
    renderLogin();
  }
}

function renderLogin() {
  state.user = null;
  const f = form([
    { name: 'email', label: 'Correo electrónico', type: 'email', full: true, autocomplete: 'username' },
    { name: 'password', label: 'Contraseña', type: 'password', full: true, autocomplete: 'current-password' },
  ]);
  const submit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await api.post('/auth/login', f.values());
      await boot();
    } catch (err) { toastError(err); } finally { btn.disabled = false; }
  };
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Ingresar');
  mount(root, h('div', { class: 'login' }, h('form', { class: 'card stack', onsubmit: submit },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'AI'), 'FITNESS AI'),
    h('p', { class: 'muted' }, 'Entrenamiento y nutrición personalizados para tu gimnasio.'),
    f.el, btn)));
}

let content, bellCount;
function renderShell() {
  const nav = NAV[state.user.role];
  const links = (cls) => nav.map(([r, ico, label]) => h('a', { href: `#/${r}`, class: cls, dataset: { route: r } }, h('span', { class: 'ico', 'aria-hidden': 'true' }, ico), h('span', {}, label)));
  bellCount = h('span', { class: 'badge-dot hidden' });
  content = h('main', { class: 'content', id: 'content' });
  mount(root, h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'AI'), 'FITNESS AI'),
      h('nav', { class: 'nav', 'aria-label': 'Principal' }, links(''))),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('div', {}, h('strong', {}, state.gym?.name || ''), h('div', { class: 'small muted' }, `${state.user.full_name} · ${L.role[state.user.role]}`)),
        h('div', { class: 'row' },
          h('a', { href: '#/notifications', class: 'btn ghost bell', 'aria-label': 'Notificaciones' }, '🔔', bellCount),
          h('button', { class: 'btn ghost small', 'aria-label': 'Cambiar contraseña', onclick: () => changePasswordDialog(false) }, '🔑', h('span', { class: 'hide-mobile' }, ' Contraseña')),
          h('button', { class: 'btn small', onclick: logout }, 'Salir'))),
      content),
    h('nav', { class: 'bottom-nav', 'aria-label': 'Navegación móvil' }, links(''))));
  route();
  refreshBell();
}

export async function refreshBell() {
  try {
    const n = await api.get('/notifications');
    bellCount.textContent = n.unread;
    bellCount.classList.toggle('hidden', !n.unread);
  } catch { /* silencioso */ }
}

async function logout() {
  try { await api.post('/auth/logout'); } catch { /* sesión ya expirada */ }
  renderLogin();
}

async function changePasswordDialog(forced) {
  const f = form([
    { name: 'current_password', label: 'Contraseña actual', type: 'password', full: true },
    { name: 'new_password', label: 'Nueva contraseña (mín. 10, letras y números)', type: 'password', full: true },
  ]);
  await modal(forced ? 'Crea tu contraseña personal' : 'Cambiar contraseña', h('div', { class: 'stack' },
    forced ? h('p', { class: 'muted' }, 'Tu cuenta usa una contraseña temporal. Cámbiala para continuar.') : null, f.el), [
    ...(forced ? [] : [{ label: 'Cancelar', value: null }]),
    { label: 'Guardar', class: 'primary', onClick: async () => {
      try { await api.post('/auth/change-password', f.values()); toast('Contraseña actualizada'); state.user.must_change_password = false; return true; } catch (err) { toastError(err); return false; }
    } }]);
  if (forced && state.user.must_change_password) changePasswordDialog(true);
}

async function route() {
  if (!state.user) return;
  const [name, ...params] = (location.hash.replace(/^#\/?/, '') || home()).split('/');
  const r = ROUTES[name];
  if (!r || !r.roles.includes(state.user.role)) { location.hash = `#/${home()}`; return; }
  document.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name || (name === 'athlete' && a.dataset.route === 'athletes')));
  // Cada navegación usa su propio contenedor: si una vista anterior termina de cargar tarde,
  // escribe en un nodo ya desconectado y no pisa la vista actual.
  const view = h('div');
  mount(view, loading());
  mount(content, view);
  try {
    await r.view(view, ...params.map(decodeURIComponent));
  } catch (err) {
    mount(view, h('div', { class: 'card' }, h('h2', {}, 'No se pudo cargar'), h('p', { class: 'muted' }, err.message)));
  }
  window.scrollTo(0, 0);
  refreshBell();
}

window.addEventListener('hashchange', route);
window.addEventListener('fai:unauthorized', () => { if (state.user) { toast('Tu sesión expiró', 'error'); renderLogin(); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
