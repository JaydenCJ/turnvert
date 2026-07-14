// Stats aggregation: per-session folding, token sums, tool ranking, and
// the fixed-width table renderer downstream dashboards scrape.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeStats, renderStatsTable } from "../dist/stats.js";
import { sequenceEvents } from "../dist/convert.js";

function stream(drafts) {
  return sequenceEvents(
    drafts.map((d) => ({ v: 1, ts: null, harness: "codex", session: "s1", ...d }))
  );
}

test("folds one session: event counts, message roles, notes", () => {
  const [s] = computeStats(
    stream([
      { event: "session_start" },
      { event: "message", role: "user", text: "q" },
      { event: "message", role: "assistant", text: "a" },
      { event: "note", text: "n" },
    ])
  );
  assert.equal(s.events, 4);
  assert.deepEqual(s.messages, { user: 1, assistant: 1, system: 0 });
  assert.equal(s.notes, 1);
});

test("tool calls rank by count desc, then name asc; errors count results", () => {
  const [s] = computeStats(
    stream([
      { event: "tool_call", tool: { name: "run" } },
      { event: "tool_call", tool: { name: "run" } },
      { event: "tool_call", tool: { name: "edit" } },
      { event: "tool_call", tool: { name: "browse" } },
      { event: "tool_result", tool: { output: "x", error: true } },
      { event: "tool_result", tool: { output: "y", error: false } },
    ])
  );
  assert.equal(s.tool_calls, 4);
  assert.equal(s.tool_errors, 1);
  assert.deepEqual(s.tools, [
    { name: "run", calls: 2 },
    { name: "browse", calls: 1 },
    { name: "edit", calls: 1 },
  ]);
});

test("token counters sum across events; absent usage adds nothing", () => {
  const [s] = computeStats(
    stream([
      { event: "message", role: "assistant", text: "a", usage: { input: 100, output: 20 } },
      { event: "message", role: "assistant", text: "b", usage: { input: 50, output: 5 } },
      { event: "message", role: "assistant", text: "c" },
    ])
  );
  assert.deepEqual(s.tokens, { input: 150, output: 25 });
});

test("sessions split on the session field, in first-seen order", () => {
  const stats = computeStats(
    stream([
      { event: "session_start", session: "b" },
      { event: "message", role: "user", text: "q", session: "b" },
      { event: "session_start", session: "a" },
    ])
  );
  assert.deepEqual(
    stats.map((s) => [s.session, s.events]),
    [
      ["b", 2],
      ["a", 1],
    ]
  );
});

test("first/last ts span the session and the first model wins", () => {
  const [s] = computeStats(
    stream([
      { event: "session_start", ts: "2026-07-01T09:00:00Z" },
      { event: "message", role: "assistant", text: "a", ts: "2026-07-01T09:05:00Z", model: "m1" },
      { event: "message", role: "assistant", text: "b", ts: null, model: "m2" },
    ])
  );
  assert.equal(s.first_ts, "2026-07-01T09:00:00Z");
  assert.equal(s.last_ts, "2026-07-01T09:05:00Z");
  assert.equal(s.model, "m1");
});

test("the table shortens long session ids and reports the totals line", () => {
  const table = renderStatsTable(
    computeStats(
      stream([
        { event: "session_start", session: "a".repeat(60) },
        { event: "message", role: "user", text: "q", session: "a".repeat(60) },
      ])
    )
  );
  const lines = table.split("\n");
  assert.match(lines[0], /^SESSION\s+HARNESS\s+EVENTS/);
  assert.ok(lines[1].startsWith("a".repeat(27) + "…"));
  assert.equal(lines[lines.length - 1], "2 event(s) across 1 session(s)");
});
