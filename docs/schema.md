# The turnvert event schema (version 1)

This document is the normative specification for turnvert's normalized JSONL
output. The machine-readable JSON Schema is printed by `turnvert schema`, and
`turnvert validate` checks a file against every rule below. If prose, schema
and validator ever disagree, that is a bug — a test in
`tests/validate.test.mjs` pins them together.

## Shape

A turnvert document is JSONL: **one JSON object per line, one line per
event, no blank lines**. Events appear in source order. A single document may
contain many sessions (aider history files usually do); the `session` field
changes mid-stream when that happens.

## Top-level fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | literal `1` | yes | Schema version. Bumped only for breaking changes. |
| `seq` | integer ≥ 1 | yes | Stream position. Starts at 1, increments by exactly 1 per line. |
| `event` | enum | yes | One of `session_start`, `message`, `tool_call`, `tool_result`, `note`. |
| `ts` | string \| null | yes | ISO-8601 timestamp as the source recorded it, or `null`. Never fabricated: aider turns have no time, so they are `null`; aider banners are naive local time and stay zone-less. |
| `harness` | string | yes | Producing harness. **Open set** — turnvert emits `claude-code`, `codex`, `aider`, `openhands`; third-party producers may add their own. |
| `session` | string | yes | Session identifier (native id when the log has one, else derived from the filename or banner). |
| `role` | enum | message only | `user`, `assistant` or `system`. |
| `model` | string | no | Model identifier, when the source names one. |
| `text` | string | see below | Message body or note text. |
| `thinking` | string | no | Reasoning text attached to assistant messages or tool calls. |
| `tool` | object | tool events | See below. |
| `usage` | object | no | Token accounting; see below. |
| `meta` | object | session_start only | String-valued harness metadata (`cwd`, `version`, `branch`, `model`, …). |
| `source` | object | no | Provenance: `file`, 1-based `line`, harness-native `id`. |
| `raw` | any | no | The untouched source record. Only present with `convert --raw`. |
| `x_*` | any | no | Extension escape hatch: keys with the `x_` prefix always validate. |

Any other top-level key is a validation error. This keeps the format closed
enough to build on and open enough to extend.

## Event kinds

| `event` | Requires | Forbids | Produced from |
|---|---|---|---|
| `session_start` | — | `role`, `tool`, `text`, `thinking` | Session banners/metadata records. Always the first event of a session. |
| `message` | `role`, and `text` or `thinking` | `tool`, `meta` | Human prompts, assistant replies, system prompts. Thinking-only messages carry reasoning with no visible reply. |
| `tool_call` | `tool.name` | `role`, `text`, `meta` | Tool/function/shell invocations and OpenHands actions. |
| `tool_result` | `tool.output` | `role`, `text`, `thinking`, `meta` | Tool outputs and OpenHands observations. |
| `note` | `text` | `role`, `tool`, `meta` | Harness housekeeping: summaries, hook output, applied-edit/commit lines, state changes, context wrappers. |

## The `tool` object

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Correlation id linking a call to its result (`tool_use_id`, `call_id`, or the OpenHands `cause` chain). Same value on both sides. |
| `name` | string | Tool name as the harness reported it. Required on `tool_call`. |
| `input` | any | Parsed arguments of a call. Unparseable argument strings are preserved as `{"_raw": "..."}`. |
| `output` | string | Flattened text output of a result. Required on `tool_result` (may be empty). |
| `error` | boolean | True when the harness marked the result failed (`is_error`, non-zero exit codes, error observations). |

## The `usage` object

Counters are numbers ≥ 0; absent counters mean "not reported", never 0.

| Key | Meaning |
|---|---|
| `input` | Prompt / sent tokens. |
| `output` | Completion / received tokens. |
| `cache_read` | Tokens served from a prompt cache. |
| `cache_write` | Tokens written into a prompt cache. |

**Aggregation guarantee:** usage attaches to exactly one event per model
response (the first event the response produced, or a patched assistant
event for Codex token counts, or the aider token-report note). Summing
`usage` over a stream therefore counts every token once.

## Ordering and identity

- `seq` is assigned by the converter over the whole output stream, including
  multi-file runs — files are concatenated in argument order.
- Within a session, event order is source order. Correlate calls and results
  via `tool.id`, not adjacency: harnesses interleave.
- Conversion is deterministic: the same inputs produce byte-identical output
  (fixed key order `v, seq, event, ts, harness, session, role, model, text,
  thinking, tool, usage, meta, source, raw`).

## Versioning

`v` is bumped only for breaking changes. Adding optional fields is not
breaking; consumers must ignore unknown *optional* semantics but may rely on
everything above for `v: 1`.
