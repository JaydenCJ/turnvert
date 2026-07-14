# Contributing to turnvert

Issues, discussions and pull requests are all welcome — this project aims to
stay small, zero-dependency at runtime, and boring about its output format.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/turnvert.git
cd turnvert
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 90 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check against examples/
```

`scripts/smoke.sh` exercises the real CLI (detect, convert, validate,
corruption catching, stats, schema, determinism) against the four bundled
example logs and must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable modules
   (parsers take text, not file handles; the validator takes decoded objects).
5. Any change to the event format needs a matching update in `docs/schema.md`,
   `src/schema.ts` AND `src/validate.ts` — a test pins the three together.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- No network calls, ever — turnvert reads local files and writes local
  files; it must never open a socket.
- Output must stay deterministic: the same inputs always produce
  byte-identical JSONL (fixed key order, no wall-clock reads).
- Never fabricate data: no invented timestamps, no zero-filled token counts,
  no tool calls dressed up from harnesses that do not record them.
- Schema version `v: 1` is a compatibility promise; breaking field changes
  require a version bump and are a last resort.
- Exit codes (0 / 1 / 2) are stable API; do not repurpose them.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `turnvert --version` output, the exact command line, and a
minimal source log snippet that reproduces the problem (redact prompt text
if needed — the line *structure* is what matters). For validator bugs,
attach the offending JSONL line and the error you expected or missed.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead.
