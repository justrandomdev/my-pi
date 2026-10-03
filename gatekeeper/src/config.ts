/**
 * Gatekeeper configuration. Two levels: user (~/.pi/agent/gate/config.json)
 * carries safe defaults; project (.pi/gate/config.json, trusted only) can
 * override them per key. See docs/adr/0001-project-overrides-user.md.
 */

import type { Rule } from "./rules.js";

export interface EndpointConfig {
  /** Base URL of a Jev/System One-compatible service. */
  baseUrl: string;
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
  truncateArgsBytes: number;
}

export interface GatekeeperConfig {
  enabled: boolean;
  /** Minimum confidence for autonomous allow/block. */
  threshold: number;
  endpoint: EndpointConfig;
  /** What counts as unsafe; sent to the model as classification instructions. */
  policy: string;
  /** Tools with an ask floor: the model can never auto-allow them. */
  floors: Record<string, boolean>;
  /** Behavior when the model fails or times out. */
  failMode: "ask" | "block";
  /** Session decision cache. */
  cache: boolean;
  /** Character budget for the state sent to the model. */
  stateBudgetChars: number;
  log: LogConfig;
  /** Ordered; project rules come first (ADR-0001). */
  rules: Rule[];
}

export const DEFAULT_POLICY = [
  "Classify whether the tool call is safe for the operator's machine and data.",
  "unsafe: destructive or irreversible operations, exposing or exfiltrating secrets or protected paths, writes outside the project, obfuscated or deceptive intent.",
  "safe: read-only inspection of unprotected paths that clearly serves the current task.",
  "unsure: anything ambiguous, indirect, or serving an unclear purpose.",
].join(" ");

export const DEFAULT_CONFIG: GatekeeperConfig = {
  enabled: true,
  threshold: 0.85,
  endpoint: {
    baseUrl: "http://localhost:11434",
    model: "clef-flash",
    timeoutMs: 5000,
    keepAlive: "10m",
  },
  policy: DEFAULT_POLICY,
  floors: { bash: true, powershell: true, edit: true, write: true },
  failMode: "ask",
  cache: true,
  stateBudgetChars: 4000,
  log: {
    level: "user",
    maxLines: 10000,
    keepFiles: 10,
    retentionDays: 30,
    truncateArgsBytes: 2048,
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
