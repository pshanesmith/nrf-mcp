#!/bin/bash
# Extends PATH to include Homebrew locations so gh is found when launched from
# GUI apps (e.g. Claude Desktop) that don't inherit the user's shell PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Fetch a fresh GitHub token from the gh CLI so no token is ever hardcoded.
export GITHUB_TOKEN=$(gh auth token 2>/dev/null)
if [ -z "$GITHUB_TOKEN" ]; then
  echo "Warning: gh auth token returned empty — running without authentication (60 req/hour limit)." >&2
  echo "Run 'gh auth login' to authenticate." >&2
fi
exec node "$(dirname "$0")/dist/index.js"
