#!/bin/sh
set -eu
database_path=${BIFURCATION_DATABASE_PATH:-./data/bifurcation.sqlite}
mkdir -p "$(dirname "$database_path")"
# The lock is held across exec and shared with the offline restore command.
# It prevents two panel processes from owning the same database/connection hub.
exec flock --exclusive --nonblock --no-fork -E 73 "$database_path.lock" \
  /bin/sh -c 'node scripts/migrate.mjs && exec node server.js'
