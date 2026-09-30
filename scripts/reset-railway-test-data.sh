#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
ssh_key=${HPLUSECO_RAILWAY_SSH_KEY:-"$HOME/.ssh/hpluseco_railway"}
backup_dir=${HPLUSECO_DB_BACKUP_DIR:-"$HOME/hpluseco-db-backups"}
railway_ssh=(railway ssh --project 8e8e2014-99a9-4ed0-bb7c-f69f320ffcfe --service Postgres --environment production --identity-file "$ssh_key")

if [[ ! -f "$ssh_key" ]]; then
  printf 'Railway workspace SSH key not found: %s\n' "$ssh_key" >&2
  exit 1
fi
umask 077
mkdir -p -m 700 "$backup_dir"

printf 'Railway production / Postgres: current row counts\n'
"${railway_ssh[@]}" psql -X -v ON_ERROR_STOP=1 -v apply=0 -f - < "$script_dir/reset-railway-test-data.sql"

backup_file=$(mktemp "$backup_dir/app-$(date -u +%Y%m%dT%H%M%SZ).dump.XXXXXX")
if ! "${railway_ssh[@]}" pg_dump --format=custom --schema=app --no-owner --no-privileges > "$backup_file"; then
  rm -f "$backup_file"
  exit 1
fi
if ! "${railway_ssh[@]}" pg_restore --file=/dev/null < "$backup_file"; then
  rm -f "$backup_file"
  exit 1
fi
printf 'Backup verified: %s\n' "$backup_file"

read -r -p 'Type RESET production to clear the listed test data: ' confirmation
if [[ $confirmation != 'RESET production' ]]; then
  printf 'Cancelled. Backup retained: %s\n' "$backup_file"
  exit 1
fi

"${railway_ssh[@]}" psql -X -v ON_ERROR_STOP=1 -v apply=1 -f - < "$script_dir/reset-railway-test-data.sql"
printf 'Reset complete. Backup retained: %s\n' "$backup_file"
