# FITNESS AI

Plataforma SaaS para gestionar gimnasios con planificación personalizada de entrenamiento y nutrición asistida por IA, seguimiento del progreso y un centro de conocimiento científico y empírico.

Lanzamiento previsto: un gimnasio en Ecuador, hasta 300 deportistas y una suscripción mensual. La arquitectura ya es multi-gimnasio.

> Diagnóstico del repositorio antes de empezar: [`docs/DIAGNOSTICO.md`](docs/DIAGNOSTICO.md).

---

## Arquitectura

```
public/            PWA (HTML + CSS + JS modular sin compilación) servida por el backend
  js/app.js        enrutador y navegación por rol
  js/views/        admin.js · staff.js (admin+entrenador) · athlete.js · common.js
  sw.js            service worker: cachea solo la interfaz, nunca /api
src/
  app.js           Express: seguridad (helmet/CSP, rate-limit, CSRF), rutas, errores
  routes/          auth, users, assessments, exercises, plans, ai, tracking, knowledge,
                   settings, reports, privacy, misc (dashboard, mensajes, notificaciones, auditoría)
  ai/              provider (Anthropic) · usage (consumo, presupuesto, deduplicación) ·
                   engine (reglas y orquestación) · prompts · schemas · pricing
  services/        reglas de evaluación, progreso (sin IA), dashboard, conocimiento (RAG),
                   notificaciones, automatización, auditoría
db/migrations/     esquema SQL versionado (PostgreSQL)
scripts/           bootstrap del gimnasio, biblioteca base opcional, respaldo
tests/             47 pruebas de integración contra PostgreSQL real
```

| Capa | Tecnología | Motivo |
|---|---|---|
| Backend | Node.js 22, Express 5 | Ligero, una sola tecnología en todo el stack |
| Base de datos | PostgreSQL 16 | Relacional, JSONB para planes, búsqueda de texto completo en español para el RAG |
| Autenticación | Sesiones opacas con hash SHA-256 en BD; cookie httpOnly (web) o `Authorization: Bearer` (apps móviles); contraseñas con scrypt | Las sesiones se pueden revocar y no se guardan tokens en el navegador |
| IA | SDK oficial de Anthropic, salidas estructuradas (JSON Schema) y validación propia con Zod | Las respuestas se validan antes de guardarse |
| Frontend | PWA responsive sin compilación | Instalable en el móvil y preparada para futuras apps Android/iOS que consuman la misma API |

### Roles y permisos
- **Administrador**: todo su gimnasio, incluidos configuración, costos, auditoría y privacidad.
- **Entrenador**: solo los deportistas asignados (se verifica en cada endpoint). Revisa, modifica, aprueba o rechaza propuestas de IA.
- **Deportista**: solo sus propios datos. Completa la evaluación, ve sus planes activos y registra entrenamiento, medidas, alimentación y bienestar.
- El aislamiento entre gimnasios se aplica en todas las consultas mediante `gym_id`.

### Uso de la IA (solo 4 operaciones)
| Operación | Cuándo | Controles |
|---|---|---|
| Generación inicial | Tras la evaluación enviada. Entrenamiento y nutrición en **una sola solicitud** | Datos críticos completos, autorización médica si el cribado lo exige, biblioteca de al menos 8 ejercicios, máximo 3 por deportista |
| Ajuste quincenal | Cada ≥14 días (configurable), **máx. 2 al mes** por deportista | Exige al menos 2 sesiones registradas. El resumen del periodo se calcula en código |
| Actualización nutricional | Solo con cambios relevantes: peso ≥3 % (configurable), cambio de objetivo o restricciones, o justificación del entrenador | No se regenera automáticamente |
| Asistente administrativo | Cuando lo consulta el admin | Solo lectura, recibe datos agregados sin datos personales, límite diario |

Sin IA, con código convencional: registro diario, estadísticas, 1RM estimado, adherencia, comparativas, dashboards, notificaciones y recordatorios.

Control de costos: tokens de entrada, salida y caché por solicitud, costo con copia del precio usado, costo por deportista y por mes, presupuesto con alerta (umbral) y bloqueo al agotarse, reutilización de respuestas idénticas sin costo, bloqueo de solicitudes duplicadas simultáneas, historial completo y exportación CSV. El prompt de sistema (reglas y biblioteca) se marca para caché del proveedor.

