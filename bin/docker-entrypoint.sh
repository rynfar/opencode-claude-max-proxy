#!/bin/sh
# Docker entrypoint:
# 1. Fix volume permissions (root SSH writes credentials owned by root,
#    but the Meridian process runs as claude user and can't read them)
# 2. Symlink .claude.json into persistent volume
# 3. Drop privileges to claude user before running the supervisor
#
# Runs as root so chown works. Required because Railway SSH connects as
# root, so `claude login` writes credentials owned by root, but Meridian
# runs as the unprivileged claude user.

CLAUDE_DIR="/home/claude/.claude"
CLAUDE_JSON="/home/claude/.claude.json"
CLAUDE_JSON_VOL="$CLAUDE_DIR/.claude.json"

# Always fix ownership of the volume + credentials.
# Cheap if already correct, critical when root SSH wrote new files.
if [ -d "$CLAUDE_DIR" ]; then
  echo "[entrypoint] Fixing volume ownership: $CLAUDE_DIR -> claude:claude"
  chown -R claude:claude "$CLAUDE_DIR" 2>/dev/null || true
fi

# Symlink .claude.json into volume so it persists across restarts
if [ -f "$CLAUDE_JSON_VOL" ] && [ ! -f "$CLAUDE_JSON" ]; then
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
elif [ -f "$CLAUDE_JSON" ] && [ ! -L "$CLAUDE_JSON" ] && [ -w "$CLAUDE_DIR" ]; then
  cp "$CLAUDE_JSON" "$CLAUDE_JSON_VOL" 2>/dev/null
  rm -f "$CLAUDE_JSON"
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
fi

# Drop to claude user before running the supervisor.
# If already running as claude (e.g. local Docker without SSH), exec directly.
if [ "$(id -u)" = "0" ]; then
  echo "[entrypoint] Dropping privileges: root -> claude"
  exec su claude -s /bin/sh -c "$*"
else
  exec "$@"
fi
