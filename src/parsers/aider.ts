/**
 * Parser for Aider chat histories (`.aider.chat.history.md`).
 *
 * Aider logs Markdown, not JSON, and appends every run to the same file, so
 * one file usually holds many sessions:
 *
 *   `# aider chat started at <ts>`  → session_start (headers `>` lines fold
 *                                     into meta: version, model, edit format)
 *   `#### <text>`                   → user message (consecutive lines join)
 *   plain text                      → assistant message
 *   `> <text>`                      → note (edits applied, commits, token
 *                                     reports — with `Tokens: … sent, …
 *                                     received` parsed into `usage`)
 *
 * Only the session banner is timestamped; every other event has `ts: null`,
 * because Aider does not record per-turn times. Fenced code blocks inside
 * assistant replies are honored: a `####` or `>` line inside a fence is
 * body text, not a new block.
 */

import { splitLines } from "../jsonl.js";
import type { DraftEvent, ParseOptions, ParseResult, ParseWarning, Usage } from "../types.js";

const BANNER = /^# aider chat started at (.+?)\s*$/;
const MODEL_LINE = /^(?:Main model|Model):\s*(\S+)(?:\s+with\s+(\S+)\s+edit format)?/;
const VERSION_LINE = /^Aider v(\S+)/;
const GIT_LINE = /^Git repo:\s*(.+)$/;
/** `Tokens: 2.4k sent, 350 received.` — also older comma-grouped integers. */
const TOKENS_LINE = /Tokens:\s*([\d,.]+k?)\s+sent(?:.*?([\d,.]+k?)\s+received)?/i;

/** Parse aider's human-formatted token counts: "2.4k" → 2400, "12,438" → 12438. */
export function parseTokenCount(text: string): number | undefined {
  const cleaned = text.replace(/,/g, "");
  const m = /^(\d+(?:\.\d+)?)(k?)$/i.exec(cleaned);
  if (m === null) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2] !== "" ? Math.round(n * 1000) : n;
}

function usageFromNote(text: string): Usage | undefined {
  const m = TOKENS_LINE.exec(text);
  if (m === null) return undefined;
  const input = m[1] !== undefined ? parseTokenCount(m[1]) : undefined;
  const output = m[2] !== undefined ? parseTokenCount(m[2]) : undefined;
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

/** `2026-07-05 09:14:47` → `2026-07-05T09:14:47` (naive local time kept naive). */
function normalizeBannerTs(raw: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw.trim());
  return m !== null ? `${m[1]}T${m[2]}` : null;
}

interface AiderState {
  events: DraftEvent[];
  warnings: ParseWarning[];
  opts: ParseOptions;
  session: string;
  sessionCount: number;
  model?: string;
  /** Buffered session_start, emitted before the first non-header event. */
  pendingStart?: DraftEvent;
  /** Header `>` lines not folded into meta; flushed right after the start. */
  pendingHeaderNotes: DraftEvent[];
  inHeader: boolean;
  /** Current accumulation block. */
  block?: { kind: "user" | "assistant"; lines: string[]; startLine: number };
  inFence: boolean;
}

/** Parse one Aider Markdown chat history (possibly many sessions). */
export function parseAider(text: string, opts: ParseOptions = {}): ParseResult {
  const state: AiderState = {
    events: [],
    warnings: [],
    opts,
    session: opts.sessionHint ?? "aider-session",
    sessionCount: 0,
    pendingHeaderNotes: [],
    inHeader: false,
    inFence: false,
  };

  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? "";

    // Inside a fenced code block, everything belongs to the assistant text
    // — including lines that would otherwise start a user block or a note.
    if (state.inFence && state.block?.kind === "assistant") {
      state.block.lines.push(line);
      if (/^\s*```/.test(line)) state.inFence = false;
      continue;
    }

    const banner = BANNER.exec(line);
    if (banner !== null && banner[1] !== undefined) {
      startSession(state, banner[1], lineNo);
      continue;
    }

    if (line.startsWith("####")) {
      flushIfKind(state, "assistant");
      const content = line === "####" ? "" : line.replace(/^####\s?/, "");
      if (state.block?.kind === "user") state.block.lines.push(content);
      else state.block = { kind: "user", lines: [content], startLine: lineNo };
      continue;
    }

    if (line.startsWith(">")) {
      flushBlock(state);
      const content = line.replace(/^>\s?/, "").trimEnd();
      if (content === "") continue;
      handleNoteLine(state, content, lineNo);
      continue;
    }

    if (line.trim() === "") {
      // Blank lines end a user block; assistant blocks may span them, so
      // keep accumulating and trim trailing blanks at flush time.
      if (state.block?.kind === "user") flushBlock(state);
      else if (state.block?.kind === "assistant") state.block.lines.push(line);
      continue;
    }

    // Any other content line is assistant output.
    flushIfKind(state, "user");
    if (state.block?.kind === "assistant") state.block.lines.push(line);
    else state.block = { kind: "assistant", lines: [line], startLine: lineNo };
    if (/^\s*```/.test(line) && !/^\s*```.*```\s*$/.test(line)) state.inFence = true;
    state.inHeader = false;
    emitPendingStart(state);
  }

  flushBlock(state);
  emitPendingStart(state); // a header-only session still gets its start event
  return { events: state.events, warnings: state.warnings };
}

