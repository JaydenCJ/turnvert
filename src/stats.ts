/**
 * Aggregation for `turnvert stats`: fold a normalized event stream into
 * per-session summaries. Works on anything that passes the validator, so
 * it can also summarize JSONL produced by third-party tools.
 */

import type { NormalEvent } from "./types.js";

export interface SessionStats {
  session: string;
  harness: string;
  events: number;
  messages: { user: number; assistant: number; system: number };
  tool_calls: number;
  tool_errors: number;
  notes: number;
  tokens: { input: number; output: number };
  /** Tool call counts by tool name, sorted by count desc then name asc. */
  tools: { name: string; calls: number }[];
  first_ts: string | null;
  last_ts: string | null;
  model: string | null;
}

/** Fold events into per-session stats, in first-seen session order. */
export function computeStats(events: NormalEvent[]): SessionStats[] {
  const order: string[] = [];
  const bySession = new Map<string, SessionStats & { toolMap: Map<string, number> }>();

  for (const e of events) {
    let s = bySession.get(e.session);
    if (s === undefined) {
      s = {
        session: e.session,
        harness: e.harness,
        events: 0,
        messages: { user: 0, assistant: 0, system: 0 },
        tool_calls: 0,
        tool_errors: 0,
        notes: 0,
        tokens: { input: 0, output: 0 },
        tools: [],
        first_ts: null,
        last_ts: null,
        model: null,
        toolMap: new Map(),
      };
      bySession.set(e.session, s);
      order.push(e.session);
    }

    s.events += 1;
    if (e.ts !== null) {
      if (s.first_ts === null) s.first_ts = e.ts;
      s.last_ts = e.ts;
    }
    if (e.model !== undefined && s.model === null) s.model = e.model;
    if (e.usage !== undefined) {
      s.tokens.input += e.usage.input ?? 0;
      s.tokens.output += e.usage.output ?? 0;
    }

    if (e.event === "message" && e.role !== undefined) {
      s.messages[e.role] += 1;
    } else if (e.event === "tool_call") {
      s.tool_calls += 1;
      const name = e.tool?.name ?? "unknown";
      s.toolMap.set(name, (s.toolMap.get(name) ?? 0) + 1);
    } else if (e.event === "tool_result") {
      if (e.tool?.error === true) s.tool_errors += 1;
    } else if (e.event === "note") {
      s.notes += 1;
    }
  }

  return order.map((id) => {
    const s = bySession.get(id);
    if (s === undefined) throw new Error("unreachable: session vanished");
    const { toolMap, ...rest } = s;
    rest.tools = [...toolMap.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1));
    return rest;
  });
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Render the fixed-width text table `turnvert stats` prints. */
export function renderStatsTable(stats: SessionStats[]): string {
  const header = ["SESSION", "HARNESS", "EVENTS", "MSGS", "TOOLS", "ERRS", "TOKENS IN/OUT"];
  const rows = stats.map((s) => [
    shorten(s.session, 28),
    s.harness,
    String(s.events),
    String(s.messages.user + s.messages.assistant + s.messages.system),
    String(s.tool_calls),
    String(s.tool_errors),
    `${s.tokens.input}/${s.tokens.output}`,
  ]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? "").length))
  );
  const renderRow = (cells: string[]): string =>
    cells.map((c, col) => pad(c, widths[col] ?? c.length)).join("  ").trimEnd();

  const lines = [renderRow(header), ...rows.map(renderRow)];
  const totalEvents = stats.reduce((n, s) => n + s.events, 0);
  lines.push("");
  lines.push(`${totalEvents} event(s) across ${stats.length} session(s)`);
  return lines.join("\n");
}
