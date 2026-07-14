/**
 * Parser for Codex CLI rollout files
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`).
 *
 * Every line is `{"timestamp":…,"type":…,"payload":{…}}`:
 *   - `session_meta`   → session_start (+ a system message when the rollout
 *     records non-empty `instructions`)
 *   - `turn_context`   → consumed: updates the current model, emits nothing
 *   - `response_item`  → messages, reasoning, function/shell tool calls and
 *     their outputs
 *   - `event_msg`      → UI chatter; used for two things only: token counts
 *     (patched onto the most recent assistant event) and de-duplicated
 *     user/agent message fallbacks for rollouts that lack response_items
 *
 * Reasoning items precede the assistant activity they belong to, so the
 * parser buffers them and attaches `thinking` to the next assistant message
 * or tool call.
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
  Usage,
} from "../types.js";

/** User-message payloads Codex injects around real prompts. */
const CONTEXT_WRAPPERS = ["<user_instructions>", "<environment_context>", "<turn_context>"];

function flattenItems(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (isPlainObject(item) && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function usageFromTokenCount(payload: Record<string, unknown>): Usage | undefined {
  // Two vintages: `payload.info.last_token_usage.{…}` and flat `payload.{…}`.
  let src: Record<string, unknown> = payload;
  if (isPlainObject(payload.info)) {
    const info = payload.info;
    if (isPlainObject(info.last_token_usage)) src = info.last_token_usage;
    else if (isPlainObject(info.total_token_usage)) src = info.total_token_usage;
  }
  return pruneUsage({
    input: asNumber(src.input_tokens),
    output: asNumber(src.output_tokens),
    cache_read: asNumber(src.cached_input_tokens),
  });
}

interface CodexState {
  session: string;
  model?: string;
  /** Reasoning text waiting to be attached to the next assistant event. */
  pendingThinking: string[];
  events: DraftEvent[];
  warnings: ParseWarning[];
  opts: ParseOptions;
}

/** Parse one Codex CLI rollout file. */
export function parseCodex(text: string, opts: ParseOptions = {}): ParseResult {
  const state: CodexState = {
    session: opts.sessionHint ?? "codex-session",
    pendingThinking: [],
    events: [],
    warnings: [],
    opts,
  };
  const lines = splitLines(text);
  let sawSessionStart = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const parsed = tryParseJson(line);
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      state.warnings.push({ line: lineNo, message: "invalid JSON, line skipped" });
      continue;
    }
    const obj = parsed.value;
    const ts = isoOrNull(obj.timestamp);
    const payload = isPlainObject(obj.payload) ? obj.payload : {};
    const type = obj.type;

    if (type === "session_meta") {
      handleSessionMeta(state, payload, ts, lineNo, obj);
      sawSessionStart = true;
    } else if (type === "turn_context") {
      const model = asString(payload.model);
      if (model !== undefined) state.model = model;
    } else if (type === "response_item") {
      if (!sawSessionStart) {
        // Defensive: rollouts should open with session_meta, but truncated
        // copies exist in the wild. Synthesize a bare session_start.
        pushSessionStart(state, null, undefined, lineNo, undefined);
        sawSessionStart = true;
      }
      handleResponseItem(state, payload, ts, lineNo, obj);
    } else if (type === "event_msg") {
      handleEventMsg(state, payload, ts, lineNo, obj);
    } else if (type === "compacted") {
      state.events.push(
        draft(state, {
          event: "note",
          ts,
          text: asString(payload.message) ?? "history compacted",
          source: sourceOf(state, lineNo, undefined),
          ...(state.opts.includeRaw ? { raw: obj } : {}),
        })
      );
    } else {
      state.warnings.push({
        line: lineNo,
        message: `unhandled codex line type ${JSON.stringify(type)}, line skipped`,
      });
    }
  }

  // Reasoning with no assistant activity after it still deserves an event.
  flushThinkingAsMessage(state, null);
  return { events: state.events, warnings: state.warnings };
}

function sourceOf(
  state: CodexState,
  lineNo: number,
  id: string | undefined
): DraftEvent["source"] {
  return {
    ...(state.opts.file !== undefined ? { file: state.opts.file } : {}),
    line: lineNo,
    ...(id !== undefined ? { id } : {}),
  };
}

function draft(state: CodexState, rest: Omit<DraftEvent, "v" | "harness" | "session">): DraftEvent {
  return { v: 1, harness: "codex", session: state.session, ...rest };
}

