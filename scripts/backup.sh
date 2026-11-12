#!/usr/bin/env bash
# Respaldo de la base de datos de FITNESS AI (formato custom de pg_dump, comprimido).
# Uso: DATABASE_URL=postgres://... ./scripts/backup.sh [directorio]
# Recomendado: programarlo a diario (cron o tarea del proveedor) y copiar los archivos fuera del servidor.
# IMPORTANTE: respalda también APP_ENCRYPTION_KEY por separado; sin ella los datos de salud cifrados no se pueden leer.
set -euo pipefail
: "${DATABASE_URL:?Define DATABASE_URL}"
DIR="${1:-backups}"
mkdir -p "$DIR"
FILE="$DIR/fitness-ai-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$FILE"
echo "Respaldo creado: $FILE"
# Restaurar: pg_restore --clean --no-owner --dbname="$DATABASE_URL" "$FILE"
