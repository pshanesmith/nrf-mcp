#!/usr/bin/env node

import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { nrfSdkRef: string; version: string };
const DEFAULT_REF: string = pkg.nrfSdkRef;

const REPO = "nrfconnect/sdk-nrf";
const REF = process.env.NRF_SDK_REF ?? DEFAULT_REF;
const BASE_URL = "https://api.github.com";
const RAW_BASE_URL = "https://raw.githubusercontent.com";

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
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
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
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubGet<T>(url: string, extraAccept?: string): Promise<T> {
  const cached = cacheGet<T>(url);
  if (cached !== undefined) return cached;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { headers: githubHeaders(extraAccept) });
    if (!response.ok) {
      const body = await response.text();
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");

      // Rate limit — retry after waiting if we have attempts left
      if (response.status === 403 && remaining === "0" && reset) {
        if (attempt < maxRetries) {
          const resetMs = parseInt(reset, 10) * 1000 - Date.now();
          const waitMs = Math.min(Math.max(resetMs, 1000), 30_000); // cap at 30s
          console.error(`Rate limited, waiting ${(waitMs / 1000).toFixed(0)}s before retry…`);
          await sleep(waitMs);
          continue;
        }
        const resetTime = new Date(parseInt(reset, 10) * 1000).toISOString();
        throw new Error(`GitHub rate limit exceeded. Resets at ${resetTime}. Set GITHUB_TOKEN for higher limits.`);
      }

      // Secondary rate limit (abuse detection) — exponential backoff
      if (response.status === 403 && body.includes("secondary rate limit") && attempt < maxRetries) {
        const waitMs = 1000 * 2 ** attempt;
        console.error(`Secondary rate limit, backing off ${waitMs}ms…`);
        await sleep(waitMs);
        continue;
      }

      if (response.status === 404) {
        throw new Error(
          `Not found: the path may not exist at ref '${REF}', or it may be misspelled. Use nrf_list to verify the parent directory.`,
        );
      }
      throw new Error(`GitHub API ${response.status}: ${body}`);
    }
    const data = (await response.json()) as T;
    if (!url.includes("/search/")) {
      cacheSet(url, data);
    }
    return data;
  }
  throw new Error("Unreachable: exceeded retry loop");
}

