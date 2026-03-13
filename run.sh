#!/bin/bash
# Extends PATH to include Homebrew locations so gh is found when launched from
# GUI apps (e.g. Claude Desktop) that don't inherit the user's shell PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Fetch a fresh GitHub token from the gh CLI so no token is ever hardcoded.
export GITHUB_TOKEN=$(gh auth token 2>/dev/null)
exec node "$(dirname "$0")/dist/index.js"
