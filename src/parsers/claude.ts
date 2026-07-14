/**
 * Parser for Claude Code session logs
 * (`~/.claude/projects/<project>/<session-id>.jsonl`).
 *
 * Line shapes handled:
 *   - `{"type":"summary","summary":…}`             → note
 *   - `{"type":"user","message":{…}}`              → message (user) and/or
 *     tool_result events (tool results ride inside user-message content)
 *   - `{"type":"assistant","message":{…}}`         → message (assistant),
 *     thinking, and tool_call events
 *   - `{"type":"system",…}`                        → note (hook output,
 *     informational lines — harness housekeeping, not a model system prompt)
 *
 * Model and usage are attached to the FIRST event emitted from an assistant
 * API message, so summing `usage` over a stream never double-counts.
 */

import {
  asNumber,
  asString,
  isPlainObject,
  isoOrNull,
  pruneUsage,
  splitLines,
  tryParseJson,
} from "../jsonl.js";
import type {
  DraftEvent,
  ParseOptions,
  ParseResult,
  ParseWarning,
  Provenance,
  Usage,
} from "../types.js";

/** Flatten Claude content (string, or array of text/tool_result parts). */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (isPlainObject(item) && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function normalizeUsage(raw: unknown): Usage | undefined {
  if (!isPlainObject(raw)) return undefined;
  return pruneUsage({
    input: asNumber(raw.input_tokens),
    output: asNumber(raw.output_tokens),
    cache_read: asNumber(raw.cache_read_input_tokens),
    cache_write: asNumber(raw.cache_creation_input_tokens),
  });
}

interface LineCtx {
  ts: string | null;
  session: string;
  source: Provenance;
  raw?: unknown;
}

/** Parse one Claude Code JSONL session log. */
export function parseClaudeCode(text: string, opts: ParseOptions = {}): ParseResult {
  const events: DraftEvent[] = [];
  const warnings: ParseWarning[] = [];
  const lines = splitLines(text);
  const fallbackSession = opts.sessionHint ?? "claude-code-session";

  // Pass 1: harvest session metadata from the first line that carries it.
  // Summary lines written by later sessions sit at the top of the file, so
  // the metadata line is not necessarily line 1.
  let session = fallbackSession;
  const meta: Record<string, string> = {};
  let startTs: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const parsed = tryParseJson(line);
    if (!parsed.ok || !isPlainObject(parsed.value)) continue;
    const obj = parsed.value;
    const sid = asString(obj.sessionId);
    if (sid === undefined) continue;
    session = sid;
    startTs = isoOrNull(obj.timestamp);
    const cwd = asString(obj.cwd);
    const version = asString(obj.version);
    const branch = asString(obj.gitBranch);
    if (cwd !== undefined) meta.cwd = cwd;
    if (version !== undefined) meta.version = version;
    if (branch !== undefined) meta.branch = branch;
    break;
  }

  events.push({
    v: 1,
    event: "session_start",
    ts: startTs,
    harness: "claude-code",
    session,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    ...(opts.file !== undefined ? { source: { file: opts.file } } : {}),
  });

  // Pass 2: convert every line in order.
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const parsed = tryParseJson(line);
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      warnings.push({ line: lineNo, message: "invalid JSON, line skipped" });
      continue;
    }
    const obj = parsed.value;
    const ctx: LineCtx = {
      ts: isoOrNull(obj.timestamp),
      session: asString(obj.sessionId) ?? session,
      source: {
        ...(opts.file !== undefined ? { file: opts.file } : {}),
        line: lineNo,
        ...(asString(obj.uuid) !== undefined ? { id: asString(obj.uuid) } : {}),
      },
      ...(opts.includeRaw ? { raw: obj } : {}),
    };

    const type = obj.type;
    if (type === "summary") {
      const summary = asString(obj.summary);
      if (summary !== undefined) events.push(base(ctx, { event: "note", text: summary }));
      continue;
    }
    if (type === "user") {
      emitUserLine(obj, ctx, events);
      continue;
    }
    if (type === "assistant") {
      emitAssistantLine(obj, ctx, events);
      continue;
    }
    if (type === "system") {
      const content = flattenContent(obj.content);
      if (content !== "") events.push(base(ctx, { event: "note", text: content }));
      continue;
    }
    warnings.push({
      line: lineNo,
      message: `unhandled claude-code line type ${JSON.stringify(type)}, line skipped`,
    });
  }

  return { events, warnings };
}

function base(ctx: LineCtx, rest: Omit<DraftEvent, "v" | "ts" | "harness" | "session">): DraftEvent {
  return {
    v: 1,
    ts: ctx.ts,
    harness: "claude-code",
    session: ctx.session,
    ...rest,
    source: ctx.source,
    ...(ctx.raw !== undefined ? { raw: ctx.raw } : {}),
  };
}

function emitUserLine(obj: Record<string, unknown>, ctx: LineCtx, events: DraftEvent[]): void {
  const message = isPlainObject(obj.message) ? obj.message : {};
  const content = message.content;

  // Meta lines (caveats, command echoes) are harness housekeeping.
  if (obj.isMeta === true) {
    const text = flattenContent(content);
    if (text !== "") events.push(base(ctx, { event: "note", text }));
    return;
  }

  // Tool results arrive wrapped in user messages; unwrap each one.
  const textParts: string[] = [];
  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!isPlainObject(item)) continue;
      if (item.type === "tool_result") {
        const output = flattenContent(item.content);
        events.push(
          base(ctx, {
            event: "tool_result",
            tool: {
              ...(asString(item.tool_use_id) !== undefined ? { id: asString(item.tool_use_id) } : {}),
              output,
              error: item.is_error === true,
            },
          })
        );
      } else if (item.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
      }
    }
  }
  const text = textParts.join("\n");
  if (text !== "") events.push(base(ctx, { event: "message", role: "user", text }));
}

function emitAssistantLine(obj: Record<string, unknown>, ctx: LineCtx, events: DraftEvent[]): void {
  const message = isPlainObject(obj.message) ? obj.message : {};
  const model = asString(message.model);
  const usage = normalizeUsage(message.usage);
  const content = Array.isArray(message.content) ? message.content : [];

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: DraftEvent[] = [];
  for (const item of content) {
    if (!isPlainObject(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      thinkingParts.push(item.thinking);
    } else if (item.type === "tool_use") {
      toolCalls.push(
        base(ctx, {
          event: "tool_call",
          tool: {
            ...(asString(item.id) !== undefined ? { id: asString(item.id) } : {}),
            name: asString(item.name) ?? "unknown",
            ...(item.input !== undefined ? { input: item.input } : {}),
          },
        })
      );
    }
  }

  const emitted: DraftEvent[] = [];
  const text = textParts.join("\n");
  const thinking = thinkingParts.join("\n");
  if (text !== "" || thinking !== "") {
    emitted.push(
      base(ctx, {
        event: "message",
        role: "assistant",
        ...(text !== "" ? { text } : {}),
        ...(thinking !== "" ? { thinking } : {}),
      })
    );
  }
  emitted.push(...toolCalls);

  // Model and usage describe the whole API response; pin them to the first
  // event so aggregation over the stream counts each response once.
  const first = emitted[0];
  if (first !== undefined) {
    if (model !== undefined) first.model = model;
    if (usage !== undefined) first.usage = usage;
  }
  events.push(...emitted);
}
