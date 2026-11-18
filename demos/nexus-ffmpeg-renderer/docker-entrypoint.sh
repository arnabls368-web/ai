#!/bin/sh
set -eu

mkdir -p /assets /work

if [ "$(id -u)" -eq 0 ]; then
  # Railway mounts volumes as root. Change only the mount roots; never recurse
  # through existing job data, then permanently drop privileges for the app.
  chown node:node /assets /work
  exec gosu node "$@"
fi

# Local/non-Railway runs use the image's non-root USER. Fail clearly rather
# than attempting privileged ownership changes on an incompatible mount.
if [ ! -w /assets ] || [ ! -w /work ]; then
  echo "Renderer storage is not writable by UID $(id -u); on Railway set RAILWAY_RUN_UID=0 so the entrypoint can initialize volume permissions." >&2
  exit 1
fi

exec "$@"
