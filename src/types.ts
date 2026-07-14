/**
 * The turnvert normalized event model, schema version 1.
 *
 * Every session log — whatever harness wrote it — is converted into a flat
 * stream of these events, one JSON object per output line. The shape is
 * deliberately small: five event kinds, a fixed field set, and an `x_`
 * escape hatch for extensions. The prose specification lives in
 * docs/schema.md; the machine-readable JSON Schema is in schema.ts and is
 * printed by `turnvert schema`.
 */

/** Harnesses turnvert ships a parser for. The `harness` field itself is an
 * open set so third-party producers can emit their own values. */
export type Harness = "claude-code" | "codex" | "aider" | "openhands";

export const HARNESSES: readonly Harness[] = ["claude-code", "codex", "aider", "openhands"];

/** The five normalized event kinds. */
export type EventKind = "session_start" | "message" | "tool_call" | "tool_result" | "note";

export const EVENT_KINDS: readonly EventKind[] = [
  "session_start",
  "message",
  "tool_call",
  "tool_result",
  "note",
];

/** Who a `message` event speaks as. */
export type Role = "user" | "assistant" | "system";

export const ROLES: readonly Role[] = ["user", "assistant", "system"];

/** Token accounting, normalized to four counters. All optional; absent means
 * the source log did not report that counter (never fabricated as 0). */
export interface Usage {
  /** Prompt / input tokens. */
  input?: number;
  /** Completion / output tokens. */
  output?: number;
  /** Tokens served from a prompt cache. */
  cache_read?: number;
  /** Tokens written into a prompt cache. */
  cache_write?: number;
}

/** Tool payload, shared by `tool_call` and `tool_result` events. */
export interface ToolInfo {
  /** Correlation id linking a call to its result, when the harness has one. */
  id?: string;
  /** Tool name as the harness reported it (required on `tool_call`). */
  name?: string;
  /** Parsed input arguments of a `tool_call`. */
  input?: unknown;
  /** Flattened text output of a `tool_result`. */
  output?: string;
  /** True when the harness marked the result as failed. */
  error?: boolean;
}

/** Provenance: where in the source log this event came from. */
export interface Provenance {
  /** Source file path as given on the command line. */
  file?: string;
  /** 1-based line number in the source file, when line-addressable. */
  line?: number;
  /** The harness-native id of the record (uuid, call_id, event id, …). */
  id?: string;
}

/** One normalized event — one line of turnvert JSONL output. */
export interface NormalEvent {
  /** Schema version. Always the literal 1 for this specification. */
  v: 1;
  /** 1-based position in the output stream; strictly increments by 1. */
  seq: number;
  /** Event kind. */
  event: EventKind;
  /** ISO-8601 timestamp as the source recorded it, or null when the source
   * has none. Naive local timestamps are passed through without a zone. */
  ts: string | null;
  /** Producing harness. Open set; turnvert emits the four known values. */
  harness: string;
  /** Session identifier; changes mid-stream when a file holds many sessions. */
  session: string;
  /** message only: who is speaking. */
  role?: Role;
  /** Model identifier, when the source log names one. */
  model?: string;
  /** Primary text: message body, note text. */
  text?: string;
  /** Reasoning / chain-of-thought text attached to assistant activity. */
  thinking?: string;
  /** tool_call / tool_result payload. */
  tool?: ToolInfo;
  /** Token accounting attached to the event that carried it in the source. */
  usage?: Usage;
  /** session_start only: string-valued harness metadata (cwd, version, …). */
  meta?: Record<string, string>;
  /** Provenance back-reference into the source log. */
  source?: Provenance;
  /** The untouched source record; emitted only with `--raw`. */
  raw?: unknown;
}

/** A parser-produced event before the orchestrator assigns `seq`. */
export type DraftEvent = Omit<NormalEvent, "seq">;

/** A non-fatal problem found while parsing a source log. */
export interface ParseWarning {
  /** 1-based source line, when the problem is line-addressable. */
  line?: number;
  message: string;
}

/** What every harness parser returns. */
export interface ParseResult {
  events: DraftEvent[];
  warnings: ParseWarning[];
}

/** Options shared by all harness parsers. */
export interface ParseOptions {
  /** Source file path, recorded into each event's provenance. */
  file?: string;
  /** Fallback session id when the log itself does not carry one. */
  sessionHint?: string;
  /** Attach the untouched source record to each event as `raw`. */
  includeRaw?: boolean;
}
