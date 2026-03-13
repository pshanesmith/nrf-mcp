#!/usr/bin/env python3
"""End-to-end tests for nrf-mcp. Spawns the server via run.sh and exercises all three tools."""

import json
import subprocess
import sys

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"

failures = 0


def rpc(server, method, params=None, id=1):
    msg = {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}
    server.stdin.write((json.dumps(msg) + "\n").encode())
    server.stdin.flush()
    return json.loads(server.stdout.readline())


def check(label, condition, detail=""):
    global failures
    if condition:
        print(f"  {PASS}  {label}")
    else:
        print(f"  {FAIL}  {label}" + (f": {detail}" if detail else ""))
        failures += 1


def run_tests():
    server = subprocess.Popen(
        ["./run.sh"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        # Handshake
        resp = rpc(server, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "0"},
        })
        server.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n')
        server.stdin.flush()

        print("\n── tools/list ──────────────────────────────")
        tools_resp = rpc(server, "tools/list", {}, id=2)
        names = [t["name"] for t in tools_resp["result"]["tools"]]
        check("nrf_list registered", "nrf_list" in names)
        check("nrf_read registered", "nrf_read" in names)
        check("nrf_search registered", "nrf_search" in names)

        print("\n── nrf_list ────────────────────────────────")
        r = rpc(server, "tools/call", {"name": "nrf_list", "arguments": {"path": "samples/bluetooth"}}, id=3)
        text = r["result"]["content"][0]["text"]
        lines = text.splitlines()
        check("returns multiple entries", len(lines) > 10, f"got {len(lines)}")
        check("dirs sort before files", lines[0].startswith("[dir]"), lines[0])
        check("paths are full (not just names)", "/" in lines[0])

        r2 = rpc(server, "tools/call", {"name": "nrf_list", "arguments": {"path": "samples/bluetooth/central_bas/src/main.c"}}, id=4)
        check("file path returns helpful message", "nrf_read" in r2["result"]["content"][0]["text"])

        print("\n── nrf_read ────────────────────────────────")
        r = rpc(server, "tools/call", {"name": "nrf_read", "arguments": {"path": "samples/bluetooth/central_bas/README.rst"}}, id=5)
        content = r["result"]["content"][0]["text"]
        check("returns file content", len(content) > 100, f"{len(content)} chars")
        check("RST content is plain text", content.startswith(".."), content[:40])

        r2 = rpc(server, "tools/call", {"name": "nrf_read", "arguments": {"path": "samples/bluetooth"}}, id=6)
        check("directory path returns helpful message", "nrf_list" in r2["result"]["content"][0]["text"])

        print("\n── nrf_search ──────────────────────────────")
        r = rpc(server, "tools/call", {"name": "nrf_search", "arguments": {"query": "bt_le_adv_start extension:c path:samples/bluetooth"}}, id=7)
        text = r["result"]["content"][0]["text"]
        is_error = r["result"].get("isError", False)
        check("returns results (not error)", not is_error, text[:120])
        check("result count line present", "Found" in text, text[:60])

        print("\n── nrf_search version warning ──────────────")
        import os, copy
        env_main = {**os.environ, "NRF_SDK_REF": "main"}
        env_tag  = {**os.environ, "NRF_SDK_REF": "v3.2.4"}

        s2 = subprocess.Popen(["./run.sh"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env_main)
        rpc(s2, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
        s2.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'); s2.stdin.flush()
        r2 = rpc(s2, "tools/call", {"name": "nrf_search", "arguments": {"query": "bt_le_adv_start extension:c"}}, id=2)
        s2.terminate()
        check("no warning when REF=main", "Note: GitHub code search" not in r2["result"]["content"][0]["text"])

        s3 = subprocess.Popen(["./run.sh"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env_tag)
        rpc(s3, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
        s3.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'); s3.stdin.flush()
        r3 = rpc(s3, "tools/call", {"name": "nrf_search", "arguments": {"query": "bt_le_adv_start extension:c"}}, id=2)
        s3.terminate()
        check("warning shown when REF=v3.2.4", "Note: GitHub code search" in r3["result"]["content"][0]["text"])

        print("\n── input validation ────────────────────────")
        r = rpc(server, "tools/call", {"name": "nrf_list", "arguments": {}}, id=8)
        text = r["result"]["content"][0]["text"]
        check("missing arg returns error", "Missing required argument" in text, text[:80])

        r = rpc(server, "tools/call", {"name": "nrf_list", "arguments": {"path": 42}}, id=9)
        text = r["result"]["content"][0]["text"]
        check("wrong-type arg returns error", "must be a string" in text, text[:80])

    finally:
        server.terminate()

    print(f"\n{'─' * 48}")
    if failures == 0:
        print(f"All tests passed.")
    else:
        print(f"{failures} test(s) failed.")
    return failures


if __name__ == "__main__":
    sys.exit(run_tests())
