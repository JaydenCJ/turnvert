/**
 * Validator for normalized turnvert JSONL — the contract checker other
 * tools run against their own output. The rules here implement docs/
 * schema.md and mirror the JSON Schema in schema.ts; a test asserts the
 * two stay in sync.
 *
 * Design decisions worth naming:
 *   - `harness` is an OPEN set: third-party producers may emit their own
 *     harness names without failing validation.
 *   - Top-level keys outside the specification are rejected, EXCEPT keys
 *     prefixed `x_`, which are reserved for extensions and always pass.
 */

import { isPlainObject, splitLines, tryParseJson } from "./jsonl.js";
import { EVENT_KINDS, ROLES } from "./types.js";
import type { NormalEvent } from "./types.js";

export interface ValidationError {
  /** 1-based line number in the validated JSONL. */
  line: number;
  message: string;
}

export interface ValidationReport {
  errors: ValidationError[];
  /** Events that parsed as JSON objects (even if they had field errors). */
  eventCount: number;
  /** Distinct `session` values seen. */
  sessionCount: number;
}

const TOP_LEVEL_KEYS = new Set([
  "v",
  "seq",
  "event",
  "ts",
  "harness",
  "session",
  "role",
  "model",
  "text",
  "thinking",
  "tool",
  "usage",
  "meta",
  "source",
  "raw",
]);

const TOOL_KEYS = new Set(["id", "name", "input", "output", "error"]);
const USAGE_KEYS = new Set(["input", "output", "cache_read", "cache_write"]);
const SOURCE_KEYS = new Set(["file", "line", "id"]);

/** ISO-8601 date-time, zone optional (naive local timestamps are legal). */
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

function isExtensionKey(key: string): boolean {
  return key.startsWith("x_");
}

/** Validate a single decoded event object. Returns human-readable problems. */
export function validateEventObject(obj: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(obj)) return ["event is not a JSON object"];

  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key) && !isExtensionKey(key)) {
      errors.push(`unknown key "${key}" (extensions must use the x_ prefix)`);
    }
  }

  if (obj.v !== 1) errors.push(`"v" must be 1, got ${JSON.stringify(obj.v)}`);
  if (typeof obj.seq !== "number" || !Number.isInteger(obj.seq) || obj.seq < 1) {
    errors.push(`"seq" must be a positive integer, got ${JSON.stringify(obj.seq)}`);
  }

  const event = obj.event;
  const knownEvent = typeof event === "string" && (EVENT_KINDS as readonly string[]).includes(event);
  if (!knownEvent) {
    errors.push(`"event" must be one of ${EVENT_KINDS.join("|")}, got ${JSON.stringify(event)}`);
  }

  if (obj.ts !== null && typeof obj.ts !== "string") {
    errors.push(`"ts" must be an ISO-8601 string or null, got ${JSON.stringify(obj.ts)}`);
  } else if (typeof obj.ts === "string" && !TS_PATTERN.test(obj.ts)) {
    errors.push(`"ts" is not ISO-8601: ${JSON.stringify(obj.ts)}`);
  } else if (!("ts" in obj)) {
    errors.push(`"ts" is required (use null when the source has no timestamp)`);
  }

  if (typeof obj.harness !== "string" || obj.harness === "") {
    errors.push(`"harness" must be a non-empty string`);
  }
  if (typeof obj.session !== "string" || obj.session === "") {
    errors.push(`"session" must be a non-empty string`);
  }

  if ("role" in obj && !(ROLES as readonly string[]).includes(obj.role as string)) {
    errors.push(`"role" must be one of ${ROLES.join("|")}, got ${JSON.stringify(obj.role)}`);
  }
  if ("model" in obj && typeof obj.model !== "string") errors.push(`"model" must be a string`);
  if ("text" in obj && typeof obj.text !== "string") errors.push(`"text" must be a string`);
  if ("thinking" in obj && typeof obj.thinking !== "string") {
    errors.push(`"thinking" must be a string`);
  }

  if ("tool" in obj) errors.push(...validateTool(obj.tool));
  if ("usage" in obj) errors.push(...validateUsage(obj.usage));
  if ("meta" in obj) errors.push(...validateMeta(obj.meta));
  if ("source" in obj) errors.push(...validateSource(obj.source));

  if (knownEvent) errors.push(...validateKind(obj, event as NormalEvent["event"]));
  return errors;
}

