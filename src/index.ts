/**
 * Public programmatic API. Everything the CLI does is reachable from here,
 * so analyzers and dashboards can embed turnvert instead of shelling out.
 */

export type {
  DraftEvent,
  EventKind,
  Harness,
  NormalEvent,
  ParseOptions,
  ParseResult,
  ParseWarning,
  Provenance,
  Role,
  ToolInfo,
  Usage,
} from "./types.js";
export { EVENT_KINDS, HARNESSES, ROLES } from "./types.js";

export { detectHarness } from "./detect.js";
export { parseAider, parseTokenCount } from "./parsers/aider.js";
export { parseClaudeCode } from "./parsers/claude.js";
export { parseCodex } from "./parsers/codex.js";
export { parseOpenHands, parseOpenHandsEvents } from "./parsers/openhands.js";

export {
  convertPath,
  convertPaths,
  convertText,
  sequenceEvents,
  sortEventFiles,
} from "./convert.js";
export type { ConvertOptions, ConvertRun, ConvertRunWarning } from "./convert.js";

export { serializeEvent } from "./jsonl.js";
export { EVENT_JSON_SCHEMA, renderSchema } from "./schema.js";
export { computeStats, renderStatsTable } from "./stats.js";
export type { SessionStats } from "./stats.js";
export { validateEventObject, validateJsonl } from "./validate.js";
export type { ValidationError, ValidationReport } from "./validate.js";
export { SCHEMA_VERSION, VERSION } from "./version.js";
