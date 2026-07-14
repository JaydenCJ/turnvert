// The validator is the schema contract other tools build against, so these
// tests pin the rules exactly: required fields per event kind, the open
// harness set, the x_ extension escape hatch, and the seq chain.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EVENT_JSON_SCHEMA } from "../dist/schema.js";
import { EVENT_KINDS, ROLES } from "../dist/types.js";
import { validateEventObject, validateJsonl } from "../dist/validate.js";
import { jsonl, normalEvent } from "./helpers.mjs";

test("a minimal valid event of every kind passes", () => {
  const samples = [
    normalEvent({ event: "session_start", text: undefined }),
    normalEvent({ event: "message", role: "user", text: "hi" }),
    normalEvent({ event: "message", role: "assistant", text: undefined, thinking: "hmm" }),
    normalEvent({ event: "tool_call", text: undefined, tool: { name: "run" } }),
    normalEvent({ event: "tool_result", text: undefined, tool: { id: "1", output: "" } }),
    normalEvent({ event: "note", text: "n" }),
  ];
  for (const sample of samples) {
    assert.deepEqual(validateEventObject(sample), [], JSON.stringify(sample));
  }
});

test("extensibility: x_ keys pass, other unknown keys fail, harness is open", () => {
  assert.match(validateEventObject(normalEvent({ vendor: "yes" }))[0], /unknown key "vendor"/);
  assert.deepEqual(validateEventObject(normalEvent({ x_vendor: { any: ["shape"] } })), []);
  // Third-party producers may name their own harness — any non-empty string.
  assert.deepEqual(validateEventObject(normalEvent({ harness: "my-future-harness" })), []);
  assert.equal(validateEventObject(normalEvent({ harness: "" })).length, 1);
  assert.equal(validateEventObject(normalEvent({ harness: 7 })).length, 1);
});

test("v must be the literal 1 and seq a positive integer", () => {
  assert.match(validateEventObject(normalEvent({ v: 2 }))[0], /"v" must be 1/);
  assert.match(validateEventObject(normalEvent({ seq: 0 }))[0], /positive integer/);
  assert.match(validateEventObject(normalEvent({ seq: 1.5 }))[0], /positive integer/);
});

test("ts accepts null, naive, zoned and fractional ISO-8601; rejects junk", () => {
  for (const ts of [null, "2026-07-01T09:00:00", "2026-07-01T09:00:00Z", "2026-07-01T09:00:00.123+09:00"]) {
    assert.deepEqual(validateEventObject(normalEvent({ ts })), [], String(ts));
  }
  assert.equal(validateEventObject(normalEvent({ ts: "yesterday" })).length, 1);
  assert.equal(validateEventObject(normalEvent({ ts: 1720000000 })).length, 1);
});

test("message events require role and text-or-thinking", () => {
  const noRole = normalEvent({ event: "message", text: "hi" });
  assert.match(validateEventObject(noRole).join("\n"), /require "role"/);
  const empty = normalEvent({ event: "message", role: "user", text: undefined });
  assert.match(validateEventObject(empty).join("\n"), /"text" or "thinking"/);
  const badRole = normalEvent({ event: "message", role: "narrator", text: "hi" });
  assert.match(validateEventObject(badRole).join("\n"), /"role" must be one of/);
});

test("tool_call requires tool.name; tool_result requires tool.output", () => {
  const call = normalEvent({ event: "tool_call", text: undefined, tool: { id: "1" } });
  assert.match(validateEventObject(call).join("\n"), /tool\.name/);
  const result = normalEvent({ event: "tool_result", text: undefined, tool: { id: "1" } });
  assert.match(validateEventObject(result).join("\n"), /tool\.output/);
});

test("fields are fenced to their event kinds", () => {
  const noteWithTool = normalEvent({ event: "note", text: "n", tool: { name: "x" } });
  assert.match(validateEventObject(noteWithTool).join("\n"), /"tool" is not allowed on note/);
  const startWithRole = normalEvent({ event: "session_start", text: undefined, role: "user" });
  assert.match(validateEventObject(startWithRole).join("\n"), /"role" is not allowed/);
  const messageWithMeta = normalEvent({ event: "message", role: "user", text: "t", meta: { a: "b" } });
  assert.match(validateEventObject(messageWithMeta).join("\n"), /"meta" is not allowed/);
});

test("nested shapes: usage counters, source.line, meta values", () => {
  const badUsage = validateEventObject(normalEvent({ usage: { input: -1, wat: 3 } })).join("\n");
  assert.match(badUsage, /usage\.input/);
  assert.match(badUsage, /unknown key "usage\.wat"/);
  assert.deepEqual(validateEventObject(normalEvent({ usage: { input: 0, cache_read: 5 } })), []);
  assert.match(
    validateEventObject(normalEvent({ source: { line: 0 } })).join("\n"),
    /source\.line/
  );
  assert.match(
    validateEventObject(
      normalEvent({ event: "session_start", text: undefined, meta: { n: 4 } })
    ).join("\n"),
    /meta\.n/
  );
});

test("validateJsonl enforces the seq chain across lines", () => {
  const doc = jsonl(normalEvent({ seq: 1 }), normalEvent({ seq: 3 }), normalEvent({ seq: 4 }));
  const report = validateJsonl(doc);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].line, 2);
  assert.match(report.errors[0].message, /expected 2, got 3/);
});

test("validateJsonl flags blank/non-object lines and reports the counts", () => {
  const broken = validateJsonl(`${JSON.stringify(normalEvent())}\n\n[1,2]\n`);
  assert.deepEqual(
    broken.errors.map((e) => e.line),
    [2, 3]
  );
  assert.equal(validateJsonl("").errors[0].message, "no events found");
  const counted = validateJsonl(
    jsonl(
      normalEvent({ seq: 1, session: "a" }),
      normalEvent({ seq: 2, session: "b" }),
      normalEvent({ seq: 3, session: "a" })
    )
  );
  assert.equal(counted.eventCount, 3);
  assert.equal(counted.sessionCount, 2);
});

test("the JSON Schema agrees with the validator on kinds, roles and fields", () => {
  // Event kinds and roles come from the same constants.
  assert.deepEqual(EVENT_JSON_SCHEMA.properties.event.enum, [...EVENT_KINDS]);
  assert.deepEqual(EVENT_JSON_SCHEMA.properties.role.enum, [...ROLES]);
  // Every top-level key the validator accepts is declared in the schema.
  const schemaKeys = Object.keys(EVENT_JSON_SCHEMA.properties);
  for (const key of ["v", "seq", "event", "ts", "harness", "session", "role", "model", "text", "thinking", "tool", "usage", "meta", "source", "raw"]) {
    assert.ok(schemaKeys.includes(key), `schema missing ${key}`);
  }
  // The x_ extension rule is present, and unknown keys are otherwise closed.
  assert.ok(Object.keys(EVENT_JSON_SCHEMA.patternProperties).includes("^x_"));
  assert.equal(EVENT_JSON_SCHEMA.additionalProperties, false);
  // Required tool fields match the per-kind rules.
  const byKind = Object.fromEntries(
    EVENT_JSON_SCHEMA.allOf.map((rule) => [rule.if.properties.event.const, rule.then])
  );
  assert.deepEqual(byKind.tool_call.properties.tool.required, ["name"]);
  assert.deepEqual(byKind.tool_result.properties.tool.required, ["output"]);
  assert.deepEqual(byKind.note.required, ["text"]);
});
