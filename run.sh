#!/bin/bash
# Wrapper that fetches a fresh GitHub token from the gh CLI before starting the MCP server
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export GITHUB_TOKEN=$(gh auth token 2>/dev/null)
exec node "$(dirname "$0")/dist/index.js"
