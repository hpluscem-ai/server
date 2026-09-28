#!/usr/bin/env bash
set -eu
umask 077

command -v rclone >/dev/null
: "${SUPABASE_S3_ENDPOINT:?required}"
: "${SUPABASE_S3_REGION:?required}"
: "${SUPABASE_STORAGE_BUCKET:?required}"
: "${SUPABASE_S3_ACCESS_KEY_ID:?required}"
: "${SUPABASE_S3_SECRET_ACCESS_KEY:?required}"
: "${S3_ENDPOINT:?required}"
: "${S3_REGION:?required}"
: "${S3_BUCKET:?required}"
: "${S3_ACCESS_KEY_ID:?required}"
: "${S3_SECRET_ACCESS_KEY:?required}"

case "$SUPABASE_S3_ENDPOINT" in https://*) ;; *) exit 1 ;; esac
case "$S3_ENDPOINT" in https://*) ;; *) exit 1 ;; esac
case "${S3_FORCE_PATH_STYLE-false}" in true|false) ;; *) exit 1 ;; esac
if [ "${SUPABASE_S3_ENDPOINT%/}/$SUPABASE_STORAGE_BUCKET" = "${S3_ENDPOINT%/}/$S3_BUCKET" ]; then
  printf 'Source and destination must differ.\n' >&2
  exit 1
fi

export RCLONE_CONFIG_SOURCE_TYPE=s3 RCLONE_CONFIG_SOURCE_PROVIDER=Other
export RCLONE_CONFIG_SOURCE_ENV_AUTH=false RCLONE_CONFIG_SOURCE_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_SOURCE_ENDPOINT="$SUPABASE_S3_ENDPOINT"
export RCLONE_CONFIG_SOURCE_REGION="$SUPABASE_S3_REGION"
export RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID="$SUPABASE_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY="$SUPABASE_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_SOURCE_FORCE_PATH_STYLE=true

export RCLONE_CONFIG_DESTINATION_TYPE=s3 RCLONE_CONFIG_DESTINATION_PROVIDER=Other
export RCLONE_CONFIG_DESTINATION_ENV_AUTH=false RCLONE_CONFIG_DESTINATION_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_DESTINATION_ENDPOINT="$S3_ENDPOINT"
export RCLONE_CONFIG_DESTINATION_REGION="$S3_REGION"
export RCLONE_CONFIG_DESTINATION_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_DESTINATION_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_DESTINATION_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE-false}"

transfer_dir=$(mktemp -d "${TMPDIR:-/tmp}/hpluseco-storage-transfer.XXXXXX")
transfer_log="$transfer_dir/rclone.log"
trap 'printf "Storage transfer stopped. Inspect the private log: %s\n" "$transfer_log" >&2' ERR
source_bucket="source:$SUPABASE_STORAGE_BUCKET"
destination_bucket="destination:$S3_BUCKET"

rclone size --config /dev/null --log-file "$transfer_log" --json "$source_bucket"
rclone copy --config /dev/null --log-file "$transfer_log" --stats 0 \
  --immutable --metadata --transfers 2 --checkers 2 "$source_bucket" "$destination_bucket"
rclone check --config /dev/null --log-file "$transfer_log" --stats 0 \
  --download --one-way --checkers 2 "$source_bucket" "$destination_bucket"
rclone size --config /dev/null --log-file "$transfer_log" --json "$destination_bucket"
printf 'Storage copy verification passed. Cutover verification is still required.\n'
