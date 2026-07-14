// Shared test plumbing: repo paths, a CLI runner (real child process against
// dist/cli.js), and small factories for hand-built source lines.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(ROOT, "dist", "cli.js");
export const EXAMPLES = join(ROOT, "examples");
export const FIXTURES = join(ROOT, "tests", "fixtures");

/** Run the real CLI; never throws — returns { code, stdout, stderr }. */
export function runCli(args, options = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? ROOT,
    env: { ...process.env },
  });
  return { code: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Parse a JSONL string into an array of objects. */
export function parseJsonl(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** Build one Claude Code JSONL line. */
export function claudeLine(type, message, extra = {}) {
  return JSON.stringify({
    type,
    message,
    uuid: extra.uuid ?? "00000000-0000-4000-8000-000000000000",
    sessionId: extra.sessionId ?? "test-session",
    timestamp: extra.timestamp ?? "2026-07-01T10:00:00.000Z",
    cwd: extra.cwd ?? "/workspace/demo",
    version: extra.version ?? "1.0.0",
    ...extra,
  });
}

/** Build one Codex rollout line. */
export function codexLine(type, payload, timestamp = "2026-07-01T10:00:00.000Z") {
  return JSON.stringify({ timestamp, type, payload });
}

/** A minimal valid normalized event for validator tests. Overriding a key
 * with `undefined` removes it, so tests can build field-absent shapes. */
export function normalEvent(overrides = {}) {
  const event = {
    v: 1,
    seq: 1,
    event: "note",
    ts: null,
    harness: "claude-code",
    session: "s1",
    text: "hello",
    ...overrides,
  };
  for (const key of Object.keys(event)) {
    if (event[key] === undefined) delete event[key];
  }
  return event;
}

/** Serialize events (objects) into a JSONL document. */
export function jsonl(...objects) {
  return objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
}