async function fetchRawText(path: string, ref: string): Promise<string> {
  const cacheKey = `raw:${ref}:${path}`;
  const cached = cacheGet<string>(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${RAW_BASE_URL}/${REPO}/${ref}/${path}`;
  const headers: Record<string, string> = {
    "User-Agent": `nrf-mcp/${pkg.version}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Not found: the path may not exist at ref '${ref}', or it may be misspelled. Use nrf_list to verify the parent directory.`,
      );
    }
    throw new Error(`GitHub raw ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  cacheSet(cacheKey, text);
  return text;
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
// Recursive tree helper
// ---------------------------------------------------------------------------

interface GHContentItem {
  name: string;
  path: string;
  type: string;
  size: number;
}

async function listDir(path: string): Promise<GHContentItem[]> {
  const url = `${BASE_URL}/repos/${REPO}/contents/${encodePath(path)}?ref=${REF}`;
  const data = await githubGet<unknown>(url);
  if (!Array.isArray(data)) return [];
  return data as GHContentItem[];
}

async function buildTree(path: string, depth: number, maxDepth: number): Promise<string[]> {
  const items = await listDir(path);
  items.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === "dir" ? -1 : 1;
  });

  const lines: string[] = [];
  for (const item of items) {
    if (item.type === "dir") {
      lines.push(`[dir]  ${item.path}`);
      if (depth < maxDepth) {
        const children = await buildTree(item.path, depth + 1, maxDepth);
        lines.push(...children);
      }
    } else {
      lines.push(`[file] ${item.path}  (${formatSize(item.size)})`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Diff helper
// ---------------------------------------------------------------------------

function computeUnifiedDiff(aText: string, bText: string, aLabel: string, bLabel: string): string {
  const aLines = aText.split("\n");
  const bLines = bText.split("\n");

  // Simple LCS-based diff
  const m = aLines.length;
  const n = bLines.length;

  // For very large files, fall back to a summary
  if (m + n > 10_000) {
    return (
      `Files are too large for inline diff (${m} vs ${n} lines). Showing summary only.\n` +
      `--- ${aLabel}: ${m} lines\n+++ ${bLabel}: ${n} lines\n` +
      `Line count delta: ${n - m > 0 ? "+" : ""}${n - m}`
    );
  }

  // Build LCS table (O(mn) but bounded by 10k total lines)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = aLines[i - 1] === bLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff
  const diffLines: string[] = [];
  let i = m,
    j = n;
  const result: { type: "ctx" | "del" | "add"; line: string }[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      result.push({ type: "ctx", line: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "add", line: bLines[j - 1] });
      j--;
    } else {
      result.push({ type: "del", line: aLines[i - 1] });
      i--;
    }
  }
  result.reverse();

  // Format as unified-ish diff with context
  diffLines.push(`--- ${aLabel}`);
  diffLines.push(`+++ ${bLabel}`);

  let lastPrinted = -1;
  for (let k = 0; k < result.length; k++) {
    if (result[k].type === "ctx") continue;
    // Print context around changes
    const ctxStart = Math.max(lastPrinted + 1, k - 3);
    if (ctxStart > lastPrinted + 1 && lastPrinted >= 0) {
      diffLines.push("...");
    }
    for (let c = ctxStart; c < k; c++) {
      if (c > lastPrinted) {
        diffLines.push(` ${result[c].line}`);
      }
    }
    const prefix = result[k].type === "add" ? "+" : "-";
    diffLines.push(`${prefix}${result[k].line}`);
    lastPrinted = k;
    // Print trailing context
    for (let c = k + 1; c <= Math.min(k + 3, result.length - 1); c++) {
      if (result[c].type === "ctx") {
        diffLines.push(` ${result[c].line}`);
        lastPrinted = c;
      } else {
        break;
      }
    }
  }

  if (diffLines.length === 2) {
    return "No differences found.";
  }
  return diffLines.join("\n");
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

Returns dirs first, then files (with sizes), with full paths you can pass to nrf_read.
Use depth > 1 to get a recursive tree view (max 3).`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path within the repo (e.g. 'samples/bluetooth')",
        },
        depth: {
          type: "integer",
          description:
            "How many levels deep to recurse (default: 1, max: 3). Use 2–3 to get a full project overview in one call.",
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
For files over 500 KB, the first 2000 lines are returned automatically with a truncation notice.

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
  {
    name: "nrf_diff",
    description: `Compare a file between two SDK versions (git refs).

Useful when migrating between SDK versions to see what changed in a sample, config, or API header.
Returns a unified diff. Both refs can be branches, tags, or commit SHAs.

Example: compare a sample's main.c between v3.0.0 and v3.2.4.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path within the repo (e.g. 'samples/bluetooth/central_bas/src/main.c')",
        },
        fromRef: {
          type: "string",
          description: "Base ref to compare from (e.g. 'v3.0.0', 'main')",
        },
        toRef: {
          type: "string",
          description: "Target ref to compare to (e.g. 'v3.2.4', 'main')",
        },
      },
      required: ["path", "fromRef", "toRef"],
    },
  },
  {
    name: "nrf_kconfig",
    description: `Look up a Kconfig symbol (CONFIG_*) in the nRF Connect SDK.

Searches for the Kconfig definition of a symbol and returns the defining file with its description, type, defaults, and dependencies. Strips the CONFIG_ prefix automatically if present.

Useful for understanding what a prj.conf option does, its type, and where it's defined.`,
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Kconfig symbol name (e.g. 'CONFIG_BT_PERIPHERAL' or 'BT_PERIPHERAL')",
        },
      },
      required: ["symbol"],
    },
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server({ name: "nrf-mcp", version: pkg.version }, { capabilities: { tools: {} } });

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
    // ── nrf_list ────────────────────────────────────────────────────────
    if (name === "nrf_list") {
      const path = getString(args, "path").replace(/^\/+|\/+$/g, "");
      const depth = Math.min(getOptionalInt(args, "depth") ?? 1, 3);

      if (depth <= 1) {
        // Fast path: single API call
        const url = `${BASE_URL}/repos/${REPO}/contents/${encodePath(path)}?ref=${REF}`;
        const data = await githubGet<unknown>(url);

        if (!Array.isArray(data)) {
          return {
            content: [{ type: "text", text: `'${path}' is a file, not a directory. Use nrf_read to read it.` }],
          };
        }

        const items = (data as GHContentItem[])
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

      // Recursive tree
      const lines = await buildTree(path, 1, depth);
      return {
        content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "Empty directory" }],
      };
    }

    // ── nrf_read ────────────────────────────────────────────────────────
    if (name === "nrf_read") {
      const path = getString(args, "path").replace(/^\/+|\/+$/g, "");
      const startLine = getOptionalInt(args, "startLine");
      const endLine = getOptionalInt(args, "endLine");

      // First check via contents API whether it's a dir or get size info
      const metaUrl = `${BASE_URL}/repos/${REPO}/contents/${encodePath(path)}?ref=${REF}`;
      const meta = await githubGet<unknown>(metaUrl);

      if (Array.isArray(meta)) {
        return {
          content: [{ type: "text", text: `'${path}' is a directory. Use nrf_list to browse it.` }],
        };
      }

      const fileMeta = meta as { size?: number; content?: string };
      const size = fileMeta.size ?? 0;
      const MAX_LINES = 2000;

      let content: string;
      if (size > 500_000) {
        // Large file: stream via raw endpoint and truncate
        const rawText = await fetchRawText(path, REF);
        const allLines = rawText.split("\n");
        if (allLines.length > MAX_LINES && startLine === undefined && endLine === undefined) {
          const truncated = allLines.slice(0, MAX_LINES).join("\n");
          content = `[Showing first ${MAX_LINES} of ${allLines.length} lines (${formatSize(size)}) — use startLine/endLine to read specific sections]\n\n${truncated}`;
        } else {
          content = rawText;
        }
      } else {
        if (!fileMeta.content) {
          return {
            content: [{ type: "text", text: `No text content available for '${path}' (may be a binary file).` }],
          };
        }
        content = Buffer.from(fileMeta.content, "base64").toString("utf-8");
      }

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

    // ── nrf_search ──────────────────────────────────────────────────────
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

      const data = await githubGet<SearchResult>(url, "application/vnd.github.text-match+json");

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

      const warning =
        REF !== "main"
          ? `Note: GitHub code search always indexes 'main'. Results below are from main — paths will be read at '${REF}' when you call nrf_read, but a file that exists on main may not exist on ${REF}.\n\n`
          : "";
      const pageInfo = data.total_count > 20 ? ` (page ${page}, use page: ${page + 1} for more)` : "";
      const text = `Found ${data.total_count} result(s)${pageInfo}:\n\n${warning}${results}`;
      return {
        content: [{ type: "text", text }],
      };
    }

    // ── nrf_diff ────────────────────────────────────────────────────────
    if (name === "nrf_diff") {
      const path = getString(args, "path").replace(/^\/+|\/+$/g, "");
      const fromRef = getString(args, "fromRef");
      const toRef = getString(args, "toRef");

      const [fromText, toText] = await Promise.all([fetchRawText(path, fromRef), fetchRawText(path, toRef)]);

      const diff = computeUnifiedDiff(fromText, toText, `${path} @ ${fromRef}`, `${path} @ ${toRef}`);

      return {
        content: [{ type: "text", text: diff }],
      };
    }

    // ── nrf_kconfig ─────────────────────────────────────────────────────
    if (name === "nrf_kconfig") {
      let symbol = getString(args, "symbol").trim();
      // Strip CONFIG_ prefix if present
      if (symbol.startsWith("CONFIG_")) {
        symbol = symbol.slice(7);
      }

      // Search for the Kconfig definition
      const defQuery = `"config ${symbol}" repo:${REPO} filename:Kconfig`;
      const url = `${BASE_URL}/search/code?q=${encodeURIComponent(defQuery)}&per_page=5`;
      const data = await githubGet<{
        total_count: number;
        items: Array<{ path: string; name: string }>;
      }>(url, "application/vnd.github.text-match+json");

      if (!data.items || data.items.length === 0) {
        // Try broader search without filename restriction
        const broadQuery = `"config ${symbol}" repo:${REPO}`;
        const broadUrl = `${BASE_URL}/search/code?q=${encodeURIComponent(broadQuery)}&per_page=5`;
        const broadData = await githubGet<{
          total_count: number;
          items: Array<{ path: string; name: string }>;
        }>(broadUrl, "application/vnd.github.text-match+json");

        if (!broadData.items || broadData.items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No Kconfig definition found for '${symbol}'. Try nrf_search for a broader search.`,
              },
            ],
          };
        }
        data.items = broadData.items;
        data.total_count = broadData.total_count;
      }

      // Read the first matching file and extract the symbol's definition block
      const results: string[] = [];
      for (const item of data.items.slice(0, 3)) {
        try {
          const fileContent = await fetchRawText(item.path, REF);
          const lines = fileContent.split("\n");

          // Find the config definition line
          let defStart = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(new RegExp(`^config\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`))) {
              defStart = i;
              break;
            }
          }

          if (defStart === -1) continue;

          // Extract the full definition block (until next config/menuconfig/menu/endmenu/source/if/endif or blank line after indented block)
          let defEnd = defStart + 1;
          while (defEnd < lines.length) {
            const line = lines[defEnd];
            // End at next top-level directive
            if (line.match(/^(config|menuconfig|menu|endmenu|source|if |endif|choice|endchoice)\s/)) break;
            // End at unindented non-empty line that isn't a continuation
            if (line.length > 0 && !line.startsWith("\t") && !line.startsWith(" ") && !line.startsWith("#")) break;
            defEnd++;
          }

          const block = lines.slice(defStart, defEnd).join("\n").trimEnd();
          results.push(`── ${item.path}:${defStart + 1} ──\n${block}`);
        } catch {
          // File might not exist at this ref; skip
          results.push(`── ${item.path} ── (not available at ref '${REF}')`);
        }
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Found references to '${symbol}' but could not extract a definition block. Try nrf_read on these files:\n${data.items.map((i) => i.path).join("\n")}`,
            },
          ],
        };
      }

      const header = `Kconfig definition for CONFIG_${symbol}:\n\n`;
      return {
        content: [{ type: "text", text: header + results.join("\n\n") }],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
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
