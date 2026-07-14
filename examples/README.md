# Examples

One realistic session log per supported harness. The test suite and
`scripts/smoke.sh` both run against these files, so they are guaranteed to
stay convertible. All four describe small debugging sessions, which makes it
easy to compare how the same kind of activity looks before and after
normalization.

## Try it

```bash
# from the repository root, after `npm install && npm run build`
node dist/cli.js detect   examples/*.jsonl examples/*-history.md examples/*.json
node dist/cli.js convert  examples/claude-code-session.jsonl
node dist/cli.js convert  examples/*.jsonl examples/*-history.md examples/*.json --out all.jsonl
node dist/cli.js validate all.jsonl
node dist/cli.js stats    all.jsonl
```

## What each file demonstrates

| File | Demonstrates |
|---|---|
| `claude-code-session.jsonl` | Summary lines, thinking blocks, `tool_use`/`tool_result` pairs, cache-aware usage |
| `codex-rollout.jsonl` | `session_meta` + instructions, reasoning buffering, JSON-string shell output, `token_count` patching |
| `aider-chat-history.md` | Markdown parsing: two sessions in one file, header folding, fenced code, `Tokens:` usage notes |
| `openhands-events.json` | action/observation `cause` linking, thought lifting, exit-code errors, state-change notes |

The OpenHands per-event directory layout (`events/1.json`, `events/2.json`,
…) is also supported — point `convert` at the directory itself. A tiny
directory fixture used by the tests lives in
`tests/fixtures/openhands-events-dir/`.
