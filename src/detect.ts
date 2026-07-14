/**
 * Harness auto-detection. Detection is content-first: the file's own
 * structure decides, and the filename only breaks ties. This means renamed
 * or copied logs still detect correctly, and a `.jsonl` extension alone
 * never misleads.
 */

import { isPlainObject, splitLines, tryParseJson } from "./jsonl.js";
import type { Harness } from "./types.js";

const CODEX_LINE_TYPES = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
  "compacted",
]);

const CLAUDE_LINE_TYPES = new Set(["summary", "user", "assistant", "system", "progress"]);

/** How many non-empty lines to inspect before giving up. */
const SCAN_LIMIT = 50;

function looksLikeOpenHandsEvent(obj: Record<string, unknown>): boolean {
  const hasBody = "action" in obj || "observation" in obj;
  const hasEnvelope = "id" in obj || "source" in obj || "cause" in obj;
  return hasBody && hasEnvelope;
}

function classifyJsonLine(obj: Record<string, unknown>): Harness | null {
  const type = obj.type;
  if (typeof type === "string" && CODEX_LINE_TYPES.has(type) && "payload" in obj) {
    return "codex";
  }
  if (
    typeof type === "string" &&
    CLAUDE_LINE_TYPES.has(type) &&
    ("uuid" in obj || "sessionId" in obj || "message" in obj || "leafUuid" in obj)
  ) {
    return "claude-code";
  }
  if (looksLikeOpenHandsEvent(obj)) return "openhands";
  return null;
}

/**
 * Detect which harness produced `text`. Returns null when nothing matches;
 * callers decide whether that is an error (`convert`) or a report line
 * (`detect`).
 */
export function detectHarness(text: string, filename?: string): Harness | null {
  const trimmed = text.trimStart();

  // Aider chat histories are Markdown with a fixed opening banner.
  if (trimmed.startsWith("# aider chat started at ")) return "aider";

  // A whole-file JSON array is the OpenHands event-list export shape.
  if (trimmed.startsWith("[")) {
    const parsed = tryParseJson(text);
    if (parsed.ok && Array.isArray(parsed.value)) {
      const first = parsed.value.find((item) => isPlainObject(item));
      if (isPlainObject(first) && looksLikeOpenHandsEvent(first)) return "openhands";
    }
    return null;
  }

  // JSONL: classify the first few parseable lines.
  let scanned = 0;
  for (const line of splitLines(text)) {
    if (line.trim() === "") continue;
    if (++scanned > SCAN_LIMIT) break;
    const parsed = tryParseJson(line);
    if (!parsed.ok || !isPlainObject(parsed.value)) continue;
    const hit = classifyJsonLine(parsed.value);
    if (hit !== null) return hit;
  }

  // Filename hints, only as a last resort.
  if (filename !== undefined) {
    const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
    if (base.includes(".aider.chat.history")) return "aider";
    if (/^rollout-.*\.jsonl$/.test(base)) return "codex";
  }

  return null;
}