function validateKind(obj: Record<string, unknown>, event: NormalEvent["event"]): string[] {
  const errors: string[] = [];
  const forbid = (keys: string[]): void => {
    for (const key of keys) {
      if (key in obj) errors.push(`"${key}" is not allowed on ${event} events`);
    }
  };

  switch (event) {
    case "session_start":
      forbid(["role", "tool", "text", "thinking"]);
      break;
    case "message":
      if (!("role" in obj)) errors.push(`message events require "role"`);
      if (!("text" in obj) && !("thinking" in obj)) {
        errors.push(`message events require "text" or "thinking"`);
      }
      forbid(["tool", "meta"]);
      break;
    case "tool_call":
      if (!isPlainObject(obj.tool) || typeof obj.tool.name !== "string" || obj.tool.name === "") {
        errors.push(`tool_call events require "tool.name"`);
      }
      forbid(["role", "text", "meta"]);
      break;
    case "tool_result":
      if (!isPlainObject(obj.tool)) {
        errors.push(`tool_result events require "tool"`);
      } else if (!("output" in obj.tool)) {
        errors.push(`tool_result events require "tool.output"`);
      }
      forbid(["role", "text", "thinking", "meta"]);
      break;
    case "note":
      if (typeof obj.text !== "string") errors.push(`note events require "text"`);
      forbid(["role", "tool", "meta"]);
      break;
  }
  return errors;
}

function validateTool(tool: unknown): string[] {
  if (!isPlainObject(tool)) return [`"tool" must be an object`];
  const errors: string[] = [];
  for (const key of Object.keys(tool)) {
    if (!TOOL_KEYS.has(key)) errors.push(`unknown key "tool.${key}"`);
  }
  if ("id" in tool && typeof tool.id !== "string") errors.push(`"tool.id" must be a string`);
  if ("name" in tool && typeof tool.name !== "string") errors.push(`"tool.name" must be a string`);
  if ("output" in tool && typeof tool.output !== "string") {
    errors.push(`"tool.output" must be a string`);
  }
  if ("error" in tool && typeof tool.error !== "boolean") {
    errors.push(`"tool.error" must be a boolean`);
  }
  return errors;
}

function validateUsage(usage: unknown): string[] {
  if (!isPlainObject(usage)) return [`"usage" must be an object`];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(usage)) {
    if (!USAGE_KEYS.has(key)) {
      errors.push(`unknown key "usage.${key}"`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`"usage.${key}" must be a non-negative number`);
    }
  }
  return errors;
}

function validateMeta(meta: unknown): string[] {
  if (!isPlainObject(meta)) return [`"meta" must be an object`];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value !== "string") errors.push(`"meta.${key}" must be a string`);
  }
  return errors;
}

function validateSource(source: unknown): string[] {
  if (!isPlainObject(source)) return [`"source" must be an object`];
  const errors: string[] = [];
  for (const key of Object.keys(source)) {
    if (!SOURCE_KEYS.has(key)) errors.push(`unknown key "source.${key}"`);
  }
  if ("file" in source && typeof source.file !== "string") {
    errors.push(`"source.file" must be a string`);
  }
  if ("line" in source && (typeof source.line !== "number" || !Number.isInteger(source.line) || source.line < 1)) {
    errors.push(`"source.line" must be a positive integer`);
  }
  if ("id" in source && typeof source.id !== "string") errors.push(`"source.id" must be a string`);
  return errors;
}

/** Validate a whole JSONL document, including the cross-line `seq` rule. */
export function validateJsonl(text: string): ValidationReport {
  const errors: ValidationError[] = [];
  const sessions = new Set<string>();
  let eventCount = 0;
  let expectedSeq = 1;

  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      errors.push({ line: lineNo, message: "blank line (JSONL must be one event per line)" });
      continue;
    }
    const parsed = tryParseJson(line);
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      errors.push({ line: lineNo, message: "not a JSON object" });
      continue;
    }
    eventCount += 1;
    const obj = parsed.value;
    for (const message of validateEventObject(obj)) errors.push({ line: lineNo, message });

    if (typeof obj.seq === "number" && Number.isInteger(obj.seq)) {
      if (obj.seq !== expectedSeq) {
        errors.push({
          line: lineNo,
          message: `"seq" must increment by 1 (expected ${expectedSeq}, got ${obj.seq})`,
        });
      }
      expectedSeq = obj.seq + 1;
    } else {
      expectedSeq += 1;
    }
    if (typeof obj.session === "string") sessions.add(obj.session);
  }

  if (eventCount === 0) {
    errors.push({ line: 1, message: "no events found" });
  }
  return { errors, eventCount, sessionCount: sessions.size };
}
