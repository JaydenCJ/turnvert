// Aider Markdown parser: session banners, header folding, user/assistant
// block accumulation, fenced-code immunity, token-line parsing, and
// multi-session files. Aider is the one non-JSON harness, so most of the
// tricky text handling lives here.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseAider, parseTokenCount } from "../dist/parsers/aider.js";

const BANNER = "# aider chat started at 2026-07-01 09:00:00";

function events(text) {
  return parseAider(text).events;
}

test("banner emits session_start with a naive-local ISO timestamp; turns are ts null", () => {
  const all = events([BANNER, "", "#### q", "", "a"].join("\n"));
  const [start] = all;
  assert.equal(start.event, "session_start");
  assert.equal(start.ts, "2026-07-01T09:00:00"); // no fabricated zone
  assert.equal(start.session, "aider-2026-07-01T09:00:00");
  // Aider does not timestamp turns, so turnvert must not invent times.
  assert.ok(all.slice(1).every((e) => e.ts === null));
});

test("recognized header lines fold into meta; the rest survive as notes", () => {
  const text = [
    BANNER,
    "",
    "> Aider v0.85.1",
    "> Main model: gpt-4o with diff edit format",
    "> Git repo: .git with 12 files",
    "> Repo-map: using 1024 tokens",
    "",
    "#### hello",
  ].join("\n");
  const all = events(text);
  const [start, note, user] = all;
  assert.deepEqual(start.meta, {
    version: "0.85.1",
    model: "gpt-4o",
    edit_format: "diff",
    git_repo: ".git with 12 files",
  });
  assert.equal(note.event, "note");
  assert.equal(note.text, "Repo-map: using 1024 tokens");
  assert.equal(user.role, "user");
});

test("consecutive #### lines join into one user message", () => {
  const text = [BANNER, "", "#### first line", "#### second line"].join("\n");
  const user = events(text).find((e) => e.event === "message");
  assert.equal(user.role, "user");
  assert.equal(user.text, "first line\nsecond line");
});

test("plain text becomes an assistant message carrying the session model", () => {
  const text = [BANNER, "", "> Model: gpt-4o with diff edit format", "", "#### q", "", "the answer"].join("\n");
  const assistant = events(text).find((e) => e.role === "assistant");
  assert.equal(assistant.text, "the answer");
  assert.equal(assistant.model, "gpt-4o");
});

test("assistant messages span blank lines until the next block starts", () => {
  const text = [BANNER, "", "#### q", "", "para one", "", "para two", "", "> Applied edit to a.py"].join("\n");
  const assistant = events(text).find((e) => e.role === "assistant");
  assert.equal(assistant.text, "para one\n\npara two");
});

test("#### and > lines inside a fenced code block stay in the assistant text", () => {
  const text = [
    BANNER,
    "",
    "#### show me a heredoc",
    "",
    "Here you go:",
    "```bash",
    "#### not a user message",
    "> not a note",
    "```",
    "Done.",
  ].join("\n");
  const all = events(text);
  const assistant = all.find((e) => e.role === "assistant");
  assert.match(assistant.text, /#### not a user message/);
  assert.match(assistant.text, /> not a note/);
  assert.match(assistant.text, /Done\.$/);
  assert.equal(all.filter((e) => e.event === "note").length, 0);
  assert.equal(all.filter((e) => e.role === "user").length, 1);
});

test("post-header > lines become notes with their line numbers", () => {
  const text = [BANNER, "", "#### q", "", "a", "", "> Applied edit to src/x.py"].join("\n");
  const note = events(text).find((e) => e.event === "note");
  assert.equal(note.text, "Applied edit to src/x.py");
  assert.equal(note.source.line, 7);
});

test("token report notes get parsed usage (k-suffix, decimals, comma grouping)", () => {
  const text = [BANNER, "", "#### q", "", "a", "", "> Tokens: 2.4k sent, 350 received. Cost: $0.01 message, $0.01 session."].join("\n");
  const note = events(text).find((e) => e.event === "note");
  assert.deepEqual(note.usage, { input: 2400, output: 350 });
  assert.equal(parseTokenCount("2.4k"), 2400);
  assert.equal(parseTokenCount("12,438"), 12438);
  assert.equal(parseTokenCount("350"), 350);
  assert.equal(parseTokenCount("8k"), 8000);
  assert.equal(parseTokenCount("wat"), undefined);
});

test("one file, two banners: two sessions, distinct ids, model resets", () => {
  const text = [
    BANNER,
    "> Model: gpt-4o with diff edit format",
    "",
    "#### one",
    "",
    "answer one",
    "",
    "# aider chat started at 2026-07-01 10:30:00",
    "",
    "#### two",
    "",
    "answer two",
  ].join("\n");
  const all = events(text);
  const starts = all.filter((e) => e.event === "session_start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].session, starts[1].session);
  assert.equal(all.find((e) => e.text === "two").session, "aider-2026-07-01T10:30:00");
  // The second session declared no model, so none may leak across.
  const assistants = all.filter((e) => e.role === "assistant");
  assert.equal(assistants[0].model, "gpt-4o");
  assert.equal(assistants[1].model, undefined);
});

test("a header-only session still emits its session_start", () => {
  const text = [BANNER, "", "> Aider v0.85.1"].join("\n");
  const all = events(text);
  assert.equal(all.length, 1);
  assert.equal(all[0].event, "session_start");
  assert.deepEqual(all[0].meta, { version: "0.85.1" });
});

test("content before any banner uses the sessionHint", () => {
  const { events: all } = parseAider("#### stray question\n", { sessionHint: "history" });
  assert.equal(all.length, 1);
  assert.equal(all[0].session, "history");
  assert.equal(all[0].role, "user");
});
