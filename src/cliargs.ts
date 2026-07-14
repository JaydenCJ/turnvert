/**
 * Tiny, dependency-free argv parser. Only what the CLI needs: one
 * subcommand, positionals, `--flag`, `--flag value` and `--flag=value`.
 * Unknown flags are hard errors so typos never silently change behavior.
 */

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class ArgError extends Error {}

/** Flags that take a value, per command (plus globals). */
const VALUE_FLAGS: Record<string, Set<string>> = {
  convert: new Set(["harness", "out"]),
  detect: new Set([]),
  stats: new Set(["harness", "format"]),
  validate: new Set([]),
  schema: new Set([]),
};

/** Boolean flags, per command. */
const BOOL_FLAGS: Record<string, Set<string>> = {
  convert: new Set(["raw", "strict"]),
  detect: new Set([]),
  stats: new Set([]),
  validate: new Set([]),
  schema: new Set([]),
};

export const COMMANDS = Object.keys(VALUE_FLAGS);

/** Parse argv (already stripped of `node script.js`). */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: {} };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";

    if (arg === "--help" || arg === "-h") {
      out.flags.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      out.flags.version = true;
      continue;
    }

    if (arg.startsWith("--")) {
      if (out.command === undefined) throw new ArgError(`flag ${arg} must follow a command`);
      const eq = arg.indexOf("=");
      const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
      const valueFlags = VALUE_FLAGS[out.command] ?? new Set<string>();
      const boolFlags = BOOL_FLAGS[out.command] ?? new Set<string>();

      if (valueFlags.has(name)) {
        let value: string;
        if (eq !== -1) {
          value = arg.slice(eq + 1);
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("--")) {
            throw new ArgError(`flag --${name} requires a value`);
          }
          value = next;
          i += 1;
        }
        out.flags[name] = value;
        continue;
      }
      if (boolFlags.has(name)) {
        if (eq !== -1) throw new ArgError(`flag --${name} does not take a value`);
        out.flags[name] = true;
        continue;
      }
      throw new ArgError(`unknown flag --${name} for command "${out.command}"`);
    }

    if (arg.startsWith("-") && arg !== "-") {
      throw new ArgError(`unknown flag ${arg}`);
    }

    if (out.command === undefined) {
      if (!COMMANDS.includes(arg)) throw new ArgError(`unknown command "${arg}"`);
      out.command = arg;
    } else {
      out.positionals.push(arg);
    }
  }

  return out;
}
