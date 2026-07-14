// Harness auto-detection must be content-first: renamed files still detect,
// and a wrong extension never misleads. These tests pin the classification
// rules for all four harnesses plus the refusal cases.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { detectHarness } from "../dist/detect.js";
import { claudeLine, codexLine, EXAMPLES } from "./helpers.mjs";

test("detects claude-code from typed JSONL lines, including a summary opener", () => {
  const user = claudeLine("user", { role: "user", content: "hi" });
  assert.equal(detectHarness(user), "claude-code");
  const summary = JSON.stringify({ type: "summary", summary: "S", leafUuid: "x" });
  assert.equal(detectHarness(summary), "claude-code");
});

test("detects codex from session_meta and from a bare response_item", () => {
  assert.equal(detectHarness(codexLine("session_meta", { id: "abc" })), "codex");
  const item = codexLine("response_item", { type: "message", role: "user", content: [] });
  assert.equal(detectHarness(item), "codex");
});

test("detects aider from the chat banner", () => {
  assert.equal(detectHarness("# aider chat started at 2026-07-01 10:00:00\n"), "aider");
});

test("detects openhands from a JSON array and from JSONL observations", () => {
  const array = JSON.stringify([{ id: 0, source: "user", action: "message", args: {} }]);
  assert.equal(detectHarness(array), "openhands");
  const jsonl = JSON.stringify({ id: 3, cause: 2, observation: "run", content: "ok" });
  assert.equal(detectHarness(jsonl), "openhands");
});

test("skips leading unparseable lines before classifying", () => {
  const text = "not json\n" + codexLine("turn_context", { model: "m" });
  assert.equal(detectHarness(text), "codex");
});

test("returns null for arbitrary JSON, prose, and arrays of non-events", () => {
  assert.equal(detectHarness('{"hello":"world"}'), null);
  assert.equal(detectHarness("# just a markdown file\n\nsome prose"), null);
  assert.equal(detectHarness(""), null);
  assert.equal(detectHarness("[1, 2, 3]"), null);
  assert.equal(detectHarness('[{"foo":"bar"}]'), null);
});

test("filename hints only break ties content cannot settle", () => {
  // Content wins: a codex rollout named like an aider history is codex.
  const codex = codexLine("session_meta", { id: "abc" });
  assert.equal(detectHarness(codex, "/tmp/x/.aider.chat.history.md"), "codex");
  // Unclassifiable content falls back to the filename.
  assert.equal(detectHarness("plain text", "/logs/.aider.chat.history.md"), "aider");
  assert.equal(detectHarness("plain text", "/logs/rollout-2026-07-01T10-00-00-abc.jsonl"), "codex");
  assert.equal(detectHarness("plain text", "/logs/notes.txt"), null);
});

test("all four bundled examples detect as their harness", () => {
  const cases = [
    ["claude-code-session.jsonl", "claude-code"],
    ["codex-rollout.jsonl", "codex"],
    ["aider-chat-history.md", "aider"],
    ["openhands-events.json", "openhands"],
  ];
  for (const [file, expected] of cases) {
    const text = readFileSync(join(EXAMPLES, file), "utf8");
    assert.equal(detectHarness(text, file), expected, file);
  }
});
