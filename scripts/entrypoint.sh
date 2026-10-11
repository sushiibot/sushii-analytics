#!/bin/bash
set -euo pipefail

# Secrets arrive as files (compose `secrets:`, stored on encrypted storage) so they
# never appear in the compose file or Docker's container config on the plain disk.
if [ -d /run/secrets ]; then
	for f in /run/secrets/*; do
		[ -f "$f" ] || continue
		name=$(basename "$f" | tr '[:lower:]' '[:upper:]')
		if [ -z "${!name:-}" ]; then
			export "$name=$(cat "$f")"
		fi
	done
fi

DATA_DIR=${DATA_DIR:-"/app/data/v2"}
export DATA_DIR
mkdir -p "$DATA_DIR"

if [ "${REPLICATE_DB:-false}" = "true" ] || [ "${RESTORE_DB:-false}" = "true" ]; then
	# An empty key must never fall through to unencrypted uploads.
	if [ -z "${LITESTREAM_SSE_CUSTOMER_KEY:-}" ]; then
		echo "LITESTREAM_SSE_CUSTOMER_KEY is not set; refusing to replicate unencrypted" >&2
		exit 1
	fi
fi

# Year files are keyed by KST year.
year=$(TZ=Asia/Seoul date +%Y)

if [ "${RESTORE_DB:-false}" = "true" ]; then
	# `litestream restore` only resolves explicit `path:` entries, not `dir:`
	# replication, so list the files that can be live right now.
	restore_cfg=$(mktemp)
	trap 'rm -f "$restore_cfg"' EXIT
	# Required: this year's files. If one is missing locally and can't be restored,
	# starting would create an empty file that Litestream then replicates over the
	# real backup, so fail instead.
	required=("privacy.sqlite" "$year/guild.sqlite" "$year/members.sqlite")
	# Optional: older files that may legitimately be gone. Last year's members file
	# and the guild file from two years ago are only live in January; after that they
	# may have been deleted on purpose, and restoring would bring the data back.
	optional=("$((year - 1))/guild.sqlite")
	if [ "$(TZ=Asia/Seoul date +%m)" = "01" ]; then
		optional+=("$((year - 1))/members.sqlite" "$((year - 2))/guild.sqlite")
	fi

	echo "dbs:" >"$restore_cfg"
	for rel in "${required[@]}" "${optional[@]}"; do
		cat >>"$restore_cfg" <<EOF
  - path: $DATA_DIR/$rel
    replica:
      type: s3
      bucket: \${LITESTREAM_BUCKET}
      path: \${LITESTREAM_PATH}/$rel
      endpoint: \${LITESTREAM_ENDPOINT}
      force-path-style: true
      sign-payload: true
      sse-customer-algorithm: AES256
      sse-customer-key: \${LITESTREAM_SSE_CUSTOMER_KEY}
EOF
	done

	# Existing local files skip the restore, so a normal restart never needs B2.
	for rel in "${required[@]}"; do
		[ -f "$DATA_DIR/$rel" ] && continue
		mkdir -p "$(dirname "$DATA_DIR/$rel")"
		litestream restore -config "$restore_cfg" -if-replica-exists "$DATA_DIR/$rel"
	done
	for rel in "${optional[@]}"; do
		[ -f "$DATA_DIR/$rel" ] && continue
		mkdir -p "$(dirname "$DATA_DIR/$rel")"
		litestream restore -config "$restore_cfg" -if-replica-exists "$DATA_DIR/$rel" ||
			echo "Optional restore of $rel failed; continuing" >&2
	done
	rm -f "$restore_cfg"
	trap - EXIT
fi

if [ "${REPLICATE_DB:-false}" = "true" ]; then
	echo "Running with Litestream replication of $DATA_DIR"
	exec litestream replicate -config /etc/litestream.yml -exec "bun run /app/src/index.ts"
else
	echo "REPLICATE_DB != true, running without replication"
	exec bun run /app/src/index.ts
fi
