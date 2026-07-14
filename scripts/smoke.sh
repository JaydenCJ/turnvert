#!/usr/bin/env bash
# Smoke test for turnvert: exercises the real CLI end to end against the
# bundled example logs of all four harnesses. No network, idempotent, runs
# from a clean checkout (after `npm install`). Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents every subcommand.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in convert detect stats validate schema; do
  grep -q "$word" <<<"$HELP" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Exit codes: unknown commands/flags exit 2, undetectable inputs exit 1.
set +e
$CLI frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI convert examples/codex-rollout.jsonl --frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown flag should exit 2"; }
printf 'just some prose\n' > "$WORKDIR/mystery.log"
$CLI convert "$WORKDIR/mystery.log" >/dev/null 2>&1; [ $? -eq 1 ] || { set -e; fail "undetectable input should exit 1"; }
set -e
echo "[smoke] exit codes ok (2 usage, 1 findings)"

# 4. detect: all four bundled examples classify correctly.
DETECT_OUT="$($CLI detect examples/claude-code-session.jsonl examples/codex-rollout.jsonl examples/aider-chat-history.md examples/openhands-events.json)"
grep -q "claude-code-session.jsonl	claude-code" <<<"$DETECT_OUT" || fail "detect missed claude-code"
grep -q "codex-rollout.jsonl	codex" <<<"$DETECT_OUT" || fail "detect missed codex"
grep -q "aider-chat-history.md	aider" <<<"$DETECT_OUT" || fail "detect missed aider"
grep -q "openhands-events.json	openhands" <<<"$DETECT_OUT" || fail "detect missed openhands"
echo "[smoke] detect ok (4 harnesses)"

# 5. convert: all four logs merge into one normalized stream.
$CLI convert \
  examples/claude-code-session.jsonl \
  examples/codex-rollout.jsonl \
  examples/aider-chat-history.md \
  examples/openhands-events.json \
  --out "$WORKDIR/all.jsonl" || fail "convert failed"
LINES="$(wc -l < "$WORKDIR/all.jsonl")"
[ "$LINES" -ge 30 ] || fail "expected >=30 events, got $LINES"
grep -q '"event":"tool_call"' "$WORKDIR/all.jsonl" || fail "no tool_call events"
grep -q '"event":"tool_result"' "$WORKDIR/all.jsonl" || fail "no tool_result events"
grep -q '"harness":"aider"' "$WORKDIR/all.jsonl" || fail "no aider events"
grep -q '"thinking":' "$WORKDIR/all.jsonl" || fail "no thinking captured"
echo "[smoke] convert ok ($LINES events from 4 harnesses)"

# 6. validate: the converted stream passes the schema contract.
VALID_OUT="$($CLI validate "$WORKDIR/all.jsonl")"
grep -q "OK: $LINES event(s), 5 session(s)" <<<"$VALID_OUT" || fail "validate: $VALID_OUT"
echo "[smoke] validate ok ($VALID_OUT)"

# 7. validate catches corruption: break one seq and expect line-addressed errors.
node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n");
  const e = JSON.parse(lines[4]); e.seq = 999; lines[4] = JSON.stringify(e);
  fs.writeFileSync(process.argv[1] + ".bad", lines.join("\n") + "\n");
' "$WORKDIR/all.jsonl"
set +e
BAD_OUT="$($CLI validate "$WORKDIR/all.jsonl.bad")"; BAD_CODE=$?
set -e
[ "$BAD_CODE" -eq 1 ] || fail "corrupted stream should exit 1, got $BAD_CODE"
grep -q ":5: " <<<"$BAD_OUT" || fail "validate should name line 5: $BAD_OUT"
echo "[smoke] validator catches corruption ok"

# 8. stats: per-session table over the whole stream, plus JSON mode.
STATS_OUT="$($CLI stats "$WORKDIR/all.jsonl")"
grep -q "SESSION" <<<"$STATS_OUT" || fail "stats table missing header"
grep -q "across 5 session(s)" <<<"$STATS_OUT" || fail "stats should see 5 sessions"
STATS_JSON="$($CLI stats --format json examples/codex-rollout.jsonl)"
grep -q '"name": "shell"' <<<"$STATS_JSON" || fail "stats json missing tool ranking"
echo "[smoke] stats ok (5 sessions)"

# 9. schema prints valid JSON naming all five event kinds.
SCHEMA_OUT="$($CLI schema)"
echo "$SCHEMA_OUT" | node -e 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))' || fail "schema is not valid JSON"
for kind in session_start message tool_call tool_result note; do
  grep -q "$kind" <<<"$SCHEMA_OUT" || fail "schema missing $kind"
done
echo "[smoke] schema ok"

# 10. Determinism: converting the same inputs twice is byte-identical.
$CLI convert examples/aider-chat-history.md examples/openhands-events.json > "$WORKDIR/run1.jsonl"
$CLI convert examples/aider-chat-history.md examples/openhands-events.json > "$WORKDIR/run2.jsonl"
cmp -s "$WORKDIR/run1.jsonl" "$WORKDIR/run2.jsonl" || fail "conversion is not deterministic"
echo "[smoke] determinism ok"

echo "SMOKE OK"
