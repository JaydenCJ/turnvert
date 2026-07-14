# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-12

### Added

- Normalized event schema v1: five event kinds (`session_start`, `message`,
  `tool_call`, `tool_result`, `note`) with a fixed field set, provenance
  back-references, an open `harness` set and an `x_` extension escape
  hatch. Specified in `docs/schema.md`, printed by `turnvert schema` as
  JSON Schema (draft 2020-12).
- Claude Code parser: session metadata harvesting, summary/system/isMeta
  notes, thinking blocks, `tool_use`/`tool_result` unwrapping, and
  cache-aware usage attached once per API response.
- Codex CLI rollout parser: `session_meta`/`turn_context` handling,
  reasoning buffered onto the next assistant activity, JSON-string shell
  outputs unwrapped with exit-code errors, `token_count` patching, and
  `event_msg` de-duplication.
- Aider Markdown parser: multi-session history files, header folding into
  session metadata, fenced-code immunity, `Tokens: … sent, … received`
  parsed into usage, honest `ts: null` for untimestamped turns.
- OpenHands parser: JSON array, JSONL and `events/` directory inputs;
  action/observation mapping with `cause` linking and thought lifting.
- `turnvert convert`: content-first harness auto-detection (`--harness` to
  force), multi-file merging into one `seq` run, `--raw` source
  round-tripping, `--strict` warning promotion, byte-deterministic output.
- `turnvert detect`, `turnvert stats` (text table or `--format json`, also
  consumes already-normalized JSONL), and `turnvert validate` with
  line-addressed errors and script-friendly exit codes (0 / 1 / 2).
- Public programmatic API (`convertPaths`, `detectHarness`, the four
  parsers, `validateJsonl`, `computeStats`, `EVENT_JSON_SCHEMA`) with type
  declarations.
- Four realistic example logs (one per harness) under `examples/`.
- Test suite: 90 node:test tests (parser units, schema/validator agreement,
  orchestration, real child-process CLI runs) and an end-to-end
  `scripts/smoke.sh` against the bundled examples.

[0.1.0]: https://github.com/JaydenCJ/turnvert/releases/tag/v0.1.0
