/**
 * Parser for OpenHands event streams.
 *
 * Accepted inputs: a JSON array of events (trajectory export), JSONL with
 * one event per line, or — handled by the convert layer — a session
 * `events/` directory of numbered `<id>.json` files.
 *
 * OpenHands splits everything into actions and observations linked by
 * `cause`, which maps almost 1:1 onto the normalized model:
 *
 *   action "message" / "system"      → message (user / assistant / system)
 *   action "think"                   → message with `thinking` only
 *   action "finish"                  → note
 *   any other action                 → tool_call (name = action, input = args,
 *                                      `thought` lifted into `thinking`)
 *   observation with a `cause`       → tool_result (id = cause, exit codes
 *                                      in `extras` decide `error`)
 *   observation "agent_state_changed"→ note
 *   other cause-less observations    → note
 */

import { asNumber, asString, isPlainObject, isoOrNull, splitLines, tryParseJson } from "../jsonl.js";
import type { DraftEvent, ParseOptions, ParseResult, ParseWarning } from "../types.js";

/** Parse OpenHands events from text (JSON array or JSONL). */
export function parseOpenHands(text: string, opts: ParseOptions = {}): ParseResult {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) {
    const parsed = tryParseJson(text);
    if (parsed.ok && Array.isArray(parsed.value)) {
      return parseOpenHandsEvents(parsed.value, opts);
    }
    return {
      events: [],
      warnings: [{ message: "input looks like a JSON array but does not parse" }],
    };
  }

  const records: unknown[] = [];
  const warnings: ParseWarning[] = [];
  const lineOf = new Map<unknown, number>();
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const parsed = tryParseJson(line);
    if (!parsed.ok) {
      warnings.push({ line: i + 1, message: "invalid JSON, line skipped" });
      continue;
    }
    records.push(parsed.value);
    lineOf.set(parsed.value, i + 1);
  }
  const result = parseOpenHandsEvents(records, opts, lineOf);
  return { events: result.events, warnings: [...warnings, ...result.warnings] };
}

/** Parse an already-decoded list of OpenHands event objects. */
export function parseOpenHandsEvents(
  records: unknown[],
  opts: ParseOptions = {},
  lineOf?: Map<unknown, number>
): ParseResult {
  const events: DraftEvent[] = [];
  const warnings: ParseWarning[] = [];
  const session = opts.sessionHint ?? "openhands-session";

  const first = records.find((r) => isPlainObject(r));
  events.push({
    v: 1,
    event: "session_start",
    ts: isPlainObject(first) ? isoOrNull(first.timestamp) : null,
    harness: "openhands",
    session,
    ...(opts.file !== undefined ? { source: { file: opts.file } } : {}),
  });

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!isPlainObject(record)) {
      warnings.push({ message: `record ${i} is not an object, skipped` });
      continue;
    }
    const converted = convertRecord(record, session, opts, lineOf?.get(record));
    if (converted === null) {
      warnings.push({
        ...(lineOf?.get(record) !== undefined ? { line: lineOf.get(record) } : {}),
        message: `record ${i} has neither "action" nor "observation", skipped`,
      });
      continue;
    }
    events.push(...converted);
  }

  return { events, warnings };
}

function provenance(
  record: Record<string, unknown>,
  opts: ParseOptions,
  line: number | undefined
): DraftEvent["source"] {
  const id = record.id;
  return {
    ...(opts.file !== undefined ? { file: opts.file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(typeof id === "number" || typeof id === "string" ? { id: String(id) } : {}),
  };
}

function convertRecord(
  record: Record<string, unknown>,
  session: string,
  opts: ParseOptions,
  line: number | undefined
): DraftEvent[] | null {
  const ts = isoOrNull(record.timestamp);
  const source = provenance(record, opts, line);
  const rawField = opts.includeRaw ? { raw: record } : {};
  const common = { v: 1 as const, ts, harness: "openhands", session, source, ...rawField };
  const args = isPlainObject(record.args) ? record.args : {};
  const extras = isPlainObject(record.extras) ? record.extras : {};

  const action = asString(record.action);
  if (action !== undefined) {
    if (action === "message") {
      const text = asString(args.content) ?? asString(record.message) ?? "";
      if (text === "") return [];
      const role = record.source === "user" ? "user" : "assistant";
      const thought = role === "assistant" ? asString(args.thought) : undefined;
      return [
        {
          ...common,
          event: "message",
          role,
          text,
          ...(thought !== undefined && thought !== text ? { thinking: thought } : {}),
        },
      ];
    }
    if (action === "system") {
      const text = asString(args.content) ?? asString(record.message) ?? "";
      return text === "" ? [] : [{ ...common, event: "message", role: "system", text }];
    }
    if (action === "think") {
      const thought = asString(args.thought) ?? asString(record.message) ?? "";
      return thought === "" ? [] : [{ ...common, event: "message", role: "assistant", thinking: thought }];
    }
    if (action === "finish") {
      const text =
        asString(args.final_thought) ?? asString(args.thought) ?? asString(record.message) ?? "finish";
      return [{ ...common, event: "note", text }];
    }
    // Everything else — run, run_ipython, read, write, edit, browse,
    // recall, delegate, … — is the agent acting on its environment.
    const thought = asString(args.thought);
    const input = { ...args };
    delete input.thought;
    return [
      {
        ...common,
        event: "tool_call",
        ...(thought !== undefined ? { thinking: thought } : {}),
        tool: {
          ...(record.id !== undefined ? { id: String(record.id) } : {}),
          name: action,
          ...(Object.keys(input).length > 0 ? { input } : {}),
        },
      },
    ];
  }

  const observation = asString(record.observation);
  if (observation !== undefined) {
    if (observation === "agent_state_changed") {
      const stateName = asString(extras.agent_state) ?? "unknown";
      return [{ ...common, event: "note", text: `agent state: ${stateName}` }];
    }
    if (observation === "null") return [];

    const cause = record.cause;
    const content = asString(record.content) ?? asString(record.message) ?? "";
    if (typeof cause === "number" || typeof cause === "string") {
      const exitCode = asNumber(extras.exit_code) ?? asNumber(extras.metadata_exit_code);
      const error = observation === "error" || (exitCode !== undefined && exitCode !== 0);
      return [
        {
          ...common,
          event: "tool_result",
          tool: {
            id: String(cause),
            name: observation,
            output: content,
            error,
          },
        },
      ];
    }
    return content === "" ? [] : [{ ...common, event: "note", text: content }];
  }

  return null;
}
