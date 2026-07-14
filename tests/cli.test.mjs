// End-to-end CLI tests against the compiled dist/cli.js in a real child
// process: exit codes, stdout/stderr split, --out, --raw, --strict, and
// the full convert → validate round trip other tools will script.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXAMPLES, parseJsonl, runCli } from "./helpers.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "turnvert-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--version and --help work; bare invocation exits 2", () => {
  const version = runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const help = runCli(["--help"]);
  assert.equal(help.code, 0);
  for (const word of ["convert", "detect", "stats", "validate", "schema"]) {
    assert.match(help.stdout, new RegExp(`\\b${word}\\b`), word);
  }
  assert.equal(runCli([]).code, 2);
});

test("unknown commands and unknown flags exit 2 with a message on stderr", () => {
  const cmd = runCli(["frobnicate"]);
  assert.equal(cmd.code, 2);
  assert.match(cmd.stderr, /unknown command/);
  const flag = runCli(["convert", "x.jsonl", "--frobnicate"]);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /unknown flag/);
});

test("convert writes clean JSONL to stdout, one event per line", () => {
  const { code, stdout, stderr } = runCli(["convert", join(EXAMPLES, "codex-rollout.jsonl")]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const events = parseJsonl(stdout);
  assert.ok(events.length >= 5);
  assert.ok(events.every((e) => e.v === 1));
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1)
  );
});

test("convert --raw round-trips the source records; default omits them", () => {
  const withRaw = runCli(["convert", join(EXAMPLES, "claude-code-session.jsonl"), "--raw"]);
  const bare = runCli(["convert", join(EXAMPLES, "claude-code-session.jsonl")]);
  const rawEvents = parseJsonl(withRaw.stdout);
  assert.ok(rawEvents.some((e) => e.raw !== undefined));
  assert.ok(parseJsonl(bare.stdout).every((e) => e.raw === undefined));
});

test("convert --harness overrides detection; a bad value exits 2", () => {
  withTempDir((dir) => {
    // Plain text that detection cannot classify, forced through aider.
    const log = join(dir, "ambiguous.txt");
    writeFileSync(log, "#### just a question\n", "utf8");
    const forced = runCli(["convert", log, "--harness", "aider"]);
    assert.equal(forced.code, 0);
    assert.equal(parseJsonl(forced.stdout)[0].harness, "aider");
    const bad = runCli(["convert", log, "--harness", "vim"]);
    assert.equal(bad.code, 2);
  });
});

test("convert error paths: undetectable files exit 1, --strict promotes warnings", () => {
  withTempDir((dir) => {
    const mystery = join(dir, "mystery.log");
    writeFileSync(mystery, "hello world\n", "utf8");
    const failed = runCli(["convert", mystery]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /mystery\.log/);
    assert.match(failed.stderr, /--harness/);

    const torn = join(dir, "torn.jsonl");
    const good = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
      uuid: "u1",
      sessionId: "s1",
      timestamp: "2026-07-01T10:00:00.000Z",
    });
    writeFileSync(torn, `${good}\ntorn-half-line{{{\n`, "utf8");
    const lax = runCli(["convert", torn]);
    assert.equal(lax.code, 0);
    assert.match(lax.stderr, /warning: .*torn\.jsonl:2/);
    assert.equal(runCli(["convert", torn, "--strict"]).code, 1);
  });
});

test("detect reports one line per input and exits 1 on unknowns", () => {
  withTempDir((dir) => {
    const mystery = join(dir, "mystery.log");
    writeFileSync(mystery, "hello\n", "utf8");
    const { code, stdout } = runCli([
      "detect",
      join(EXAMPLES, "claude-code-session.jsonl"),
      join(EXAMPLES, "openhands-events.json"),
      mystery,
    ]);
    assert.equal(code, 1);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /\tclaude-code$/);
    assert.match(lines[1], /\topenhands$/);
    assert.match(lines[2], /\tunknown$/);
  });
});

test("stats renders the table for all four harnesses; --format json is structured", () => {
  const table = runCli([
    "stats",
    join(EXAMPLES, "claude-code-session.jsonl"),
    join(EXAMPLES, "codex-rollout.jsonl"),
    join(EXAMPLES, "aider-chat-history.md"),
    join(EXAMPLES, "openhands-events.json"),
  ]);
  assert.equal(table.code, 0);
  assert.match(table.stdout, /^SESSION\s+HARNESS/);
  for (const harness of ["claude-code", "codex", "aider", "openhands"]) {
    assert.match(table.stdout, new RegExp(harness));
  }
  assert.match(table.stdout, /\d+ event\(s\) across 5 session\(s\)/);

  const asJson = runCli(["stats", "--format", "json", join(EXAMPLES, "codex-rollout.jsonl")]);
  assert.equal(asJson.code, 0);
  const [session] = JSON.parse(asJson.stdout);
  assert.equal(session.harness, "codex");
  assert.equal(session.tool_calls, 1);
  assert.deepEqual(session.tools, [{ name: "shell", calls: 1 }]);
});

test("stats consumes already-normalized JSONL directly", () => {
  withTempDir((dir) => {
    const normalized = join(dir, "normalized.jsonl");
    const convert = runCli(["convert", join(EXAMPLES, "openhands-events.json"), "--out", normalized]);
    assert.equal(convert.code, 0);
    const fromNormalized = runCli(["stats", "--format", "json", normalized]);
    const fromSource = runCli(["stats", "--format", "json", join(EXAMPLES, "openhands-events.json")]);
    assert.deepEqual(JSON.parse(fromNormalized.stdout), JSON.parse(fromSource.stdout));
  });
});

test("convert → validate round trip succeeds for every bundled example", () => {
  withTempDir((dir) => {
    const out = join(dir, "all.jsonl");
    const convert = runCli([
      "convert",
      join(EXAMPLES, "claude-code-session.jsonl"),
      join(EXAMPLES, "codex-rollout.jsonl"),
      join(EXAMPLES, "aider-chat-history.md"),
      join(EXAMPLES, "openhands-events.json"),
      "--out",
      out,
    ]);
    assert.equal(convert.code, 0);
    const validate = runCli(["validate", out]);
    assert.equal(validate.code, 0);
    assert.match(validate.stdout, /^OK: \d+ event\(s\), 5 session\(s\)$/m);
  });
});

test("validate: line-numbered findings exit 1, a missing file exits 2", () => {
  withTempDir((dir) => {
    const bad = join(dir, "bad.jsonl");
    writeFileSync(
      bad,
      [
        JSON.stringify({ v: 1, seq: 1, event: "note", ts: null, harness: "codex", session: "s", text: "ok" }),
        JSON.stringify({ v: 1, seq: 3, event: "message", ts: null, harness: "codex", session: "s" }),
      ].join("\n") + "\n",
      "utf8"
    );
    const { code, stdout } = runCli(["validate", bad]);
    assert.equal(code, 1);
    assert.match(stdout, /bad\.jsonl:2: .*seq/);
    assert.match(stdout, /bad\.jsonl:2: .*role/);
    assert.match(stdout, /INVALID: \d+ error\(s\)/);
  });
  const missing = runCli(["validate", "definitely-missing.jsonl"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no such file/);
});

test("schema prints parseable JSON Schema naming all five event kinds", () => {
  const { code, stdout } = runCli(["schema"]);
  assert.equal(code, 0);
  const schema = JSON.parse(stdout);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.properties.event.enum, [
    "session_start",
    "message",
    "tool_call",
    "tool_result",
    "note",
  ]);
});