function takeThinking(state: CodexState): string | undefined {
  if (state.pendingThinking.length === 0) return undefined;
  const joined = state.pendingThinking.join("\n");
  state.pendingThinking = [];
  return joined;
}

function flushThinkingAsMessage(state: CodexState, ts: string | null): void {
  const thinking = takeThinking(state);
  if (thinking === undefined) return;
  state.events.push(
    draft(state, {
      event: "message",
      ts,
      role: "assistant",
      thinking,
      ...(state.model !== undefined ? { model: state.model } : {}),
    })
  );
}

function handleSessionMeta(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string | null,
  lineNo: number,
  raw: unknown
): void {
  const id = asString(payload.id);
  if (id !== undefined) state.session = id;
  const meta: Record<string, string> = {};
  const cwd = asString(payload.cwd);
  const version = asString(payload.cli_version);
  const originator = asString(payload.originator);
  if (cwd !== undefined) meta.cwd = cwd;
  if (version !== undefined) meta.version = version;
  if (originator !== undefined) meta.originator = originator;
  if (isPlainObject(payload.git)) {
    const branch = asString(payload.git.branch);
    if (branch !== undefined) meta.branch = branch;
  }
  pushSessionStart(state, ts, meta, lineNo, state.opts.includeRaw ? raw : undefined);

  const instructions = asString(payload.instructions);
  if (instructions !== undefined) {
    state.events.push(
      draft(state, {
        event: "message",
        ts,
        role: "system",
        text: instructions,
        source: sourceOf(state, lineNo, undefined),
      })
    );
  }
}

function pushSessionStart(
  state: CodexState,
  ts: string | null,
  meta: Record<string, string> | undefined,
  lineNo: number,
  raw: unknown
): void {
  state.events.push(
    draft(state, {
      event: "session_start",
      ts,
      ...(meta !== undefined && Object.keys(meta).length > 0 ? { meta } : {}),
      source: sourceOf(state, lineNo, undefined),
      ...(raw !== undefined ? { raw } : {}),
    })
  );
}

function parseArguments(argsRaw: unknown): unknown {
  if (typeof argsRaw !== "string") return argsRaw;
  const parsed = tryParseJson(argsRaw);
  // Preserve unparseable argument strings instead of dropping them.
  return parsed.ok ? parsed.value : { _raw: argsRaw };
}

function parseFunctionOutput(outputRaw: unknown): { output: string; error: boolean } {
  if (isPlainObject(outputRaw)) {
    // Newer rollouts: {"content": "...", "success": true}
    const content = typeof outputRaw.content === "string" ? outputRaw.content : JSON.stringify(outputRaw);
    return { output: content, error: outputRaw.success === false };
  }
  if (typeof outputRaw !== "string") return { output: "", error: false };
  // Shell outputs are often a JSON string {"output": "...", "metadata": {"exit_code": N}}.
  const parsed = tryParseJson(outputRaw);
  if (parsed.ok && isPlainObject(parsed.value)) {
    const obj = parsed.value;
    const output = typeof obj.output === "string" ? obj.output : outputRaw;
    let error = false;
    if (isPlainObject(obj.metadata)) {
      const code = asNumber(obj.metadata.exit_code);
      if (code !== undefined && code !== 0) error = true;
    }
    return { output, error };
  }
  return { output: outputRaw, error: false };
}

