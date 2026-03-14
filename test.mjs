#!/usr/bin/env node
/**
 * End-to-end tests for nrf-mcp.
 * Spawns the server via run.sh and exercises all three tools over JSON-RPC.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
let failures = 0;
let nextId = 1;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
  } else {
    console.log(`  ${FAIL}  ${label}${detail ? `: ${detail}` : ""}`);
    failures++;
  }
}

function startServer(env) {
  const proc = spawn("./run.sh", [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: env ?? process.env,
  });
  const rl = createInterface({ input: proc.stdout });
  const lines = [];
  let waiting = null;

  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(JSON.parse(line));
    } else {
      lines.push(line);
    }
  });

  function rpc(method, params = {}) {
    const id = nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    proc.stdin.write(msg + "\n");
    return new Promise((resolve) => {
      const queued = lines.shift();
      if (queued) {
        resolve(JSON.parse(queued));
      } else {
        waiting = resolve;
      }
    });
  }

  async function handshake() {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    proc.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'
    );
  }

  async function callTool(tool, args) {
    return rpc("tools/call", { name: tool, arguments: args });
  }

  function kill() {
    proc.kill("SIGTERM");
  }

  return { rpc, handshake, callTool, kill };
}

async function run() {
  const server = startServer();
  try {
    await server.handshake();

    // -- tools/list -----------------------------------------------------------
    console.log("\n── tools/list ──────────────────────────────");
    const toolsResp = await server.rpc("tools/list");
    const names = toolsResp.result.tools.map((t) => t.name);
    check("nrf_list registered", names.includes("nrf_list"));
    check("nrf_read registered", names.includes("nrf_read"));
    check("nrf_search registered", names.includes("nrf_search"));

    // -- nrf_list -------------------------------------------------------------
    console.log("\n── nrf_list ────────────────────────────────");
    let r = await server.callTool("nrf_list", { path: "samples/bluetooth" });
    let text = r.result.content[0].text;
    let lines = text.split("\n");
    check("returns multiple entries", lines.length > 10, `got ${lines.length}`);
    check("dirs sort before files", lines[0].startsWith("[dir]"), lines[0]);
    check("paths are full (not just names)", lines[0].includes("/"));

    // File sizes — use a path that has files
    r = await server.callTool("nrf_list", { path: "samples/bluetooth/central_bas" });
    text = r.result.content[0].text;
    const fileLines = text.split("\n").filter((l) => l.startsWith("[file]"));
    if (fileLines.length > 0) {
      check("file entries include size", fileLines[0].includes("(") && fileLines[0].includes(")"), fileLines[0]);
    } else {
      check("file entries include size", false, "no file entries found");
    }

    r = await server.callTool("nrf_list", { path: "samples/bluetooth/central_bas/src/main.c" });
    check("file path returns helpful message", r.result.content[0].text.includes("nrf_read"));

    // -- nrf_read -------------------------------------------------------------
    console.log("\n── nrf_read ────────────────────────────────");
    r = await server.callTool("nrf_read", { path: "samples/bluetooth/central_bas/README.rst" });
    const content = r.result.content[0].text;
    check("returns file content", content.length > 100, `${content.length} chars`);
    check("RST content is plain text", content.startsWith(".."), content.slice(0, 40));

    r = await server.callTool("nrf_read", { path: "samples/bluetooth" });
    check("directory path returns helpful message", r.result.content[0].text.includes("nrf_list"));

    // -- nrf_read line range --------------------------------------------------
    console.log("\n── nrf_read (line range) ────────────────────");
    r = await server.callTool("nrf_read", { path: "samples/bluetooth/central_bas/README.rst", startLine: 1, endLine: 5 });
    text = r.result.content[0].text;
    check("line range header present", text.includes("Lines 1"));
    check("line numbers in output", text.includes("1: "));
    const rangeLines = text.split("\n\n").slice(1).join("\n\n").split("\n").filter((l) => l.trim());
    check("correct number of lines", rangeLines.length === 5, `got ${rangeLines.length}`);

    r = await server.callTool("nrf_read", { path: "samples/bluetooth/central_bas/README.rst", startLine: 3 });
    text = r.result.content[0].text;
    check("startLine only: starts at line 3", text.includes("3: "));

    r = await server.callTool("nrf_read", { path: "samples/bluetooth/central_bas/README.rst", startLine: 99999 });
    text = r.result.content[0].text;
    check("out-of-range startLine returns error", text.includes("out of range"));

    // -- nrf_search -----------------------------------------------------------
    console.log("\n── nrf_search ──────────────────────────────");
    r = await server.callTool("nrf_search", { query: "bt_le_adv_start extension:c path:samples/bluetooth" });
    text = r.result.content[0].text;
    check("returns results (not error)", !r.result.isError, text.slice(0, 120));
    check("result count line present", text.includes("Found"));
    check("includes context snippets", text.includes("│"), "no snippet markers found");

    // -- nrf_search pagination ------------------------------------------------
    console.log("\n── nrf_search (pagination) ─────────────────");
    r = await server.callTool("nrf_search", { query: "bt_le_adv_start extension:c", page: 1 });
    text = r.result.content[0].text;
    check("page 1 returns results", text.includes("Found"));

    // -- nrf_search version warning -------------------------------------------
    console.log("\n── nrf_search version warning ──────────────");
    const envMain = { ...process.env, NRF_SDK_REF: "main" };
    const envTag = { ...process.env, NRF_SDK_REF: "v3.2.4" };

    const s2 = startServer(envMain);
    await s2.handshake();
    r = await s2.callTool("nrf_search", { query: "bt_le_adv_start extension:c" });
    s2.kill();
    check("no warning when REF=main", !r.result.content[0].text.includes("Note: GitHub code search"));

    const s3 = startServer(envTag);
    await s3.handshake();
    r = await s3.callTool("nrf_search", { query: "bt_le_adv_start extension:c" });
    s3.kill();
    check("warning shown when REF=v3.2.4", r.result.content[0].text.includes("Note: GitHub code search"));

    // -- 404 error message ----------------------------------------------------
    console.log("\n── 404 error message ───────────────────────");
    r = await server.callTool("nrf_read", { path: "this/path/does/not/exist.c" });
    text = r.result.content[0].text;
    check("404 mentions nrf_list hint", text.includes("nrf_list"), text.slice(0, 100));

    // -- input validation -----------------------------------------------------
    console.log("\n── input validation ────────────────────────");
    r = await server.callTool("nrf_list", {});
    text = r.result.content[0].text;
    check("missing arg returns error", text.includes("Missing required argument"), text.slice(0, 80));

    r = await server.callTool("nrf_list", { path: 42 });
    text = r.result.content[0].text;
    check("wrong-type arg returns error", text.includes("must be a string"), text.slice(0, 80));
  } finally {
    server.kill();
  }

  console.log(`\n${"─".repeat(48)}`);
  if (failures === 0) {
    console.log("All tests passed.");
  } else {
    console.log(`${failures} test(s) failed.`);
  }
  process.exit(failures);
}

run();
