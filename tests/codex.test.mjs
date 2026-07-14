// Codex rollout parser: session_meta handling, the reasoning buffer that
// attaches thinking to the next assistant activity, shell-output JSON
// unwrapping, token_count patching, and event_msg de-duplication.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseCodex } from "../dist/parsers/codex.js";
import { codexLine } from "./helpers.mjs";

const META = codexLine("session_meta", {
  id: "sess-1",
  cwd: "/workspace/demo",
  originator: "codex_cli_rs",
  cli_version: "0.29.0",
  git: { branch: "main" },
});

function userMsg(text) {
  return codexLine("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
}

function agentMsg(text) {
  return codexLine("response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  });
}

test("session_meta becomes session_start; instructions become a system message", () => {
  const { events } = parseCodex(META);
  assert.equal(events[0].event, "session_start");
  assert.equal(events[0].session, "sess-1");
  assert.deepEqual(events[0].meta, {
    cwd: "/workspace/demo",
    version: "0.29.0",
    originator: "codex_cli_rs",
    branch: "main",
  });
  const withInstructions = codexLine("session_meta", { id: "s", instructions: "Be terse." });
  const system = parseCodex(withInstructions).events.find((e) => e.role === "system");
  assert.equal(system.event, "message");
  assert.equal(system.text, "Be terse.");
});

test("turn_context sets the model for later assistant messages, emits nothing", () => {
  const text = [
    META,
    codexLine("turn_context", { model: "gpt-5-codex" }),
    agentMsg("done"),
  ].join("\n");
  const { events } = parseCodex(text);
  assert.equal(events.length, 2); // session_start + message
  assert.equal(events[1].model, "gpt-5-codex");
});

test("reasoning buffers and attaches to the NEXT assistant message", () => {
  const text = [
    META,
    codexLine("response_item", {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "consider the cache" }],
      content: [],
    }),
    agentMsg("Cleared the cache."),
  ].join("\n");
  const { events } = parseCodex(text);
  const message = events.find((e) => e.event === "message");
  assert.equal(message.thinking, "consider the cache");
  assert.equal(message.text, "Cleared the cache.");
});

test("reasoning attaches to a tool_call when that comes first", () => {
  const text = [
    META,
    codexLine("response_item", {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "grep before editing" }],
    }),
    codexLine("response_item", {
      type: "function_call",
      name: "shell",
      arguments: '{"command":["ls"]}',
      call_id: "c1",
    }),
  ].join("\n");
  const { events } = parseCodex(text);
  const call = events.find((e) => e.event === "tool_call");
  assert.equal(call.thinking, "grep before editing");
  assert.deepEqual(call.tool.input, { command: ["ls"] });
});

test("trailing reasoning with no assistant activity still becomes an event", () => {
  const text = [
    META,
    codexLine("response_item", {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "half-finished thought" }],
    }),
  ].join("\n");
  const { events } = parseCodex(text);
  const last = events[events.length - 1];
  assert.equal(last.event, "message");
  assert.equal(last.thinking, "half-finished thought");
  assert.equal(last.text, undefined);
});

test("function_call arguments parse from a JSON string; garbage is preserved", () => {
  const text = [
    META,
    codexLine("response_item", {
      type: "function_call",
      name: "apply_patch",
      arguments: "not-json{",
      call_id: "c2",
    }),
  ].join("\n");
  const { events } = parseCodex(text);
  const call = events.find((e) => e.event === "tool_call");
  assert.deepEqual(call.tool.input, { _raw: "not-json{" });
});

test("shell output JSON unwraps with exit-code errors; plain strings pass through", () => {
  const text = [
    META,
    codexLine("response_item", {
      type: "function_call_output",
      call_id: "c1",
      output: '{"output":"No such file\\n","metadata":{"exit_code":2,"duration_seconds":0.1}}',
    }),
    codexLine("response_item", { type: "function_call_output", call_id: "c2", output: "done" }),
  ].join("\n");
  const { events } = parseCodex(text);
  const [wrapped, plain] = events.filter((e) => e.event === "tool_result");
  assert.equal(wrapped.tool.output, "No such file\n");
  assert.equal(wrapped.tool.error, true);
  assert.equal(wrapped.tool.id, "c1");
  assert.equal(plain.tool.output, "done");
  assert.equal(plain.tool.error, false);
});

test("local_shell_call maps to a local_shell tool_call with the command", () => {
  const text = [
    META,
    codexLine("response_item", {
      type: "local_shell_call",
      call_id: "c3",
      status: "completed",
      action: { type: "exec", command: ["cat", "a.txt"] },
    }),
  ].join("\n");
  const { events } = parseCodex(text);
  const call = events.find((e) => e.event === "tool_call");
  assert.equal(call.tool.name, "local_shell");
  assert.deepEqual(call.tool.input, { command: ["cat", "a.txt"] });
});

test("context-wrapper pseudo-user messages become notes, not user messages", () => {
  const text = [META, userMsg("<user_instructions>\nAlways run make lint\n</user_instructions>")].join("\n");
  const { events } = parseCodex(text);
  assert.equal(events.filter((e) => e.event === "message" && e.role === "user").length, 0);
  assert.match(events.find((e) => e.event === "note").text, /user_instructions/);
});

test("token_count patches the last assistant event, or falls back to a note", () => {
  const patched = parseCodex(
    [
      META,
      agentMsg("answer"),
      codexLine("event_msg", {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 500, output_tokens: 60, cached_input_tokens: 200 } },
      }),
    ].join("\n")
  );
  const message = patched.events.find((e) => e.event === "message");
  assert.deepEqual(message.usage, { input: 500, output: 60, cache_read: 200 });
  // With no assistant event yet, the numbers survive as a usage note.
  const orphan = parseCodex(
    [
      META,
      codexLine("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 9, output_tokens: 1 } } }),
    ].join("\n")
  );
  assert.deepEqual(orphan.events.find((e) => e.event === "note").usage, { input: 9, output: 1 });
});

test("event_msg user/agent messages dedupe against just-emitted response_items", () => {
  const text = [
    META,
    userMsg("fix the bug"),
    codexLine("event_msg", { type: "user_message", message: "fix the bug" }),
    codexLine("event_msg", { type: "agent_message", message: "only in event_msg" }),
  ].join("\n");
  const { events } = parseCodex(text);
  const messages = events.filter((e) => e.event === "message");
  assert.equal(messages.filter((m) => m.text === "fix the bug").length, 1);
  assert.equal(messages.filter((m) => m.text === "only in event_msg").length, 1);
});

test("lenient by design: missing session_meta synthesizes a start, unknown items warn", () => {
  const truncated = parseCodex(userMsg("hello"), { sessionHint: "rollout-x" });
  assert.equal(truncated.events[0].event, "session_start");
  assert.equal(truncated.events[0].session, "rollout-x");
  assert.equal(truncated.events[1].text, "hello");
  const unknown = parseCodex([META, codexLine("response_item", { type: "hologram" })].join("\n"));
  assert.equal(unknown.warnings.length, 1);
  assert.equal(unknown.warnings[0].line, 2);
  assert.match(unknown.warnings[0].message, /hologram/);
});
