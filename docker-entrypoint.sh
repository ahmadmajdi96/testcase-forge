#!/bin/sh
set -e

# Runtime directories must be writable by the unprivileged app user (node).
#
# /data/run-workspaces is a HOST bind-mount — it has to be, so the host Docker
# daemon can bind-mount each run's subdirectory into the sibling Playwright
# container. A bind-mount keeps the host directory's ownership (often root), so
# the container's node user cannot mkdir inside it. Fixing ownership here at
# startup avoids requiring a manual chown on the server (EACCES on mkdir).
#
# /data/artifacts is a named volume, already node-owned from the image, but we
# normalise it too so an externally-mounted path also works.
mkdir -p /data/run-workspaces /data/artifacts
# Clear leftover run workspaces from a previous container lifecycle. In-memory
# run state does not survive a restart, so nothing here is live. Done as root so
# root-owned files written by sibling Playwright containers are removable.
rm -rf /data/run-workspaces/* 2>/dev/null || true
chown -R node:node /data/run-workspaces 2>/dev/null || true
chown node:node /data/artifacts 2>/dev/null || true

# Drop from root to the app user. su-exec is a tiny Alpine setuid helper.
if command -v su-exec >/dev/null 2>&1; then
  exec su-exec node "$@"
fi

# Fallback (su-exec unavailable): run as-is rather than failing to boot.
exec "$@"
