/**
 * Line and JSON plumbing shared by every parser, plus the canonical event
 * serializer. Serialization uses a fixed key order so that converting the
 * same log twice always produces byte-identical output — a property the
 * test suite and smoke script both pin.
 */

import type { NormalEvent, ToolInfo, Usage } from "./types.js";

/** Split text into lines, tolerating CRLF, a trailing newline, and a UTF-8
 * BOM (logs copied through Windows tooling often gain one; without stripping
 * it the first line — usually the session metadata — fails to parse). Line
 * numbers reported elsewhere are 1-based indexes into this array. */
export function splitLines(text: string): string[] {
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const lines = text.split(/\r\n|\n|\r/);
  // A trailing newline yields one empty phantom line; drop it so "number of
  // lines" matches what an editor shows.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** JSON.parse that reports failure instead of throwing. */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Narrow an unknown to a plain object (not null, not an array). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Return v when it is a non-empty string, else undefined. */
export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Return v when it is a finite number, else undefined. */
export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Pass an ISO-ish timestamp string through, anything else becomes null.
 * turnvert never invents timestamps and never rewrites zones. */
export function isoOrNull(v: unknown): string | null {
  const s = asString(v);
  return s !== undefined ? s : null;
}

/** Rebuild a `usage` object without undefined counters; drop it entirely
 * when no counter survived normalization. */
export function pruneUsage(usage: Usage): Usage | undefined {
  const out: Usage = {};
  if (usage.input !== undefined) out.input = usage.input;
  if (usage.output !== undefined) out.output = usage.output;
  if (usage.cache_read !== undefined) out.cache_read = usage.cache_read;
  if (usage.cache_write !== undefined) out.cache_write = usage.cache_write;
  return Object.keys(out).length > 0 ? out : undefined;
}

function orderedTool(tool: ToolInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (tool.id !== undefined) out.id = tool.id;
  if (tool.name !== undefined) out.name = tool.name;
  if (tool.input !== undefined) out.input = tool.input;
  if (tool.output !== undefined) out.output = tool.output;
  if (tool.error !== undefined) out.error = tool.error;
  return out;
}

function orderedUsage(usage: Usage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (usage.input !== undefined) out.input = usage.input;
  if (usage.output !== undefined) out.output = usage.output;
  if (usage.cache_read !== undefined) out.cache_read = usage.cache_read;
  if (usage.cache_write !== undefined) out.cache_write = usage.cache_write;
  return out;
}

/**
 * Serialize one event as a single JSONL line with canonical key order:
 * v, seq, event, ts, harness, session, role, model, text, thinking,
 * tool, usage, meta, source, raw. Undefined fields are omitted.
 */
export function serializeEvent(e: NormalEvent): string {
  const out: Record<string, unknown> = {
    v: e.v,
    seq: e.seq,
    event: e.event,
    ts: e.ts,
    harness: e.harness,
    session: e.session,
  };
  if (e.role !== undefined) out.role = e.role;
  if (e.model !== undefined) out.model = e.model;
  if (e.text !== undefined) out.text = e.text;
  if (e.thinking !== undefined) out.thinking = e.thinking;
  if (e.tool !== undefined) out.tool = orderedTool(e.tool);
  if (e.usage !== undefined) out.usage = orderedUsage(e.usage);
  if (e.meta !== undefined) out.meta = e.meta;
  if (e.source !== undefined) out.source = e.source;
  if (e.raw !== undefined) out.raw = e.raw;
  return JSON.stringify(out);
}