Seguridad del contenido de la IA:
- Solo puede usar ejercicios de la biblioteca (los IDs desconocidos se descartan).
- Solo puede citar registros de conocimiento validados que se le entregan (las citas inventadas se descartan).
- Debe separar evidencia científica, experiencia práctica e inferencias, y señalar contradicciones.
- No diagnostica y deriva a profesionales cuando hay condiciones clínicas.
- **Nada llega al deportista sin aprobación del entrenador.**

---

## Puesta en marcha local

Requisitos: Node.js 22 o superior y PostgreSQL 14 o superior.

```bash
npm install
cp .env.example .env          # completa DATABASE_URL y APP_ENCRYPTION_KEY (ver comentarios)
npm run migrate
node scripts/bootstrap.js --gym "Nombre del gimnasio" --email admin@tu-gimnasio.com --name "Tu nombre"
# (pide la contraseña del administrador de forma interactiva)
node scripts/seed-exercises.js --gym <gym_id que imprime el paso anterior>   # opcional: 20 ejercicios base
npm start                     # http://localhost:3000
```

Para activar la IA, define `ANTHROPIC_API_KEY` en `.env`. Sin ella todo funciona excepto las 4 operaciones de IA, que responden "IA no configurada".

### Pruebas
```bash
createdb fitness_test   # base de datos exclusiva para pruebas (se reinicia en cada ejecución)
TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/fitness_test npm test
```

## Despliegue en producción
GitHub Pages **no** puede alojar esta aplicación porque necesita un servidor Node.js y PostgreSQL. Opciones recomendadas:
- **App**: Render, Railway, Fly.io o un VPS con `npm start` (el arranque aplica las migraciones).
- **Base de datos**: PostgreSQL gestionado (Neon, Supabase, Railway, RDS) con `DATABASE_SSL=true`.
- Variables de entorno: `NODE_ENV=production`, `APP_ORIGIN=https://tu-dominio`, `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`.
- Respaldos: `scripts/backup.sh` a diario, más una copia aparte de `APP_ENCRYPTION_KEY`.

---

## Estado por etapas

| # | Etapa | Estado |
|---|---|---|
| 1 | Infraestructura, autenticación, BD y permisos | ✅ Completa |
| 2 | Administrador, entrenadores y deportistas | ✅ Alta con contraseña temporal, capacidad contratada, asignación, activación/desactivación, restablecimiento |
| 3 | Evaluación inicial | ✅ Progresiva y retomable, salud cifrada, datos críticos, cribado, autorizaciones |
| 4 | Biblioteca deportiva | ✅ Alta, edición, clasificación y desactivación; ejercicios propuestos por IA pendientes de validar |
| 5 | Generación de entrenamiento y nutrición | ✅ Solicitud combinada, revisión del entrenador, edición antes de aprobar, rutina manual |
| 6 | Seguimiento y progreso | ✅ Sesiones/series/cargas/RIR, medidas, alimentación, bienestar, gráficos, adherencia, volumen por músculo |
| 7 | Ajustes quincenales | ✅ Cuotas, intervalo mínimo, datos mínimos, lista de cambios, aprobación |
| 8 | Centro de conocimiento y RAG | ✅ Científico/empírico, validación, versionado, trazabilidad de citas, búsqueda de texto completo |
| 9 | Asistente administrativo | ✅ Solo lectura, datos agregados, límite diario |
| 10 | Reportes, seguridad, optimización | ✅ Economía/margen, CSV, auditoría, exportación/eliminación de datos, respaldo |
| 11 | PWA y preparación móvil | ✅ Manifiesto, service worker, diseño móvil, API con token Bearer |

### Pendientes y dependencias
- **Clave de Anthropic** (`ANTHROPIC_API_KEY`): sin ella no se ha ejecutado ninguna llamada real a la IA. El motor está probado con un proveedor sustituto determinista en las pruebas automatizadas; falta validar la calidad de los planes reales con entrenadores.
- **Fotografías de progreso**: no implementadas todavía. Requieren almacenamiento privado de archivos (S3/R2 o similar) con URLs firmadas y el mismo control de acceso por asignación.
- **Notificaciones push/correo**: hoy son internas (campana). Enviarlas por correo o push requiere un proveedor (y sus credenciales).
- **Pasarela de pago** de la suscripción del gimnasio: no implementada (el modelo de cobro es una sola suscripción mensual; puede facturarse fuera del sistema al inicio).
- **Contenido**: el centro de conocimiento parte vacío a propósito (no se inventan referencias). La biblioteca base opcional no incluye imágenes ni videos; deben añadirse medios propios.
- Precio de lectura de caché de `claude-haiku-5-5` por verificar en la página oficial de precios (editable en Configuración → Avanzado).