function handleResponseItem(
  state: CodexState,
  item: Record<string, unknown>,
  ts: string | null,
  lineNo: number,
  raw: unknown
): void {
  const rawField = state.opts.includeRaw ? { raw } : {};
  const itemType = item.type;

  if (itemType === "message") {
    const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
    const text = flattenItems(item.content);
    if (text === "") return;
    // Codex wraps project docs and environment state in pseudo-user
    // messages; those are context plumbing, not something a person typed.
    if (role === "user" && CONTEXT_WRAPPERS.some((w) => text.startsWith(w))) {
      state.events.push(
        draft(state, { event: "note", ts, text, source: sourceOf(state, lineNo, undefined), ...rawField })
      );
      return;
    }
    const thinking = role === "assistant" ? takeThinking(state) : undefined;
    state.events.push(
      draft(state, {
        event: "message",
        ts,
        role,
        text,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(role === "assistant" && state.model !== undefined ? { model: state.model } : {}),
        source: sourceOf(state, lineNo, asString(item.id)),
        ...rawField,
      })
    );
    return;
  }

  if (itemType === "reasoning") {
    const summary = flattenItems(item.summary);
    const content = flattenItems(item.content);
    const textParts = [summary, content].filter((s) => s !== "");
    if (textParts.length > 0) state.pendingThinking.push(textParts.join("\n"));
    return;
  }

  if (itemType === "function_call" || itemType === "custom_tool_call") {
    const thinking = takeThinking(state);
    const argsSource = itemType === "function_call" ? item.arguments : item.input;
    state.events.push(
      draft(state, {
        event: "tool_call",
        ts,
        ...(thinking !== undefined ? { thinking } : {}),
        tool: {
          ...(asString(item.call_id) !== undefined ? { id: asString(item.call_id) } : {}),
          name: asString(item.name) ?? "unknown",
          ...(argsSource !== undefined ? { input: parseArguments(argsSource) } : {}),
        },
        source: sourceOf(state, lineNo, asString(item.call_id)),
        ...rawField,
      })
    );
    return;
  }

  if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
    const { output, error } = parseFunctionOutput(item.output);
    state.events.push(
      draft(state, {
        event: "tool_result",
        ts,
        tool: {
          ...(asString(item.call_id) !== undefined ? { id: asString(item.call_id) } : {}),
          output,
          error,
        },
        source: sourceOf(state, lineNo, asString(item.call_id)),
        ...rawField,
      })
    );
    return;
  }

  if (itemType === "local_shell_call") {
    const thinking = takeThinking(state);
    const action = isPlainObject(item.action) ? item.action : {};
    state.events.push(
      draft(state, {
        event: "tool_call",
        ts,
        ...(thinking !== undefined ? { thinking } : {}),
        tool: {
          ...(asString(item.call_id) !== undefined ? { id: asString(item.call_id) } : {}),
          name: "local_shell",
          input: { command: action.command },
        },
        source: sourceOf(state, lineNo, asString(item.call_id)),
        ...rawField,
      })
    );
    return;
  }

  if (itemType === "web_search_call") {
    const action = isPlainObject(item.action) ? item.action : {};
    state.events.push(
      draft(state, {
        event: "tool_call",
        ts,
        tool: {
          ...(asString(item.id) !== undefined ? { id: asString(item.id) } : {}),
          name: "web_search",
          ...(action.query !== undefined ? { input: { query: action.query } } : {}),
        },
        source: sourceOf(state, lineNo, asString(item.id)),
        ...rawField,
      })
    );
    return;
  }

  state.warnings.push({
    line: lineNo,
    message: `unhandled codex response_item type ${JSON.stringify(itemType)}, line skipped`,
  });
}

/** Is `e` an event that an assistant token count can describe? */
function isAssistantActivity(e: DraftEvent): boolean {
  return (e.event === "message" && e.role === "assistant") || e.event === "tool_call";
}

function handleEventMsg(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string | null,
  lineNo: number,
  raw: unknown
): void {
  const type = payload.type;

  if (type === "token_count") {
    const usage = usageFromTokenCount(payload);
    if (usage === undefined) return;
    // Patch onto the most recent assistant event that has no usage yet;
    // fall back to a standalone note so the numbers are never dropped.
    for (let i = state.events.length - 1; i >= 0; i--) {
      const e = state.events[i];
      if (e !== undefined && isAssistantActivity(e) && e.usage === undefined) {
        e.usage = usage;
        return;
      }
    }
    state.events.push(
      draft(state, {
        event: "note",
        ts,
        text: "token count",
        usage,
        source: sourceOf(state, lineNo, undefined),
        ...(state.opts.includeRaw ? { raw } : {}),
      })
    );
    return;
  }

  if (type === "user_message" || type === "agent_message") {
    const text = asString(payload.message);
    if (text === undefined) return;
    const role = type === "user_message" ? "user" : "assistant";
    // Rollouts that carry response_items already produced this message;
    // only emit when the immediately preceding events do not contain it.
    for (let i = state.events.length - 1; i >= 0 && i >= state.events.length - 4; i--) {
      const e = state.events[i];
      if (e !== undefined && e.event === "message" && e.role === role && e.text === text) return;
    }
    state.events.push(
      draft(state, {
        event: "message",
        ts,
        role,
        text,
        ...(role === "assistant" && state.model !== undefined ? { model: state.model } : {}),
        source: sourceOf(state, lineNo, undefined),
        ...(state.opts.includeRaw ? { raw } : {}),
      })
    );
    return;
  }

  if (type === "agent_reasoning") {
    const text = asString(payload.text);
    if (text !== undefined && !state.pendingThinking.includes(text)) {
      state.pendingThinking.push(text);
    }
    return;
  }

  // Everything else (task_started, turn_diff, exec begin/end echoes, …) is
  // UI chatter duplicated from response_items; ignore silently by design.
}
