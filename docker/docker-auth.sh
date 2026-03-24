#!/bin/bash
# Copy Claude credentials from host into Docker container.
#
# macOS stores scopes in Keychain, so the credentials file has scopes: ""
# Linux Claude CLI needs scopes as an array. This script fixes the format.
#
# Usage: ./bin/docker-auth.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

HOST_CREDS="$HOME/.claude/.credentials.json"

if [ ! -f "$HOST_CREDS" ]; then
  echo "❌ No credentials found at $HOST_CREDS"
  echo "   Run 'claude login' on your host first."
  exit 1
fi

# Check if host is logged in
if ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
  echo "❌ Not logged in on host. Run 'claude login' first."
  exit 1
fi

echo "📋 Reading credentials from host..."

# Fix the scopes field and copy into container
python3 -c "
import json, sys

with open('$HOST_CREDS') as f:
    creds = json.load(f)

oauth = creds.get('claudeAiOauth', {})
if not oauth.get('accessToken'):
    print('❌ No access token found in credentials')
    sys.exit(1)

# Fix scopes: empty string -> proper array
if not oauth.get('scopes') or oauth['scopes'] == '':
    oauth['scopes'] = [
        'user:profile',
        'user:inference', 
        'user:sessions:claude_code',
        'user:mcp_servers',
        'user:file_upload'
    ]

creds['claudeAiOauth'] = oauth
print(json.dumps(creds))
" | docker compose exec -T proxy bash -c 'cat > /home/claude/.claude/.credentials.json'

if [ $? -ne 0 ]; then
  echo "❌ Failed to copy credentials. Is the container running?"
  echo "   Run 'docker compose up -d' first."
  exit 1
fi

# Also copy .claude.json if it exists
if [ -f "$HOME/.claude/.claude.json" ]; then
  docker compose exec -T proxy bash -c 'cat > /home/claude/.claude/.claude.json' < "$HOME/.claude/.claude.json"
fi

# Verify
echo "🔍 Verifying..."
AUTH=$(docker compose exec proxy claude auth status 2>&1)
if echo "$AUTH" | grep -q '"loggedIn": true'; then
  EMAIL=$(echo "$AUTH" | grep -o '"email": "[^"]*"' | head -1)
  echo "✅ Docker container authenticated! $EMAIL"
else
  echo "❌ Authentication failed inside container"
  echo "$AUTH"
  exit 1
fi
