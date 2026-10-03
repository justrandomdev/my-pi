/**
 * Static rules: the fast layer of the gate. First hit wins; a rule hit
 * skips the decision model entirely. See docs/spec.md and GLOSSARY.md.
 */

export interface Rule {
  /** allow or deny the call */
  action: "allow" | "deny";
  /** tool names this rule applies to; omit for any tool */
  tools?: string[];
  /** path/argument glob; omit for any arguments. `~` expands to home.
   *  File tools match against their path target (anchored, full match).
   *  Shell commands and other tools match over their text/serialized
   *  arguments, asymmetrically for safety: `allow` rules anchor to the
   *  start of the text (a leading `*` opts out), and `*`/`**` cross
   *  everything; `deny` rules search the whole text so they catch
   *  exfiltration anywhere in a command. */
  pattern?: string;
  reason?: string;
}

/** Tools whose arguments carry a path target. */
const FILE_TOOLS = new Set(["read", "edit", "write"]);
/** Tools whose arguments carry arbitrary command text. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Convert a glob to a regex source. `**` matches anything, `*` matches
 *  within one path segment, `?` matches one character. */
function globToRegexSource(pattern: string): string {
  return pattern
    .split("**")
    .map((segment) =>
      segment
        .split("*")
        .map((piece) => piece.split("?").map(escapeRegex).join("."))
        .join("[^/]*"),
    )
    .join(".*");
}

function expandHome(text: string, home: string): string {
  return text.replace(/(^|[\s'"(=])~(?=$|[\/\s'"')])/g, (_m, lead: string) => lead + home);
}

/** Normalize a pattern: `~` expanded, trailing slash tolerated. */
function normalizePattern(pattern: string, home: string): string {
  return expandHome(pattern, home);
}

function matchesTarget(pattern: string, target: string, home: string): boolean {
  const source = globToRegexSource(normalizePattern(pattern, home));
  // Targets match fully: a pattern names the path it protects.
  return new RegExp(`^${source}$`).test(expandHome(target, home));
}

/** Content globs: `*` and `**` cross everything (spaces, slashes, &&). */
function contentGlobToRegexSource(pattern: string): string {
  return escapeRegex(pattern)
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
}

function matchesContent(pattern: string, text: string, home: string, action: Rule["action"]): boolean {
  const source = contentGlobToRegexSource(normalizePattern(pattern, home));
  // Allows anchor to the start of the text (a leading * opts out);
  // denies search anywhere so nothing hides mid-command.
  const anchored = action === "allow" && !pattern.startsWith("*");
  const regex = new RegExp(anchored ? `^${source}` : source);
  return regex.test(expandHome(text, home));
}

/** Split a shell chain into its component commands, respecting quotes.
 *  A heuristic splitter, not a shell parser: separators inside quotes are
 *  literal; command substitution stays inside a component (and defeats
 *  allow rules, see matchesShell). */
export function splitShellChain(command: string): string[] {
  const components: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      components.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      components.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  components.push(current);
  return components.map((c) => c.trim()).filter(Boolean);
}

/** Command substitution or process substitution inside a component. */
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

function matchesShell(rule: Rule, command: string, home: string): boolean {
  const components = splitShellChain(command);
  if (rule.action === "allow") {
    // Every component must match the pattern; substitution defeats the
    // allow so `ls $(rm -rf /)` falls to the model gate.
    return components.every(
      (c) => !SUBSTITUTION.test(c) && matchesContent(rule.pattern as string, c, home, "allow"),
    );
  }
  // A deny catches the chain if any component matches.
  return components.some((c) => matchesContent(rule.pattern as string, c, home, "deny"));
}

function argsText(tool: string, args: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(tool)) {
    const command = args?.command;
    if (typeof command === "string") return command;
  }
  return JSON.stringify(args ?? {});
}

/** Does this rule match the given call? */
export function ruleMatches(rule: Rule, tool: string, args: Record<string, unknown>, home: string): boolean {
  if (rule.tools && !rule.tools.includes(tool)) return false;
  if (!rule.pattern) return true;

  if (SHELL_TOOLS.has(tool)) {
    const command = args?.command;
    if (typeof command === "string" && rule.pattern) {
      return matchesShell(rule, command, home);
    }
  }
  if (FILE_TOOLS.has(tool)) {
    const target = args?.path;
    if (typeof target !== "string") return false;
    return matchesTarget(rule.pattern, target, home);
  }
  return matchesContent(rule.pattern, argsText(tool, args), home, rule.action);
}

/** First matching rule in order, or undefined. */
export function matchRules(rules: Rule[], tool: string, args: Record<string, unknown>, home: string): Rule | undefined {
  return rules.find((rule) => ruleMatches(rule, tool, args, home));
}

/** Deny-rule patterns: the protected paths injected into model state. */
export function protectedPatterns(rules: Rule[]): string[] {
  return rules.filter((r) => r.action === "deny" && r.pattern).map((r) => r.pattern as string);
}

/** The pattern an "allow always" grant should pin: the file tool's target,
 *  or the shell/other tool's argument text. */
export function grantPattern(tool: string, args: Record<string, unknown>): string | undefined {
  if (FILE_TOOLS.has(tool)) {
    return typeof args?.path === "string" ? args.path : undefined;
  }
  const text = argsText(tool, args);
  return text && text !== "{}" ? text : undefined;
}
