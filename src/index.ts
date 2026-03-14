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
const pkg = require("../package.json") as { nrfSdkRef: string; version: string };
const DEFAULT_REF: string = pkg.nrfSdkRef;

const REPO = "nrfconnect/sdk-nrf";
const REF = process.env.NRF_SDK_REF ?? DEFAULT_REF;
const BASE_URL = "https://api.github.com";

const token = process.env.GITHUB_TOKEN;

// ---------------------------------------------------------------------------
// Cache — simple TTL map for immutable ref content
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expires: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 500;

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function cacheSet<T>(key: string, data: T): void {
  // Evict oldest entries if we're at capacity
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value!;
    cache.delete(firstKey);
  }
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function githubHeaders(extraAccept?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: extraAccept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `nrf-mcp/${pkg.version}`,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function githubGet<T>(url: string, extraAccept?: string): Promise<T> {
  const cached = cacheGet<T>(url);
  if (cached !== undefined) return cached;

  const response = await fetch(url, { headers: githubHeaders(extraAccept) });
  if (!response.ok) {
    const body = await response.text();
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (response.status === 403 && remaining === "0" && reset) {
      const resetTime = new Date(parseInt(reset) * 1000).toISOString();
      throw new Error(`GitHub rate limit exceeded. Resets at ${resetTime}. Set GITHUB_TOKEN for higher limits.`);
    }
    if (response.status === 404) {
      throw new Error(`Not found: the path may not exist at ref '${REF}', or it may be misspelled. Use nrf_list to verify the parent directory.`);
    }
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }
  const data = (await response.json()) as T;
  // Don't cache search results (they're not ref-pinned)
  if (!url.includes("/search/")) {
    cacheSet(url, data);
  }
  return data;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

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

Returns dirs first, then files (with sizes), with full paths you can pass to nrf_read.`,
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

Supports optional startLine/endLine to read a specific range (1-indexed), useful for large files.

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
        startLine: {
          type: "integer",
          description: "First line to return (1-indexed, inclusive). Omit to start from the beginning.",
        },
        endLine: {
          type: "integer",
          description: "Last line to return (1-indexed, inclusive). Omit to read to the end.",
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

Returns matching file paths with context snippets (up to 20 per page). Use nrf_read to fetch full content.
Note: Requires GITHUB_TOKEN for reliable results (unauthenticated search is heavily rate-limited).
Note: GitHub code search always indexes the default branch (main), not the pinned NRF_SDK_REF. Use nrf_read with the discovered paths to fetch content at the configured ref.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms with optional GitHub qualifiers (path:, extension:, filename:)",
        },
        page: {
          type: "integer",
          description: "Page number for results (default: 1). Each page returns up to 20 results.",
        },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "nrf-mcp", version: pkg.version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function getString(args: unknown, key: string): string {
  if (!args || typeof args !== "object" || !(key in args)) {
    throw new Error(`Missing required argument: '${key}'`);
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new Error(`Argument '${key}' must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalInt(args: unknown, key: string): number | undefined {
  if (!args || typeof args !== "object" || !(key in args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Argument '${key}' must be an integer, got ${typeof value}`);
  }
  return value;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "nrf_list") {
      const path = getString(args, "path").replace(/^\/+|\/+$/g, "");
      const url = `${BASE_URL}/repos/${REPO}/contents/${encodePath(path)}?ref=${REF}`;
      const data = await githubGet<unknown>(url);

      if (!Array.isArray(data)) {
        return {
          content: [{ type: "text", text: `'${path}' is a file, not a directory. Use nrf_read to read it.` }],
        };
      }

      const items = (data as Array<{ name: string; path: string; type: string; size: number }>)
        .sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "dir" ? -1 : 1;
        })
        .map((item) => {
          if (item.type === "dir") return `[dir]  ${item.path}`;
          return `[file] ${item.path}  (${formatSize(item.size)})`;
        })
        .join("\n");

      return {
        content: [{ type: "text", text: items || "Empty directory" }],
      };
    }

    if (name === "nrf_read") {
      const path = getString(args, "path").replace(/^\/+|\/+$/g, "");
      const startLine = getOptionalInt(args, "startLine");
      const endLine = getOptionalInt(args, "endLine");
      const url = `${BASE_URL}/repos/${REPO}/contents/${encodePath(path)}?ref=${REF}`;
      const data = await githubGet<{
        type?: string;
        size?: number;
        content?: string;
        encoding?: string;
      }>(url);

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
            text: `File is too large to read directly (${formatSize(size)}). Consider browsing the directory and reading specific source files.`,
          }],
        };
      }

      if (!data.content) {
        return {
          content: [{ type: "text", text: `No text content available for '${path}' (may be a binary file).` }],
        };
      }

      let content = Buffer.from(data.content, "base64").toString("utf-8");

      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split("\n");
        const start = Math.max(1, startLine ?? 1);
        const end = Math.min(lines.length, endLine ?? lines.length);
        if (start > lines.length) {
          return {
            content: [{ type: "text", text: `File has ${lines.length} lines; startLine ${start} is out of range.` }],
          };
        }
        const slice = lines.slice(start - 1, end);
        const numbered = slice.map((line, i) => `${start + i}: ${line}`).join("\n");
        content = `Lines ${start}–${end} of ${lines.length}:\n\n${numbered}`;
      }

      return {
        content: [{ type: "text", text: content }],
      };
    }

    if (name === "nrf_search") {
      const query = getString(args, "query");
      const page = getOptionalInt(args, "page") ?? 1;
      const fullQuery = `${query} repo:${REPO}`;
      const url = `${BASE_URL}/search/code?q=${encodeURIComponent(fullQuery)}&per_page=20&page=${page}`;

      interface TextMatch {
        fragment: string;
      }
      interface SearchItem {
        path: string;
        name: string;
        text_matches?: TextMatch[];
      }
      interface SearchResult {
        total_count: number;
        items: SearchItem[];
      }

      const data = await githubGet<SearchResult>(
        url,
        "application/vnd.github.text-match+json",
      );

      if (!data.items || data.items.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for: ${query}` }],
        };
      }

      const results = data.items
        .map((item) => {
          let entry = item.path;
          if (item.text_matches && item.text_matches.length > 0) {
            const snippet = item.text_matches[0].fragment
              .split("\n")
              .map((line) => `  │ ${line}`)
              .join("\n");
            entry += `\n${snippet}`;
          }
          return entry;
        })
        .join("\n\n");

      const warning = REF !== "main"
        ? `Note: GitHub code search always indexes 'main'. Results below are from main — paths will be read at '${REF}' when you call nrf_read, but a file that exists on main may not exist on ${REF}.\n\n`
        : "";
      const pageInfo = data.total_count > 20
        ? ` (page ${page}, use page: ${page + 1} for more)`
        : "";
      const text = `Found ${data.total_count} result(s)${pageInfo}:\n\n${warning}${results}`;
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

// ---------------------------------------------------------------------------
// Startup & shutdown
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`nrf-mcp running (repo: ${REPO} @ ${REF})`);
}

function shutdown() {
  console.error("nrf-mcp shutting down");
  server.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
