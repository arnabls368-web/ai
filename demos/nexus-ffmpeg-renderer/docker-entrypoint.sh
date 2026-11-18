#!/bin/sh
set -eu

mkdir -p /assets /work
chown node:node /assets /work

exec gosu node "$@"