function sourceOf(state: AiderState, lineNo: number): DraftEvent["source"] {
  return {
    ...(state.opts.file !== undefined ? { file: state.opts.file } : {}),
    line: lineNo,
  };
}

function startSession(state: AiderState, tsRaw: string, lineNo: number): void {
  flushBlock(state);
  emitPendingStart(state);
  const ts = normalizeBannerTs(tsRaw);
  state.sessionCount += 1;
  state.session = ts !== null ? `aider-${ts}` : `${state.opts.sessionHint ?? "aider"}-${state.sessionCount}`;
  state.model = undefined;
  state.inHeader = true;
  state.pendingHeaderNotes = [];
  state.pendingStart = {
    v: 1,
    event: "session_start",
    ts,
    harness: "aider",
    session: state.session,
    source: sourceOf(state, lineNo),
  };
}

/** Emit the buffered session_start (plus buffered header notes), once. */
function emitPendingStart(state: AiderState): void {
  if (state.pendingStart === undefined) return;
  state.events.push(state.pendingStart);
  state.pendingStart = undefined;
  state.events.push(...state.pendingHeaderNotes);
  state.pendingHeaderNotes = [];
}

function handleNoteLine(state: AiderState, content: string, lineNo: number): void {
  // While still in the session header, recognized lines fold into
  // session_start metadata instead of becoming standalone notes.
  if (state.inHeader && state.pendingStart !== undefined) {
    const version = VERSION_LINE.exec(content);
    if (version !== null && version[1] !== undefined) {
      setMeta(state.pendingStart, "version", version[1]);
      return;
    }
    const model = MODEL_LINE.exec(content);
    if (model !== null && model[1] !== undefined) {
      state.model = model[1];
      setMeta(state.pendingStart, "model", model[1]);
      if (model[2] !== undefined) setMeta(state.pendingStart, "edit_format", model[2]);
      return;
    }
    const git = GIT_LINE.exec(content);
    if (git !== null && git[1] !== undefined) {
      setMeta(state.pendingStart, "git_repo", git[1]);
      return;
    }
    // Unrecognized header chatter (command line, repo-map, …) is preserved
    // as notes emitted right after the session_start.
    state.pendingHeaderNotes.push(makeNote(state, content, lineNo));
    return;
  }

  emitPendingStart(state);
  state.events.push(makeNote(state, content, lineNo));
}

function makeNote(state: AiderState, content: string, lineNo: number): DraftEvent {
  const usage = usageFromNote(content);
  return {
    v: 1,
    event: "note",
    ts: null,
    harness: "aider",
    session: state.session,
    text: content,
    ...(usage !== undefined ? { usage } : {}),
    source: sourceOf(state, lineNo),
  };
}

function setMeta(start: DraftEvent, key: string, value: string): void {
  if (start.meta === undefined) start.meta = {};
  start.meta[key] = value;
}

function flushIfKind(state: AiderState, kind: "user" | "assistant"): void {
  if (state.block?.kind === kind) flushBlock(state);
}

function flushBlock(state: AiderState): void {
  const block = state.block;
  state.block = undefined;
  state.inFence = false;
  if (block === undefined) return;
  const text = block.lines.join("\n").replace(/\s+$/, "");
  if (text === "") return;
  state.inHeader = false;
  emitPendingStart(state);
  state.events.push({
    v: 1,
    event: "message",
    ts: null,
    harness: "aider",
    session: state.session,
    role: block.kind === "user" ? "user" : "assistant",
    ...(block.kind === "assistant" && state.model !== undefined ? { model: state.model } : {}),
    text,
    source: sourceOf(state, block.startLine),
  });
}
