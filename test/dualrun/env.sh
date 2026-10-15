#!/bin/bash
# one side's environment: $1 a name, $2 the frontend port, $3 the ingress port
set -u
root="${DUALRUN_DIR:-/tmp/dualrun}/$1"
mkdir -p "$root"/{state,files,home,config}
export STATE_DIR="$root/state" HOME_FS="$root/home" FILES_ROOT="$root/files" SHARE_ROOT="$root/shares"
export SERVICES_FILE="$root/config/services.export" PHOSPHORUS_INI_FILE="$root/config/phosphorus.ini"
export VERSION_FILE="$root/VERSION" FRONTEND_PORT="$2" INGRESS_PORT="$3" SELF_HOST=dualrun BASE_DOMAIN=example.test
export ADMIN_PASS=adminpass GAME_DNS_PORT=0 OPENCODE_BIN=/nonexistent PHOSPHORUS_FEED_URL=http://127.0.0.1:1/latest.json
export POLL_INTERVAL_MS=100 IDLE_POLL_INTERVAL_MS=500
