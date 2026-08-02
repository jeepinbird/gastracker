#!/bin/sh
# Drops root and fixes ownership of the data dir before starting the app.
# Unraid mounts /mnt/user/appdata/... as root:root, which a non-root process
# can't write to — so PUID/PGID (default 99:100, Unraid's nobody:users) decide
# who we run as. Started with --user already set? Then we're not root and just
# exec straight through.
set -e

DATA_DIR="${GASTRACKER_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-99}"
  PGID="${PGID:-100}"
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u:%g "$DATA_DIR")" != "$PUID:$PGID" ]; then
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

mkdir -p "$DATA_DIR"
exec "$@"
