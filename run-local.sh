#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ ! -x "$root/.venv/bin/python" ]; then
    printf '%s\n' '请先建立 .venv 并安装 app/requirements.txt 中的依赖。' >&2
    exit 1
fi

umask 077
export BANXUEPAW_DATA_DIR="${BANXUEPAW_DATA_DIR:-$root/.local/demo}"
export BANXUEPAW_MATERIALS_DIR="${BANXUEPAW_MATERIALS_DIR:-$root/教材}"
export BANXUEPAW_PACK_DIR="${BANXUEPAW_PACK_DIR:-$root/output/pdf}"
export BANXUEPAW_ARENA_DATA="${BANXUEPAW_ARENA_DATA:-$root/app/arena-data.bwa}"
export BANXUEPAW_ENV_FILE="${BANXUEPAW_ENV_FILE:-$root/.env.local}"
: "${PORT:=18768}"
export PORT
unset APP_PUBLIC_URL
unset SECURE_COOKIES
exec "$root/.venv/bin/python" "$root/app/server.py"
