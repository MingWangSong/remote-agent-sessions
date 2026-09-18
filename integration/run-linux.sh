#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update
apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends nodejs tmux git
mkdir -p /app/node_modules /app/integration
cp -R /src/src /src/test /app/
cp /src/package.json /app/
cp /src/integration/tmux.integration.js /app/integration/
for dependency in proper-lockfile graceful-fs retry signal-exit; do
  cp -R "/src/node_modules/$dependency" /app/node_modules/
done
cd /app
node --version
tmux -V
for source in src/*.js; do node --check "$source"; done
node --test test/*.test.js
node --test --test-concurrency=1 integration/tmux.integration.js
