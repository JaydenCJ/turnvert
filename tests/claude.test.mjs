// Claude Code parser: session metadata harvesting, content flattening,
// tool_use/tool_result unwrapping, and the usage-attaches-once rule that
// keeps token aggregation honest.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseClaudeCode } from "../dist/parsers/claude.js";
import { claudeLine } from "./helpers.mjs";

test("emits session_start first, with metadata from the first stateful line", () => {
  const text = [
    JSON.stringify({ type: "summary", summary: "Earlier work", leafUuid: "x" }),
    claudeLine("user", { role: "user", content: "hi" }, { gitBranch: "main" }),
  ].join("\n");
  const { events } = parseClaudeCode(text);
  assert.equal(events[0].event, "session_start");
  assert.equal(events[0].session, "test-session");
  assert.deepEqual(events[0].meta, { cwd: "/workspace/demo", version: "1.0.0", branch: "main" });
  assert.equal(events[0].ts, "2026-07-01T10:00:00.000Z");
});

test("summary lines become notes and keep their source line number", () => {
  const text = [
    JSON.stringify({ type: "summary", summary: "Refactor the queue", leafUuid: "x" }),
    claudeLine("user", { role: "user", content: "hi" }),
  ].join("\n");
  const { events } = parseClaudeCode(text, { file: "log.jsonl" });
  const note = events.find((e) => e.event === "note");
  assert.equal(note.text, "Refactor the queue");
  assert.deepEqual(note.source, { file: "log.jsonl", line: 1 });
});

test("string content and text-array content both flatten to message text", () => {
  const text = [
    claudeLine("user", { role: "user", content: "plain string" }),
    claudeLine("user", { role: "user", content: [{ type: "text", text: "from array" }] }),
  ].join("\n");
  const { events } = parseClaudeCode(text);
  const messages = events.filter((e) => e.event === "message");
  assert.deepEqual(
    messages.map((m) => m.text),
    ["plain string", "from array"]
  );
  assert.ok(messages.every((m) => m.role === "user"));
});

test("assistant text + thinking + tool_use fan out into message then tool_call", () => {
  const text = claudeLine("assistant", {
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content: [
      { type: "thinking", thinking: "check the file first" },
      { type: "text", text: "Looking now." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } },
    ],
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  const { events } = parseClaudeCode(text);
  const [_, message, call] = events;
  assert.equal(message.event, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.text, "Looking now.");
  assert.equal(message.thinking, "check the file first");
  assert.equal(call.event, "tool_call");
  assert.deepEqual(call.tool, { id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } });
});

test("model and usage attach to the FIRST event of an API response only", () => {
  const text = claudeLine("assistant", {
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content: [
      { type: "text", text: "Two calls coming." },
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
      { type: "tool_use", id: "t2", name: "Bash", input: {} },
    ],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
  });
  const { events } = parseClaudeCode(text);
  const [_, message, call1, call2] = events;
  assert.deepEqual(message.usage, { input: 10, output: 5, cache_read: 3 });
  assert.equal(message.model, "claude-sonnet-4-20250514");
  assert.equal(call1.usage, undefined);
  assert.equal(call2.usage, undefined);
});

test("a tool_use-only response pins usage to the tool_call instead", () => {
  const text = claudeLine("assistant", {
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
    usage: { input_tokens: 7, output_tokens: 3 },
  });
  const { events } = parseClaudeCode(text);
  const call = events.find((e) => e.event === "tool_call");
  assert.deepEqual(call.usage, { input: 7, output: 3 });
  assert.equal(call.model, "claude-sonnet-4-20250514");
});

test("tool results ride inside user lines and unwrap with is_error", () => {
  const text = [
    claudeLine("user", {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_9",
          content: [{ type: "text", text: "command not found" }],
          is_error: true,
        },
      ],
    }),
    claudeLine("user", {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "done", is_error: false }],
    }),
  ].join("\n");
  const { events } = parseClaudeCode(text);
  const results = events.filter((e) => e.event === "tool_result");
  assert.deepEqual(results[0].tool, { id: "toolu_9", output: "command not found", error: true });
  // String content is preserved verbatim too.
  assert.deepEqual(results[1].tool, { id: "t", output: "done", error: false });
  // No message events: both lines carried only tool results.
  assert.equal(events.filter((e) => e.event === "message").length, 0);
});

test("isMeta user lines and system lines become notes, not messages", () => {
  const text = [
    claudeLine(
      "user",
      { role: "user", content: "Caveat: the messages below were generated during a resume" },
      { isMeta: true }
    ),
    claudeLine("system", undefined, { content: "Hook PostToolUse ran successfully", level: "info" }),
  ].join("\n");
  const { events } = parseClaudeCode(text);
  assert.equal(events.filter((e) => e.event === "message").length, 0);
  const notes = events.filter((e) => e.event === "note");
  assert.match(notes[0].text, /^Caveat/);
  assert.equal(notes[1].text, "Hook PostToolUse ran successfully");
});

test("invalid JSON and unknown line types are warnings, never crashes", () => {
  const text = [
    "{{{not json",
    claudeLine("user", { role: "user", content: "hi" }),
    JSON.stringify({ type: "wormhole", uuid: "u1" }),
  ].join("\n");
  const { events, warnings } = parseClaudeCode(text);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].line, 1);
  assert.match(warnings[0].message, /invalid JSON/);
  assert.match(warnings[1].message, /wormhole/);
  assert.equal(events.filter((e) => e.event === "message").length, 1);
});

test("parser options: sessionHint fallback and includeRaw round-trip", () => {
  // No line carries a sessionId → the hint (usually the filename) wins.
  const summaryOnly = JSON.stringify({ type: "summary", summary: "s", leafUuid: "x" });
  const hinted = parseClaudeCode(summaryOnly, { sessionHint: "from-filename" });
  assert.equal(hinted.events[0].session, "from-filename");
  // includeRaw attaches the untouched source record; the default omits it.
  const text = claudeLine("user", { role: "user", content: "hi" });
  assert.equal(parseClaudeCode(text, { includeRaw: true }).events[1].raw.type, "user");
  assert.equal(parseClaudeCode(text).events[1].raw, undefined);
});
