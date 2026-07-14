/**
 * Conversion orchestrator: reads inputs, picks a parser (auto-detection or
 * a forced harness), merges multi-file runs into one stream, and assigns
 * the final strictly-increasing `seq` numbers.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { detectHarness } from "./detect.js";
import { tryParseJson } from "./jsonl.js";
import { parseAider } from "./parsers/aider.js";
import { parseClaudeCode } from "./parsers/claude.js";
import { parseCodex } from "./parsers/codex.js";
import { parseOpenHands, parseOpenHandsEvents } from "./parsers/openhands.js";
import type {
  DraftEvent,
  Harness,
  NormalEvent,
  ParseOptions,
  ParseResult,
  ParseWarning,
} from "./types.js";

export interface ConvertOptions {
  /** Force a harness instead of auto-detecting. */
  harness?: Harness | "auto";
  /** Attach the untouched source records as `raw`. */
  includeRaw?: boolean;
}

export interface ConvertRunWarning extends ParseWarning {
  /** Which input the warning came from. */
  file?: string;
}

export interface ConvertRun {
  events: NormalEvent[];
  warnings: ConvertRunWarning[];
  /** Inputs that could not be read or detected at all (fatal per-file). */
  failures: { file: string; message: string }[];
}

/** Dispatch text to the right parser. Exposed for library users. */
export function convertText(text: string, harness: Harness, opts: ParseOptions = {}): ParseResult {
  switch (harness) {
    case "claude-code":
      return parseClaudeCode(text, opts);
    case "codex":
      return parseCodex(text, opts);
    case "aider":
      return parseAider(text, opts);
    case "openhands":
      return parseOpenHands(text, opts);
  }
}

/** Session-id fallback derived from the input path. */
function hintFromPath(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  const stem = ext !== "" ? base.slice(0, -ext.length) : base;
  return stem !== "" ? stem : base;
}

/** Numeric-aware sort for OpenHands `events/` directories (2.json < 10.json). */
export function sortEventFiles(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const na = Number.parseInt(a, 10);
    const nb = Number.parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function convertDirectory(path: string, opts: ConvertOptions): ParseResult {
  // A directory input is the OpenHands per-event layout: events/<id>.json.
  const names = sortEventFiles(readdirSync(path).filter((n) => n.endsWith(".json")));
  const records: unknown[] = [];
  const warnings: ParseWarning[] = [];
  for (const name of names) {
    const parsed = tryParseJson(readFileSync(join(path, name), "utf8"));
    if (!parsed.ok) {
      warnings.push({ message: `${name}: invalid JSON, file skipped` });
      continue;
    }
    records.push(parsed.value);
  }
  const result = parseOpenHandsEvents(records, {
    file: path,
    sessionHint: hintFromPath(path),
    includeRaw: opts.includeRaw ?? false,
  });
  return { events: result.events, warnings: [...warnings, ...result.warnings] };
}

/** Convert one path (file or OpenHands events directory). */
export function convertPath(
  path: string,
  opts: ConvertOptions = {}
): { result?: ParseResult; harness?: Harness; error?: string } {
  if (!existsSync(path)) return { error: "no such file or directory" };

  if (statSync(path).isDirectory()) {
    const forced = opts.harness ?? "auto";
    if (forced !== "auto" && forced !== "openhands") {
      return { error: `directory input is only supported for openhands, not ${forced}` };
    }
    return { result: convertDirectory(path, opts), harness: "openhands" };
  }

  const text = readFileSync(path, "utf8");
  const harness =
    opts.harness !== undefined && opts.harness !== "auto"
      ? opts.harness
      : detectHarness(text, path);
  if (harness === null) {
    return { error: "could not detect harness (use --harness to force one)" };
  }
  const result = convertText(text, harness, {
    file: path,
    sessionHint: hintFromPath(path),
    includeRaw: opts.includeRaw ?? false,
  });
  return { result, harness };
}

/** Assign `seq` 1..N to a stream of drafts, in order. */
export function sequenceEvents(drafts: DraftEvent[]): NormalEvent[] {
  return drafts.map((draft, i) => ({ ...draft, seq: i + 1 }));
}

/** Convert many inputs into one normalized stream with a single `seq` run. */
export function convertPaths(paths: string[], opts: ConvertOptions = {}): ConvertRun {
  const drafts: DraftEvent[] = [];
  const warnings: ConvertRunWarning[] = [];
  const failures: { file: string; message: string }[] = [];

  for (const path of paths) {
    const { result, error } = convertPath(path, opts);
    if (error !== undefined || result === undefined) {
      failures.push({ file: path, message: error ?? "unknown error" });
      continue;
    }
    drafts.push(...result.events);
    warnings.push(...result.warnings.map((w) => ({ ...w, file: path })));
  }

  return { events: sequenceEvents(drafts), warnings, failures };
}
