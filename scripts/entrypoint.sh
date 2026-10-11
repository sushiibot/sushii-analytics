#!/bin/bash
set -euo pipefail

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
	# Last year's members file is only live in January. After that it may have
	# been deleted on purpose, and restoring it would bring the data back.
	targets=("privacy.sqlite" "$year/guild.sqlite" "$year/members.sqlite" "$((year - 1))/guild.sqlite")
	if [ "$(TZ=Asia/Seoul date +%m)" = "01" ]; then
		targets+=("$((year - 1))/members.sqlite")
	fi

	echo "dbs:" >"$restore_cfg"
	for rel in "${targets[@]}"; do
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

	for rel in "${targets[@]}"; do
		mkdir -p "$(dirname "$DATA_DIR/$rel")"
		litestream restore -config "$restore_cfg" -if-db-not-exists -if-replica-exists "$DATA_DIR/$rel"
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
