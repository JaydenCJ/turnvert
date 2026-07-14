// OpenHands parser: the action/observation split, cause-linking of results
// to calls, thought lifting, exit-code error mapping, and the three input
// shapes (JSON array, JSONL, decoded records).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseOpenHands, parseOpenHandsEvents } from "../dist/parsers/openhands.js";

function oh(records, opts = {}) {
  return parseOpenHandsEvents(records, { sessionHint: "oh-1", ...opts });
}

test("message and system actions become user/assistant/system messages", () => {
  const { events } = oh([
    { id: 0, source: "environment", action: "system", args: { content: "You are an agent." } },
    { id: 1, source: "user", action: "message", args: { content: "please fix" } },
    { id: 2, source: "agent", action: "message", args: { content: "fixed" } },
  ]);
  const messages = events.filter((e) => e.event === "message");
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ["system", "You are an agent."],
      ["user", "please fix"],
      ["assistant", "fixed"],
    ]
  );
});

test("run actions become tool_calls with thought lifted into thinking", () => {
  const { events } = oh([
    {
      id: 2,
      source: "agent",
      action: "run",
      args: { command: "pytest -x", thought: "run the suite first" },
    },
  ]);
  const call = events.find((e) => e.event === "tool_call");
  assert.equal(call.tool.name, "run");
  assert.equal(call.tool.id, "2");
  assert.deepEqual(call.tool.input, { command: "pytest -x" }); // thought removed
  assert.equal(call.thinking, "run the suite first");
});

test("observations link back via cause; non-zero exit codes mark errors", () => {
  const { events } = oh([
    { id: 2, source: "agent", action: "run", args: { command: "ls" } },
    { id: 3, cause: 2, observation: "run", content: "a.txt", extras: { exit_code: 0 } },
    { id: 4, source: "agent", action: "run", args: { command: "false" } },
    { id: 5, cause: 4, observation: "run", content: "boom", extras: { exit_code: 2 } },
  ]);
  const calls = events.filter((e) => e.event === "tool_call");
  const results = events.filter((e) => e.event === "tool_result");
  assert.equal(results[0].tool.id, calls[0].tool.id);
  assert.equal(results[0].tool.output, "a.txt");
  assert.equal(results[0].tool.error, false);
  assert.equal(results[1].tool.id, calls[1].tool.id);
  assert.equal(results[1].tool.error, true);
});

test("error observations with a cause are error results; without one, notes", () => {
  const withCause = oh([{ id: 5, cause: 4, observation: "error", content: "timeout" }]);
  assert.equal(withCause.events.find((e) => e.event === "tool_result").tool.error, true);
  const without = oh([{ id: 5, observation: "error", content: "timeout" }]);
  assert.equal(without.events.find((e) => e.event === "note").text, "timeout");
});

test("unknown actions default to tool_calls named after the action", () => {
  const { events } = oh([
    { id: 7, source: "agent", action: "browse", args: { url: "http://127.0.0.1:8080/" } },
  ]);
  const call = events.find((e) => e.event === "tool_call");
  assert.equal(call.tool.name, "browse");
  assert.deepEqual(call.tool.input, { url: "http://127.0.0.1:8080/" });
});

test("think actions become thinking-only assistant messages", () => {
  const { events } = oh([
    { id: 4, source: "agent", action: "think", args: { thought: "the cache is stale" } },
  ]);
  const message = events.find((e) => e.event === "message");
  assert.equal(message.thinking, "the cache is stale");
  assert.equal(message.text, undefined);
});

test("finish actions and agent_state_changed observations become notes", () => {
  const { events } = oh([
    { id: 8, source: "agent", action: "finish", args: { final_thought: "all tests green" } },
    { id: 9, observation: "agent_state_changed", content: "", extras: { agent_state: "finished" } },
  ]);
  const notes = events.filter((e) => e.event === "note");
  assert.deepEqual(
    notes.map((n) => n.text),
    ["all tests green", "agent state: finished"]
  );
});

test("session_start uses the hint and the first record's timestamp", () => {
  const { events } = oh([
    { id: 0, timestamp: "2026-07-07T08:30:12.114582", source: "user", action: "message", args: { content: "hi" } },
  ]);
  assert.equal(events[0].event, "session_start");
  assert.equal(events[0].session, "oh-1");
  assert.equal(events[0].ts, "2026-07-07T08:30:12.114582");
});

test("parseOpenHands accepts a JSON array and JSONL equally", () => {
  const records = [
    { id: 1, source: "user", action: "message", args: { content: "hi" } },
    { id: 2, source: "agent", action: "run", args: { command: "ls" } },
  ];
  const fromArray = parseOpenHands(JSON.stringify(records), { sessionHint: "s" });
  const fromJsonl = parseOpenHands(records.map((r) => JSON.stringify(r)).join("\n"), {
    sessionHint: "s",
  });
  // JSONL adds line provenance; strip source before comparing.
  const strip = (events) => events.map(({ source, ...rest }) => rest);
  assert.deepEqual(strip(fromArray.events), strip(fromJsonl.events));
  assert.equal(fromJsonl.events[1].source.line, 1);
});

test("malformed records and truncated arrays warn instead of throwing", () => {
  const { events, warnings } = oh([{ id: 1, hello: "world" }, "not even an object"]);
  assert.equal(events.length, 1); // just session_start
  assert.equal(warnings.length, 2);
  const truncated = parseOpenHands('[{"id":1,"action":"message"', {});
  assert.equal(truncated.events.length, 0);
  assert.equal(truncated.warnings.length, 1);
});
