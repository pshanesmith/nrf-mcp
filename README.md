# nrf-mcp

MCP server for Nordic nRF Connect SDK development. Provides Claude with tools to browse documentation and sample code from the [nrfconnect/sdk-nrf](https://github.com/nrfconnect/sdk-nrf) repository.

## Tools

| Tool | Description |
|---|---|
| `nrf_list` | List files and directories at a given path in the SDK repo |
| `nrf_read` | Read a file's contents (`.rst` docs, `.c`/`.h` source, `CMakeLists.txt`, `prj.conf`, etc.) |
| `nrf_search` | Search across the repo using GitHub code search with qualifier support |

### Search examples

```
# Find all uses of a symbol
DFU_TARGET_IMAGE_TYPE_ANY

# Search docs only
FOTA path:doc/nrf

# Search samples only
peripheral_hr path:samples

# Filter by file type
CONFIG_BT_PERIPHERAL extension:conf
bt_le_adv_start extension:c
```

## Setup

### Prerequisites

- Node.js 18+
- [GitHub CLI (`gh`)](https://cli.github.com/) authenticated — used to supply a GitHub token at runtime

### Install and build

```bash
npm install
npm run build
```

### Register with Claude Code

```bash
claude mcp add -s user nrf-mcp -- /path/to/nrf-mcp/run.sh
```

### Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nrf-mcp": {
      "command": "/path/to/nrf-mcp/run.sh",
      "args": []
    }
  }
}
```

Then restart Claude Desktop.

The `run.sh` wrapper fetches a fresh token from `gh auth token` each time the server starts, so no token is ever hardcoded.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `NRF_SDK_REF` | `main` (set via `nrfSdkRef` in `package.json`) | SDK version to target — any git ref (tag, branch, commit SHA) |
| `GITHUB_TOKEN` | *(from `gh auth token`)* | GitHub API token; set explicitly to bypass the `gh` CLI |

To target a different SDK version, set the env var in the MCP registration:

```bash
claude mcp remove nrf-mcp
claude mcp add -s user -e NRF_SDK_REF=v3.2.4 nrf-mcp -- /path/to/nrf-mcp/run.sh
```

### Rebuild after changes

```bash
npm run build
```

During development, use `npm run watch` to recompile automatically on save.

## Testing

Run the end-to-end test suite (requires `gh` to be authenticated):

```bash
npm test
```

The tests spawn the server via `run.sh`, exercise all three tools, and validate input error handling.

## Troubleshooting

**`gh: command not found` or empty token**
The `run.sh` script fetches a token via `gh auth token`. Make sure the GitHub CLI is installed and you are logged in:
```bash
gh auth login
gh auth token   # should print a token
```

**`GitHub API 401` errors**
`nrf_search` requires authentication. If the token is missing or expired, re-authenticate with `gh auth login`. For Claude Desktop, ensure `run.sh` is executable (`chmod +x run.sh`) — it prepends the Homebrew bin path to find `gh`.

**`GitHub rate limit exceeded`**
Unauthenticated requests are limited to 60/hour. With a valid `GITHUB_TOKEN` the limit is 5 000/hour. Ensure `gh auth token` returns a token and that `run.sh` is being used (not `node dist/index.js` directly).

**Tools not appearing in Claude**
- *Claude Code:* run `claude mcp list` to confirm `nrf-mcp` is registered, then restart the session.
- *Claude Desktop:* restart the app after editing `claude_desktop_config.json`. Check the Desktop developer console for MCP startup errors.

**Wrong SDK version**
Confirm the active ref with `echo $NRF_SDK_REF` in the same shell, or check what's registered:
```bash
claude mcp list   # shows the -e env vars set at registration time
```
To change it, remove and re-add the registration with the new `-e NRF_SDK_REF=` value.
