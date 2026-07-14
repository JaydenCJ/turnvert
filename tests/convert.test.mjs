// The convert orchestrator: dispatch, multi-file sequencing, directory
// inputs, determinism, and the serializer's canonical key order. Also pins
// VERSION against package.json so the two cannot drift.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  convertPath,
  convertPaths,
  convertText,
  sequenceEvents,
  sortEventFiles,
} from "../dist/convert.js";
import { serializeEvent } from "../dist/jsonl.js";
import { validateEventObject } from "../dist/validate.js";
import { VERSION } from "../dist/version.js";
import { claudeLine, codexLine, EXAMPLES, FIXTURES, ROOT } from "./helpers.mjs";

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("convertText dispatches to the right parser for each harness", () => {
  const claude = convertText(claudeLine("user", { role: "user", content: "hi" }), "claude-code");
  assert.equal(claude.events[0].harness, "claude-code");
  const aider = convertText("# aider chat started at 2026-07-01 09:00:00\n", "aider");
  assert.equal(aider.events[0].harness, "aider");
});

test("convertPaths merges files into ONE seq run in argument order", () => {
  assert.deepEqual(
    sequenceEvents([{ a: 1 }, { a: 2 }, { a: 3 }]).map((e) => e.seq),
    [1, 2, 3]
  );
  const run = convertPaths([
    join(EXAMPLES, "claude-code-session.jsonl"),
    join(EXAMPLES, "codex-rollout.jsonl"),
  ]);
  assert.equal(run.failures.length, 0);
  const seqs = run.events.map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1));
  // The codex events start after the claude events, in argument order.
  const firstCodex = run.events.findIndex((e) => e.harness === "codex");
  assert.ok(firstCodex > 0);
  assert.ok(run.events.slice(0, firstCodex).every((e) => e.harness === "claude-code"));
});

test("every event converted from the bundled examples passes the validator", () => {
  const run = convertPaths([
    join(EXAMPLES, "claude-code-session.jsonl"),
    join(EXAMPLES, "codex-rollout.jsonl"),
    join(EXAMPLES, "aider-chat-history.md"),
    join(EXAMPLES, "openhands-events.json"),
  ]);
  assert.equal(run.failures.length, 0);
  assert.equal(run.warnings.length, 0);
  for (const event of run.events) {
    const roundTripped = JSON.parse(serializeEvent(event));
    assert.deepEqual(validateEventObject(roundTripped), [], serializeEvent(event));
  }
});

test("a missing input is a failure, not a crash, and other inputs still convert", () => {
  const run = convertPaths([
    join(EXAMPLES, "no-such-log.jsonl"),
    join(EXAMPLES, "codex-rollout.jsonl"),
  ]);
  assert.equal(run.failures.length, 1);
  assert.match(run.failures[0].message, /no such file/);
  assert.ok(run.events.length > 0);
});

test("clear per-file rejections: undetectable content, wrong harness on a directory", () => {
  const undetectable = convertPath(join(ROOT, "package.json"));
  assert.match(undetectable.error, /--harness/);
  const wrongForced = convertPath(join(FIXTURES, "openhands-events-dir"), { harness: "codex" });
  assert.match(wrongForced.error, /directory input/);
});

test("an OpenHands events/ directory converts with numeric file order", () => {
  const { result, harness } = convertPath(join(FIXTURES, "openhands-events-dir"));
  assert.equal(harness, "openhands");
  const texts = result.events.filter((e) => e.event === "message").map((m) => m.text);
  // 10.json must sort after 2.json (numeric, not lexicographic).
  assert.deepEqual(texts, ["first", "second", "tenth"]);
  assert.deepEqual(sortEventFiles(["10.json", "2.json", "1.json"]), ["1.json", "2.json", "10.json"]);
  assert.deepEqual(sortEventFiles(["b.json", "a.json"]), ["a.json", "b.json"]);
});

test("a UTF-8 BOM does not cost the first line: session metadata survives", () => {
  // Logs copied through Windows tooling often gain a BOM; before stripping
  // it, line 1 (usually session_meta) failed to parse and the session id,
  // cwd and version were silently lost.
  const body =
    codexLine("session_meta", { id: "bom-session", cwd: "/workspace/x" }) +
    "\n" +
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }) +
    "\n";
  const run = convertText("\uFEFF" + body, "codex");
  assert.equal(run.warnings.length, 0);
  assert.equal(run.events[0].event, "session_start");
  assert.equal(run.events[0].session, "bom-session");
});

test("conversion is deterministic: same input, byte-identical output", () => {
  const path = join(EXAMPLES, "claude-code-session.jsonl");
  const once = convertPaths([path]).events.map(serializeEvent).join("\n");
  const twice = convertPaths([path]).events.map(serializeEvent).join("\n");
  assert.equal(once, twice);
});

test("serializeEvent emits the canonical key order", () => {
  const line = serializeEvent({
    raw: { x: 1 },
    session: "s",
    v: 1,
    text: "t",
    harness: "aider",
    ts: null,
    seq: 4,
    event: "note",
    usage: { output: 2, input: 1 },
    source: { line: 1 },
  });
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    "v",
    "seq",
    "event",
    "ts",
    "harness",
    "session",
    "text",
    "usage",
    "source",
    "raw",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(line).usage), ["input", "output"]);
});
