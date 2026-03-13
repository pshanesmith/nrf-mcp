#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const require = createRequire(import.meta.url);
const DEFAULT_REF: string = require("../package.json").nrfSdkRef;

const REPO = "nrfconnect/sdk-nrf";
const REF = process.env.NRF_SDK_REF ?? DEFAULT_REF;
const BASE_URL = "https://api.github.com";

const token = process.env.GITHUB_TOKEN;

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nrf-mcp/1.0",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function githubGet(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text();
    // Surface rate limit info if that's the issue
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (response.status === 403 && remaining === "0" && reset) {
      const resetTime = new Date(parseInt(reset) * 1000).toISOString();
      throw new Error(`GitHub rate limit exceeded. Resets at ${resetTime}. Set GITHUB_TOKEN for higher limits.`);
    }
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }
  return response.json();
}

function encodePath(path: string): string {
  // Encode each path segment individually, preserving slashes
  return path.split("/").map(encodeURIComponent).join("/");
}

const TOOLS: Tool[] = [
  {
    name: "nrf_list",
    description: `List the contents of a directory in the nRF Connect SDK repo (nrfconnect/sdk-nrf @ ${REF}).

Useful starting paths:
- "doc/nrf"                    → Documentation root (RST files)
- "doc/nrf/protocols"          → Bluetooth, LTE, Thread, Zigbee docs
- "doc/nrf/libraries"          → Library reference docs
- "doc/nrf/applications"       → Application-level docs
- "samples"                    → All sample projects
- "samples/bluetooth"          → Bluetooth LE samples
- "samples/cellular"           → LTE/cellular modem samples
- "samples/matter"             → Matter protocol samples
- "samples/nfc"                → NFC samples
- "samples/tfm"                → Trusted Firmware-M samples
- "samples/crypto"             → Cryptography samples

Returns dirs first, then files, with full paths you can pass to nrf_read.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path within the repo (e.g. 'samples/bluetooth')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "nrf_read",
    description: `Read the contents of a file from the nRF Connect SDK repo (nrfconnect/sdk-nrf @ ${REF}).

Works for any text file: .rst documentation, .c/.h source, CMakeLists.txt, Kconfig, prj.conf, .yaml, README.rst, etc.

Use nrf_list to discover paths first. Examples:
- "samples/bluetooth/central_bas/README.rst"
- "samples/bluetooth/central_bas/src/main.c"
- "samples/bluetooth/central_bas/CMakeLists.txt"
- "samples/bluetooth/central_bas/prj.conf"`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path within the repo (e.g. 'samples/bluetooth/central_bas/src/main.c')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "nrf_search",
    description: `Search for code or documentation across the nRF Connect SDK repo using GitHub code search.

Supports GitHub search qualifiers to narrow results:
- Plain keyword:        "DFU_TARGET_IMAGE_TYPE_ANY"
- Docs only:           "FOTA path:doc/nrf"
- Samples only:        "peripheral_hr path:samples"
- Specific extension:  "CONFIG_BT_PERIPHERAL extension:conf"
- Source files only:   "bt_le_adv_start extension:c"
- Headers only:        "struct bt_conn extension:h"

Returns matching file paths (up to 20). Use nrf_read to fetch the content.
Note: Requires GITHUB_TOKEN for reliable results (unauthenticated search is heavily rate-limited).
Note: GitHub code search always indexes the default branch (main), not the pinned NRF_SDK_REF. Use nrf_read with the discovered paths to fetch content at the configured ref.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms with optional GitHub qualifiers (path:, extension:, filename:)",
        },
      },
      required: ["query"],
    },
  },
];

const server = new Server(
  { name: "nrf-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "nrf_list") {
      const path = (args as { path: string }).path.replace(/^\/+|\/+$/g, "");
      const url = `${BASE_URL}/repos/${REPO}/contents/${encodePath(path)}?ref=${REF}`;
      const data = await githubGet(url);

      if (!Array.isArray(data)) {
        return {
          content: [{ type: "text", text: `'${path}' is a file, not a directory. Use nrf_read to read it.` }],
        };
      }

      const items = (data as Array<{ name: string; path: string; type: string }>)
        .sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "dir" ? -1 : 1;
        })
        .map((item) => `${item.type === "dir" ? "[dir] " : "[file]"} ${item.path}`)
        .join("\n");

      return {
        content: [{ type: "text", text: items || "Empty directory" }],
      };
    }

    if (name === "nrf_read") {
      const path = (args as { path: string }).path.replace(/^\/+|\/+$/g, "");
      const url = `${BASE_URL}/repos/${REPO}/contents/${encodePath(path)}?ref=${REF}`;
      const data = await githubGet(url) as {
        type?: string;
        size?: number;
        content?: string;
        encoding?: string;
      };

      if (Array.isArray(data)) {
        return {
          content: [{ type: "text", text: `'${path}' is a directory. Use nrf_list to browse it.` }],
        };
      }

      const size = data.size ?? 0;
      if (size > 500_000) {
        return {
          content: [{
            type: "text",
            text: `File is too large to read directly (${(size / 1024).toFixed(0)} KB). Consider browsing the directory and reading specific source files.`,
          }],
        };
      }

      if (!data.content) {
        return {
          content: [{ type: "text", text: `No text content available for '${path}' (may be a binary file).` }],
        };
      }

      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    }

    if (name === "nrf_search") {
      const query = (args as { query: string }).query;
      const fullQuery = `${query} repo:${REPO}`;
      const url = `${BASE_URL}/search/code?q=${encodeURIComponent(fullQuery)}&per_page=20`;
      const data = await githubGet(url) as {
        total_count: number;
        items: Array<{ path: string; name: string }>;
      };

      if (!data.items || data.items.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for: ${query}` }],
        };
      }

      const results = data.items.map((item) => item.path).join("\n");
      const text = `Found ${data.total_count} result(s) (showing up to 20):\n\n${results}`;
      return {
        content: [{ type: "text", text }],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`nrf-mcp running (repo: ${REPO} @ ${REF})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
