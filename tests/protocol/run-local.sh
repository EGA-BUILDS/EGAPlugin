#!/usr/bin/env bash
# V010-008 local protocol verification runner.
#
# Starts the test-only SEP-2640 fixture, then runs:
#   1. the dependency-free wire-level suite (modern + legacy + parity + cursors)
#   2. the official pinned MCP client (modern legacy negotiation, SkillsClient,
#      and fallback tools)
#
# No deployment, credentials, or live infrastructure is involved. To verify an
# already-running local Worker instead, set MCP_TEST_URL.
#
# Usage:
#   tests/protocol/run-local.sh
#   INSTALL=1 tests/protocol/run-local.sh
#   MCP_TEST_URL=http://127.0.0.1:8787/mcp tests/protocol/run-local.sh
#   MCP_TOKEN=... ALLOWED_ORIGIN=https://allowed.example tests/protocol/run-local.sh
#
# Exit codes: 0 pass, 1 protocol failure, 2 fixture/SDK dependency missing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTOCOL="$ROOT/tests/protocol"
FIXTURE="$PROTOCOL/fixture"
LOG="${TMPDIR:-/tmp}/ega-protocol-$$.log"
INSTALL="${INSTALL:-0}"
EXTERNAL_URL="${MCP_TEST_URL:-}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -n "$EXTERNAL_URL" ]]; then
  URL="$EXTERNAL_URL"
  echo "Target endpoint: $URL"
else
  ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://allowed.example}"
  if [[ ! -d "$FIXTURE/node_modules" ]]; then
    echo "Fixture dependencies are not installed."
    echo "Install the pinned test-only SDK:"
    echo "  cd \"$FIXTURE\" && npm install --no-audit --no-fund --ignore-scripts"
    if [[ "$INSTALL" == "1" ]]; then
      (cd "$FIXTURE" && npm install --no-audit --no-fund --ignore-scripts)
    else
      exit 2
    fi
  fi

  echo "Starting protocol fixture (log: $LOG)"
  SERVER_ARGS=(--port 0 --log-requests)
  if [[ -n "${ALLOWED_ORIGIN:-}" ]]; then
    SERVER_ARGS+=(--allowed-origin "$ALLOWED_ORIGIN")
  fi
  node "$FIXTURE/server.mjs" "${SERVER_ARGS[@]}" >"$LOG" 2>&1 &
  SERVER_PID=$!

  URL=""
  for _ in $(seq 1 100); do
    URL="$(grep -o 'LISTENING [^ ]*' "$LOG" 2>/dev/null | head -1 | cut -d' ' -f2 || true)"
    if [[ -n "$URL" ]]; then break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "Fixture exited before listening:"
      cat "$LOG"
      exit 1
    fi
    sleep 0.1
  done
  if [[ -z "$URL" ]]; then
    echo "Fixture did not report LISTENING within 10s:"
    cat "$LOG"
    exit 1
  fi
  URL="$URL/mcp"
  echo "Fixture endpoint: $URL"
fi

SUITE_ARGS=(--url "$URL")
if [[ -n "${MCP_TOKEN:-}" ]]; then
  SUITE_ARGS+=(--token-env MCP_TOKEN --require-auth)
fi
if [[ -n "${ALLOWED_ORIGIN:-}" ]]; then
  SUITE_ARGS+=(--allowed-origin "$ALLOWED_ORIGIN")
fi

set +e
node "$PROTOCOL/mcp-suite.mjs" "${SUITE_ARGS[@]}"
SUITE_EXIT=$?
set -e

SDK_ROOT="$FIXTURE"
if [[ -f "$ROOT/node_modules/@modelcontextprotocol/client/package.json" ]]; then
  SDK_ROOT="$ROOT"
fi

OFFICIAL_ARGS=(--url "$URL" --sdk-root "$SDK_ROOT")
if [[ -n "${MCP_TOKEN:-}" ]]; then
  OFFICIAL_ARGS+=(--token-env MCP_TOKEN)
fi

echo ""
set +e
node "$PROTOCOL/official-client.mjs" "${OFFICIAL_ARGS[@]}"
OFFICIAL_EXIT=$?
set -e

if [[ "$OFFICIAL_EXIT" -eq 2 ]]; then
  echo "Official client layer incomplete: pinned SDK missing."
  if [[ "$SUITE_EXIT" -eq 0 ]]; then SUITE_EXIT=2; fi
elif [[ "$OFFICIAL_EXIT" -ne 0 && "$SUITE_EXIT" -eq 0 ]]; then
  SUITE_EXIT=$OFFICIAL_EXIT
fi

exit "$SUITE_EXIT"
