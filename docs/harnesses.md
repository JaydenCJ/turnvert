# Harness mapping notes

How each supported harness's native log maps onto the normalized schema,
and what each parser deliberately does *not* invent. See
[schema.md](schema.md) for the target format.

## Claude Code — `~/.claude/projects/<project>/<session-id>.jsonl`

| Native | Normalized |
|---|---|
| first line carrying `sessionId`/`cwd`/`version`/`gitBranch` | `session_start` (+ `meta`) |
| `{"type":"summary"}` | `note` |
| `{"type":"user"}` with text content | `message` (`user`) |
| `{"type":"user"}` with `tool_result` parts | one `tool_result` per part (`id` = `tool_use_id`, `error` = `is_error`) |
| `{"type":"user","isMeta":true}` | `note` (caveats, command echoes) |
| `{"type":"assistant"}` `text` / `thinking` parts | `message` (`assistant`) with `thinking` |
| `{"type":"assistant"}` `tool_use` parts | one `tool_call` per part |
| `{"type":"system"}` | `note` (hook output — not a model system prompt) |

`model` and `usage` (`input_tokens`, `output_tokens`, `cache_read/creation_…`)
attach to the **first** event emitted from each assistant API message, so
token sums never double-count. Unknown line types are warnings, not errors.

## Codex CLI — `~/.codex/sessions/…/rollout-<ts>-<uuid>.jsonl`

| Native | Normalized |
|---|---|
| `session_meta` | `session_start` (+ `meta`); non-empty `instructions` → `message` (`system`) |
| `turn_context` | consumed — sets the current `model`, emits nothing |
| `response_item: message` | `message`; `<user_instructions>`/`<environment_context>` wrappers → `note` |
| `response_item: reasoning` | buffered; attached as `thinking` to the next assistant message or tool call |
| `response_item: function_call` / `custom_tool_call` | `tool_call` (JSON-string arguments parsed) |
| `response_item: function_call_output` | `tool_result` (embedded `{"output","metadata":{"exit_code"}}` unwrapped; non-zero exit → `error`) |
| `response_item: local_shell_call` / `web_search_call` | `tool_call` (`local_shell` / `web_search`) |
| `event_msg: token_count` | `usage` patched onto the latest assistant event (or a fallback note) |
| `event_msg: user_message` / `agent_message` | `message`, de-duplicated against just-emitted response_items |
| other `event_msg` types | ignored (UI chatter duplicated from response_items) |

## Aider — `.aider.chat.history.md`

Aider logs Markdown and appends every run, so one file holds many sessions.

| Native | Normalized |
|---|---|
| `# aider chat started at <ts>` | `session_start` (`ts` naive local, session id derived from it) |
| header `>` lines (`Aider vX`, `Main model:`, `Git repo:`) | folded into `session_start.meta`; unrecognized header lines survive as `note`s |
| `#### …` lines (joined) | `message` (`user`) |
| plain text blocks | `message` (`assistant`, carries the session `model`) |
| `> Tokens: 2.4k sent, 350 received. …` | `note` with parsed `usage` |
| other `> …` lines (Applied edit, Commit, …) | `note` |

Limitations, on purpose: aider records no per-turn timestamps (`ts: null`
everywhere but the banner) and no tool-call protocol — applied edits and
commits stay `note`s rather than being dressed up as calls. Fenced code
blocks are honored: a `####` or `>` line inside a fence is body text.

## OpenHands — event streams

Accepted inputs: a JSON array export, JSONL, or a session `events/`
directory of `<id>.json` files (numeric order: `2.json` < `10.json`).

| Native | Normalized |
|---|---|
| action `message` / `system` | `message` (`user`/`assistant`/`system`) |
| action `think` | `message` with `thinking` only |
| action `finish` | `note` |
| any other action (`run`, `edit`, `browse`, …) | `tool_call` (`name` = action, `input` = args, `thought` lifted to `thinking`) |
| observation with `cause` | `tool_result` (`id` = cause; `extras.exit_code` ≠ 0 or `error` observation → `error`) |
| observation `agent_state_changed` | `note` (`agent state: …`) |
| cause-less observations | `note` |

## Adding a harness

A parser is a pure function `(text, options) → { events, warnings }` in
`src/parsers/`. Wire it into `detect.ts` (content-first detection) and
`convert.ts` (dispatch), add a mapping table here, and pin the semantics
with tests. Skimping on `warnings` is the only unacceptable shortcut —
turnvert never silently drops a line it did not decide to drop.
