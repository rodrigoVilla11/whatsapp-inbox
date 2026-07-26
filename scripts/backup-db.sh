#!/bin/sh
# ── Backup diario de Postgres a R2 (fase 10) ─────────────────────────────
# pg_dump comprimido → bucket de BACKUPS (separado del de media),
# retención 14 días. Pensado para correr como servicio cron en Easypanel
# (o cron del VPS) con estas env:
#   DATABASE_URL, R2_BACKUP_ENDPOINT, R2_BACKUP_ACCESS_KEY_ID,
#   R2_BACKUP_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
# Requiere: postgresql-client (pg_dump) y aws-cli v2 (S3-compatible).
set -eu

RETENTION_DAYS=14
STAMP="$(date -u +%Y-%m-%d_%H%M%S)"
FILE="whatsapp-inbox_${STAMP}.sql.gz"

export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
AWS="aws --endpoint-url $R2_BACKUP_ENDPOINT"

echo "backup: dump → ${FILE}"
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -6 > "/tmp/${FILE}"

echo "backup: subiendo a s3://${R2_BACKUP_BUCKET}/pg/"
$AWS s3 cp "/tmp/${FILE}" "s3://${R2_BACKUP_BUCKET}/pg/${FILE}" --only-show-errors
rm -f "/tmp/${FILE}"

# Retención: borrar objetos de más de RETENTION_DAYS (por fecha en el nombre)
CUTOFF="$(date -u -d "-${RETENTION_DAYS} days" +%Y-%m-%d 2>/dev/null \
  || date -u -v -"${RETENTION_DAYS}"d +%Y-%m-%d)"
echo "backup: podando anteriores a ${CUTOFF}"
$AWS s3 ls "s3://${R2_BACKUP_BUCKET}/pg/" | while read -r _d _t _s key; do
  fecha="$(echo "$key" | sed -n 's/^whatsapp-inbox_\([0-9-]*\)_.*$/\1/p')"
  if [ -n "$fecha" ] && [ "$fecha" \< "$CUTOFF" ]; then
    echo "backup: borrando ${key}"
    $AWS s3 rm "s3://${R2_BACKUP_BUCKET}/pg/${key}" --only-show-errors
  fi
done

echo "backup: OK (${FILE})"
