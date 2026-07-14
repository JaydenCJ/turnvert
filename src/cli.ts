#!/usr/bin/env node
/**
 * The `turnvert` command-line interface.
 *
 * Exit codes (stable API):
 *   0  success
 *   1  findings — validation errors, undetectable/unreadable inputs, or
 *      warnings under `convert --strict`
 *   2  usage or I/O errors (unknown command/flag, missing file for validate)
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { convertPaths } from "./convert.js";
import { detectHarness } from "./detect.js";
import { ArgError, parseArgs } from "./cliargs.js";
import { isPlainObject, serializeEvent, splitLines, tryParseJson } from "./jsonl.js";
import { renderSchema } from "./schema.js";
import { computeStats, renderStatsTable } from "./stats.js";
import { HARNESSES } from "./types.js";
import type { Harness, NormalEvent } from "./types.js";
import { validateJsonl } from "./validate.js";
import { VERSION } from "./version.js";

const USAGE = `turnvert ${VERSION} — normalize agent session logs into one JSONL schema

Usage:
  turnvert convert <path>... [--harness <name>] [--out <file>] [--raw] [--strict]
  turnvert detect <path>...
  turnvert stats <path>... [--harness <name>] [--format text|json]
  turnvert validate <file.jsonl>
  turnvert schema
  turnvert --version | --help

Commands:
  convert    Convert session logs to normalized JSONL (stdout or --out)
  detect     Report which harness wrote each input
  stats      Per-session summary of converted or already-normalized logs
  validate   Check a normalized JSONL file against the schema
  schema     Print the JSON Schema for one normalized event

Harnesses: ${HARNESSES.join(", ")} (default: auto-detect)
Directories are treated as OpenHands events/ folders of <id>.json files.`;

function fail(message: string, code: number): number {
  process.stderr.write(`turnvert: ${message}\n`);
  return code;
}

function parseHarnessFlag(value: string | boolean | undefined): Harness | "auto" | null {
  if (value === undefined) return "auto";
  if (typeof value !== "string") return null;
  if (value === "auto" || (HARNESSES as readonly string[]).includes(value)) {
    return value as Harness | "auto";
  }
  return null;
}

function cmdConvert(paths: string[], flags: Record<string, string | boolean>): number {
  if (paths.length === 0) return fail("convert needs at least one input path", 2);
  const harness = parseHarnessFlag(flags.harness);
  if (harness === null) {
    return fail(`--harness must be auto or one of: ${HARNESSES.join(", ")}`, 2);
  }

  const run = convertPaths(paths, { harness, includeRaw: flags.raw === true });
  for (const w of run.warnings) {
    const where = w.line !== undefined ? `${w.file ?? "?"}:${w.line}` : (w.file ?? "?");
    process.stderr.write(`turnvert: warning: ${where}: ${w.message}\n`);
  }
  for (const f of run.failures) {
    process.stderr.write(`turnvert: error: ${f.file}: ${f.message}\n`);
  }

  const output = run.events.map((e) => serializeEvent(e)).join("\n");
  const body = output === "" ? "" : `${output}\n`;
  const out = flags.out;
  if (typeof out === "string") writeFileSync(out, body, "utf8");
  else process.stdout.write(body);

  if (run.failures.length > 0) return 1;
  if (flags.strict === true && run.warnings.length > 0) {
    return fail(`--strict: ${run.warnings.length} warning(s) treated as errors`, 1);
  }
  return 0;
}

function cmdDetect(paths: string[]): number {
  if (paths.length === 0) return fail("detect needs at least one input path", 2);
  let unknown = 0;
  for (const path of paths) {
    if (!existsSync(path)) {
      console.log(`${path}\terror: no such file or directory`);
      unknown += 1;
      continue;
    }
    if (statSync(path).isDirectory()) {
      console.log(`${path}\topenhands`);
      continue;
    }
    const harness = detectHarness(readFileSync(path, "utf8"), path);
    console.log(`${path}\t${harness ?? "unknown"}`);
    if (harness === null) unknown += 1;
  }
  return unknown > 0 ? 1 : 0;
}

/** Is this text already normalized turnvert JSONL? */
function looksNormalized(text: string): boolean {
  for (const line of splitLines(text)) {
    if (line.trim() === "") continue;
    const parsed = tryParseJson(line);
    return (
      parsed.ok &&
      isPlainObject(parsed.value) &&
      parsed.value.v === 1 &&
      "seq" in parsed.value &&
      "event" in parsed.value
    );
  }
  return false;
}

function cmdStats(paths: string[], flags: Record<string, string | boolean>): number {
  if (paths.length === 0) return fail("stats needs at least one input path", 2);
  const format = flags.format ?? "text";
  if (format !== "text" && format !== "json") return fail(`--format must be text or json`, 2);
  const harness = parseHarnessFlag(flags.harness);
  if (harness === null) {
    return fail(`--harness must be auto or one of: ${HARNESSES.join(", ")}`, 2);
  }

  // Already-normalized JSONL files are consumed directly, so `stats` also
  // works on the output of other turnvert-schema producers.
  const events: NormalEvent[] = [];
  const rawPaths: string[] = [];
  for (const path of paths) {
    if (existsSync(path) && !statSync(path).isDirectory()) {
      const text = readFileSync(path, "utf8");
      if (looksNormalized(text)) {
        for (const line of splitLines(text)) {
          if (line.trim() === "") continue;
          const parsed = tryParseJson(line);
          if (parsed.ok && isPlainObject(parsed.value)) {
            events.push(parsed.value as unknown as NormalEvent);
          }
        }
        continue;
      }
    }
    rawPaths.push(path);
  }

  if (rawPaths.length > 0) {
    const run = convertPaths(rawPaths, { harness });
    for (const f of run.failures) {
      return fail(`${f.file}: ${f.message}`, 1);
    }
    events.push(...run.events);
  }

  const stats = computeStats(events);
  if (format === "json") console.log(JSON.stringify(stats, null, 2));
  else console.log(renderStatsTable(stats));
  return 0;
}

function cmdValidate(paths: string[]): number {
  if (paths.length !== 1) return fail("validate takes exactly one JSONL file", 2);
  const path = paths[0] ?? "";
  if (!existsSync(path) || statSync(path).isDirectory()) {
    return fail(`${path}: no such file`, 2);
  }
  const report = validateJsonl(readFileSync(path, "utf8"));
  for (const e of report.errors) {
    console.log(`${path}:${e.line}: ${e.message}`);
  }
  if (report.errors.length > 0) {
    console.log(`INVALID: ${report.errors.length} error(s) in ${report.eventCount} event(s)`);
    return 1;
  }
  console.log(`OK: ${report.eventCount} event(s), ${report.sessionCount} session(s)`);
  return 0;
}

/** Entry point; exported for tests. */
export function main(argv: string[]): number {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) return fail(err.message, 2);
    throw err;
  }

  if (args.flags.version === true) {
    console.log(VERSION);
    return 0;
  }
  if (args.flags.help === true || args.command === undefined) {
    console.log(USAGE);
    return args.command === undefined && args.flags.help !== true ? 2 : 0;
  }

  switch (args.command) {
    case "convert":
      return cmdConvert(args.positionals, args.flags);
    case "detect":
      return cmdDetect(args.positionals);
    case "stats":
      return cmdStats(args.positionals, args.flags);
    case "validate":
      return cmdValidate(args.positionals);
    case "schema":
      console.log(renderSchema());
      return 0;
    default:
      return fail(`unknown command "${args.command}"`, 2);
  }
}

process.exitCode = main(process.argv.slice(2));
