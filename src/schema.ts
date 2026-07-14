/**
 * The machine-readable JSON Schema (draft 2020-12) for one turnvert event.
 * `turnvert schema` prints exactly this object; a test asserts it agrees
 * with the hand-rolled validator in validate.ts on every event kind, field
 * name, and enum value, so the two cannot drift apart silently.
 */

import { EVENT_KINDS, HARNESSES, ROLES } from "./types.js";

const TS = {
  type: ["string", "null"],
  description:
    "ISO-8601 timestamp as recorded by the source, or null. Naive local timestamps keep no zone.",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$",
};

export const EVENT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/JaydenCJ/turnvert/blob/main/docs/schema.md",
  title: "turnvert normalized event, schema version 1",
  description:
    "One line of turnvert JSONL. Keys prefixed x_ are reserved for extensions and always validate.",
  type: "object",
  required: ["v", "seq", "event", "ts", "harness", "session"],
  properties: {
    v: { const: 1, description: "Schema version." },
    seq: {
      type: "integer",
      minimum: 1,
      description: "1-based stream position; increments by exactly 1 per line.",
    },
    event: { enum: [...EVENT_KINDS] },
    ts: TS,
    harness: {
      type: "string",
      minLength: 1,
      description: `Producing harness. Open set; turnvert emits: ${HARNESSES.join(", ")}.`,
    },
    session: { type: "string", minLength: 1 },
    role: { enum: [...ROLES], description: "message only." },
    model: { type: "string" },
    text: { type: "string" },
    thinking: { type: "string" },
    tool: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        input: { description: "Parsed tool-call arguments; any JSON value." },
        output: { type: "string" },
        error: { type: "boolean" },
      },
      additionalProperties: false,
    },
    usage: {
      type: "object",
      properties: {
        input: { type: "number", minimum: 0 },
        output: { type: "number", minimum: 0 },
        cache_read: { type: "number", minimum: 0 },
        cache_write: { type: "number", minimum: 0 },
      },
      additionalProperties: false,
    },
    meta: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "session_start only.",
    },
    source: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        id: { type: "string" },
      },
      additionalProperties: false,
    },
    raw: { description: "The untouched source record; present only with --raw." },
  },
  patternProperties: {
    "^x_": { description: "Extension field; producers may attach any JSON value." },
  },
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { event: { const: "message" } } },
      then: {
        required: ["role"],
        anyOf: [{ required: ["text"] }, { required: ["thinking"] }],
      },
    },
    {
      if: { properties: { event: { const: "tool_call" } } },
      then: {
        required: ["tool"],
        properties: { tool: { required: ["name"] } },
      },
    },
    {
      if: { properties: { event: { const: "tool_result" } } },
      then: {
        required: ["tool"],
        properties: { tool: { required: ["output"] } },
      },
    },
    {
      if: { properties: { event: { const: "note" } } },
      then: { required: ["text"] },
    },
  ],
} as const;

/** Pretty-printed schema text for `turnvert schema`. */
export function renderSchema(): string {
  return JSON.stringify(EVENT_JSON_SCHEMA, null, 2);
}
