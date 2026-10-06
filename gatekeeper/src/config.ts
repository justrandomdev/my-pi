/**
 * Gatekeeper configuration. Two levels: user (~/.pi/agent/gate/config.json)
 * carries safe defaults; project (.pi/gate/config.json, trusted only) can
 * override them per key. See docs/adr/0001-project-overrides-user.md.
 */

import type { Rule } from "./rules.js";

export interface EndpointConfig {
  /** Full request URL of a Jev/System One-compatible service. */
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  /** Ollama keep_alive so the model stays warm between calls. */
  keepAlive: string;
}

export interface LogConfig {
  level: "user" | "project";
  maxLines: number;
  keepFiles: number;
  retentionDays: number;
  /** Character cap on the argument preview — a JS string budget; the
   *  name says bytes and is kept for config compatibility. */
  truncateArgsBytes: number;
}

export interface SecretsConfig {
  enabled: boolean;
  /** Fetch the source on start and adopt it when it passes the sanity gates. */
  autoUpdate: boolean;
  /** gitleaks.toml source URL (ADR-0004). Pin a tag by changing it. */
  source: string;
}

export interface GatekeeperConfig {
  enabled: boolean;
  /** Minimum confidence for autonomous allow/block. Auto-allow additionally
   *  requires a negligible unsafe probability (a fixed bound, see decision.ts). */
  threshold: number;
  endpoint: EndpointConfig;
  /** What counts as unsafe; sent to the model as classification instructions. */
  policy: string;
  /** Behavior when the model fails or times out. */
  failMode: "ask" | "block";
  /** Character budget for the task text sent to the model; arguments are
   *  capped to a fixed 100 characters (ADR-0002/0005). */
  stateBudgetChars: number;
  /** Transparency-line verbosity: `always` notifies every decision (default);
   *  `summary` notifies only blocks/asks; `off` suppresses all notifications;
   *  `debug` is `always` plus the full model request and answer dumped per
   *  classification. The decision log is unaffected. */
  notify: "always" | "summary" | "off" | "debug";
  log: LogConfig;
  /** Deterministic secrets detection (ADR-0004). */
  secrets: SecretsConfig;
  /** Ordered; project rules come first (ADR-0001). */
  rules: Rule[];
}

export const DEFAULT_POLICY = [
  "Evaluate whether the tool call is safe to execute on the operator's machine.",
  "Treat standard development actions (inspecting files, running tests, local builds, text filtering) as safe.",
  "Command complexity, chained pipes (|), and subshells do not inherently make a command unsafe or unsure—evaluate the net execution side-effects.",
  "Prioritize protecting sensitive credentials (.env, API keys, cloud tokens, SSH keys) and preventing unauthorized system state changes or remote data egress."
].join(" ");

export const DEFAULT_CONFIG: GatekeeperConfig = {
  enabled: true,
  threshold: 0.65,
  endpoint: {
    url: "http://localhost:11434/v1/systemone",
    model: "clef-flash",
    // Cold-start load of a large local model can take tens of seconds;
    // warm calls are sub-second. keep_alive keeps the model warm between calls.
    timeoutMs: 30_000,
    keepAlive: "10m",
  },
  policy: DEFAULT_POLICY,
  failMode: "ask",
  stateBudgetChars: 4000,
  notify: "always",
  log: {
    level: "user",
    maxLines: 10000,
    keepFiles: 10,
    retentionDays: 30,
    truncateArgsBytes: 2048,
  },
  secrets: {
    enabled: true,
    autoUpdate: true,
    source: "https://raw.githubusercontent.com/gitleaks/gitleaks/refs/heads/master/config/gitleaks.toml",
  },
  rules: [{ action: "allow", tools: ["ls", "find"] }],
};

/** A partial of a partial: nested objects stay partial, arrays pass through. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ScopedConfig {
  user?: DeepPartial<GatekeeperConfig>;
  project?: DeepPartial<GatekeeperConfig>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function mergeInto<T extends object>(base: Mutable<T>, patch: DeepPartial<T> | undefined): Mutable<T> {
  if (!patch) return base;
  for (const [key, value] of Object.entries(patch) as [keyof T, unknown][]) {
    if (value === undefined) continue;
    const current = base[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current)
    ) {
      base[key] = mergeInto(current as object, value as object) as T[keyof T];
    } else {
      base[key] = value as T[keyof T];
    }
  }
  return base;
}

/** Effective config: defaults < user < project, per key (ADR-0001).
 *  Rules order: project, user, then the shipped defaults — so a project or
 *  user rule can override a default, but the default posture survives. */
export function resolveConfig(scoped: ScopedConfig): GatekeeperConfig {
  const config = mergeInto(structuredClone(DEFAULT_CONFIG), scoped.user);
  mergeInto(config, scoped.project);
  const projectRules = scoped.project?.rules ?? [];
  const userRules = scoped.user?.rules ?? [];
  config.rules = [...projectRules, ...userRules, ...DEFAULT_CONFIG.rules];
  return config as GatekeeperConfig;
}

export function configPaths(home: string, cwd: string): { user: string; project: string } {
  return {
    user: `${home}/.pi/agent/gate/config.json`,
    project: `${cwd}/.pi/gate/config.json`,
  };
}
