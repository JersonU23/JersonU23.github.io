# Despliegue de FITNESS AI en producción

La aplicación necesita **un servidor Node.js 22** y **una base de datos PostgreSQL**. GitHub Pages no sirve porque solo aloja archivos estáticos.

Hay dos caminos. Ambos usan los archivos incluidos en el repositorio.

| Opción | Archivo | Para quién |
|---|---|---|
| A. Render (recomendada) | `render.yaml` | Configuración guiada, base de datos incluida, sin administrar servidores |
| B. Docker (Railway, Fly.io, VPS…) | `Dockerfile` | Cualquier proveedor que ejecute contenedores |

> Los planes y precios los fija cada proveedor y cambian con el tiempo. Revísalos en su web antes de confirmar. Registra después los importes reales facturados en **Configuración → Avanzado → Costos operativos** para que el cálculo de margen sea real.

---

## A. Render con Blueprint

1. Crea una cuenta en https://render.com y conecta tu GitHub.
2. **New → Blueprint** → elige el repositorio `JersonU23.github.io` y la rama con el código (`claude/fitness-ai-platform-gcojms` o `main` si ya la fusionaste).
3. Render lee `render.yaml` y propone crear:
   - la base de datos PostgreSQL `fitness-ai-db`;
   - el servicio web `fitness-ai`.
4. Te pedirá dos valores:
   - `APP_ORIGIN`: la URL pública del servicio, p. ej. `https://fitness-ai.onrender.com` (o tu dominio propio). Debe coincidir exactamente, sin `/` final; se usa para la protección CSRF.
   - `ANTHROPIC_API_KEY`: tu clave de https://console.anthropic.com. Puedes dejarla vacía y añadirla después; sin ella la IA queda desactivada.
5. Si los planes indicados en `render.yaml` (`basic-256mb` para la base de datos y `starter` para la web) no existen o prefieres otros, cámbialos en el formulario.
6. Confirma. Al arrancar, el servidor aplica las migraciones automáticamente. Comprueba `https://TU-URL/api/health`, que debe responder `{"ok":true}`.
7. **Guarda la clave de cifrado:** en el servicio → *Environment*, copia `APP_ENCRYPTION_KEY` a un gestor de contraseñas. Si se pierde o se cambia, los datos de salud ya guardados no se pueden leer.
8. **Crea el gimnasio y el administrador:** en el servicio → *Shell*:
   ```bash
   node scripts/bootstrap.js --gym "Nombre del gimnasio" --email admin@tu-gimnasio.com --name "Nombre Apellido" --capacity 300
   ```
   El script pide la contraseña (mínimo 10 caracteres, con letras y números). Imprime el `gym_id`.
9. *(Opcional)* Biblioteca base de 20 ejercicios:
   ```bash
   node scripts/seed-exercises.js --gym <gym_id>
   ```
10. Entra en la URL pública con el administrador y revisa **Configuración**: presupuesto de IA, tarifa mensual y costos operativos.

## B. Docker (cualquier proveedor)

```bash
docker build -t fitness-ai .
docker run -d -p 3000:3000 \
  -e NODE_ENV=production \
  -e APP_ORIGIN=https://tu-dominio \
  -e DATABASE_URL=postgres://usuario:clave@host:5432/base \
  -e DATABASE_SSL=true \
  -e APP_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
  -e ANTHROPIC_API_KEY=... \
  fitness-ai
```

- `DATABASE_SSL`: `true` para bases gestionadas con certificado público (Neon, Supabase, RDS); `no-verify` solo si el proveedor usa un certificado propio; `false` en red privada.
- Genera `APP_ENCRYPTION_KEY` **una sola vez** y guárdala; no la regeneres en cada despliegue.
- La imagen se ejecuta sin privilegios de root, incluye `HEALTHCHECK` sobre `/api/health` y aplica las migraciones al arrancar.
- Luego crea el gimnasio con `docker exec -it <contenedor> node scripts/bootstrap.js ...` (mismos pasos 8–9).

---

## Después del despliegue

- **HTTPS obligatorio.** Render y Railway lo dan por defecto. En un VPS usa un proxy (Caddy o Nginx con Let's Encrypt). En producción la cookie de sesión solo viaja por HTTPS.
- **Respaldos.** Además de los respaldos automáticos del proveedor, programa `scripts/backup.sh` (requiere `pg_dump`) y guarda los archivos fuera del servidor.
- **Presupuesto de IA.** Fija un presupuesto mensual prudente al inicio y revisa **IA y costos** la primera semana para conocer el costo real por generación.
- **Modelo de IA.** Por defecto `claude-opus-5-5`. `claude-sonnet-5-5` y `claude-haiku-5-5` cuestan menos por token; cámbialo en **Configuración → Avanzado** si la calidad de los planes lo permite.
- **Dominio propio.** Si cambias de URL, actualiza `APP_ORIGIN`.

## Verificación realizada antes de entregar

- La imagen Docker se construyó y se ejecutó en modo producción contra una base de datos vacía: aplicó la migración, respondió `/api/health`, envió las cabeceras HSTS y CSP, corrió como usuario `node` y pasó el `HEALTHCHECK`.
- `render.yaml` **no se pudo probar** contra Render desde el entorno de desarrollo. Su sintaxis sigue el formato de Blueprint, pero revisa en el asistente de Render que los planes y campos sean aceptados.
