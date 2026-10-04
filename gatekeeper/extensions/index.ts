/**
 * Gatekeeper extension: wires the gate into pi's tool_call event and
 * exposes the /gate commands. See docs/spec.md.
 */

import os from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPaths, DEFAULT_CONFIG, resolveConfig, type DeepPartial, type GatekeeperConfig, type ScopedConfig } from "../src/config.js";
import { createSystemOneClassifier } from "../src/classifier.js";
import { createGate, type GateDeps, type OperatorPromptInfo } from "../src/decision.js";
import { DecisionLog } from "../src/log.js";
import { createGatePrompt, type GatePromptResult } from "../src/prompt.js";
import { matchRules, type Rule } from "../src/rules.js";

export interface GatekeeperOptions {
  /** Overrides the home directory (config/log paths). Used by tests. */
  home?: string;
  /** Overrides fetch (the System One endpoint). Used by tests. */
  fetchFn?: typeof fetch;
}

type AnyCtx = ExtensionContext & {
  cwd: string;
  isProjectTrusted(): boolean;
};

export function createGatekeeper(pi: ExtensionAPI, options: GatekeeperOptions = {}): void {
  const home = options.home ?? os.homedir();
  const fetchFn = options.fetchFn ?? fetch;

  let currentTask = "";
  let currentCtx: AnyCtx | undefined;
  let effective: GatekeeperConfig = resolveConfig({});
  const mtimeCache = new Map<string, number | undefined>();
  const stats = { allowed: 0, blocked: 0, asked: 0 };

  function userConfigPath(): string {
    return configPaths(home, "").user;
  }
  function projectConfigPath(cwd: string): string {
    return join(cwd, ".pi/gate/config.json");
  }

  async function readScoped(trusted: boolean, cwd: string): Promise<ScopedConfig> {
    const scoped: ScopedConfig = {};
    const candidates: [keyof ScopedConfig, string][] = [["user", userConfigPath()]];
    if (trusted) candidates.push(["project", projectConfigPath(cwd)]);
    for (const [key, path] of candidates) {
      try {
        scoped[key] = JSON.parse(await readFile(path, "utf8")) as Partial<GatekeeperConfig>;
      } catch {
        // absent or malformed: skip the level
      }
    }
    return scoped;
  }

  /** Hot reload: re-read config only when a file's mtime changed. */
  async function refreshConfig(ctx: AnyCtx): Promise<void> {
    const paths = [userConfigPath(), ctx.isProjectTrusted() ? projectConfigPath(ctx.cwd) : null].filter(
      (p): p is string => p !== null,
    );
    let changed = false;
    for (const path of paths) {
      let mtime: number | undefined;
      try {
        mtime = (await stat(path)).mtimeMs;
      } catch {
        mtime = undefined;
      }
      if (mtimeCache.get(path) !== mtime) {
        mtimeCache.set(path, mtime);
        changed = true;
      }
    }
    if (changed) {
      effective = resolveConfig(await readScoped(ctx.isProjectTrusted(), ctx.cwd));
    }
  }

  function logDir(cwd: string): string {
    return effective.log.level === "project" ? join(cwd, ".pi/gate") : join(home, ".pi/agent/gate");
  }

  function logger(cwd: string): DecisionLog {
    return new DecisionLog({
      dir: logDir(cwd),
      maxLines: effective.log.maxLines,
      keepFiles: effective.log.keepFiles,
      retentionDays: effective.log.retentionDays,
    });
  }

  async function askOperator(prompt: OperatorPromptInfo): Promise<"allow-once" | "allow-always" | "deny" | "no-ui"> {
    const ctx = currentCtx;
    if (!ctx || !ctx.hasUI) return "no-ui";
    stats.asked++;
    // The custom bordered prompt when the mode supports it (TUI)…
    if (typeof ctx.ui.custom === "function") {
      try {
        return await ctx.ui.custom<GatePromptResult>(
          createGatePrompt({
            tool: prompt.tool,
            classification: prompt.classification,
            confidence: prompt.confidence,
            reason: prompt.reason,
            argsSummary: prompt.argsSummary,
          }),
        );
      } catch {
        // fall through to the selector dialog below
      }
    }
    // …and the plain selector everywhere else (RPC, print).
    const detail =
      (prompt.classification
        ? `Classification: ${prompt.classification} (confidence ${prompt.confidence?.toFixed(2)})\n`
        : "") +
      `Reason: ${prompt.reason}\n` +
      `Arguments: ${prompt.argsSummary}`;
    ctx.ui.notify(`gate › ${prompt.tool}\n${detail}`, "warning");
    const choice = await ctx.ui.select(`gate › ${prompt.tool}`, ["Allow once", "Allow always", "Deny"]);
    if (choice === "Allow once") return "allow-once";
    if (choice === "Allow always") return "allow-always";
    return "deny";
  }

  /** Write a scoped config file, creating it if needed. */
  async function writeScoped(
    level: "user" | "project",
    mutate: (scoped: DeepPartial<GatekeeperConfig>) => void,
    cwd: string,
  ): Promise<void> {
    const trusted = true;
    const scoped = await readScoped(trusted, cwd);
    const target = scoped[level] ?? {};
    mutate(target);
    scoped[level] = target;
    const path = level === "user" ? userConfigPath() : projectConfigPath(cwd);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(scoped[level], null, 2)}\n`, "utf8");
    mtimeCache.delete(path);
    effective = resolveConfig(await readScoped(currentCtx?.isProjectTrusted() ?? false, cwd));
  }

  const deps: GateDeps = {
    home,
    getConfig: () => effective,
    classify: (input) => createSystemOneClassifier(effective.endpoint, fetchFn).classify(input),
    askOperator,
    notify: (line) => {
      currentCtx?.ui.notify(line, line.includes("blocked") ? "warning" : "info");
    },
    writeLog: (record) => {
      const cwd = currentCtx?.cwd ?? process.cwd();
      logger(cwd)
        .append(record)
        .catch(() => {
          // logging must never break the gate
        });
    },
    addGrant: (rule: Rule) => {
      const cwd = currentCtx?.cwd ?? process.cwd();
      void writeScoped("user", (scoped) => {
        scoped.rules = [...(scoped.rules ?? []), rule];
      }, cwd);
    },
  };

  const gate = createGate(deps);

  pi.on("before_agent_start", (event: { prompt?: string }) => {
    currentTask = event.prompt ?? "";
  });

  pi.on("tool_call", async (event: { toolName?: unknown; input?: unknown }, ctx: ExtensionContext) => {
    const toolName = event.toolName;
    if (typeof toolName !== "string") return;
    currentCtx = ctx as AnyCtx;
    await refreshConfig(currentCtx);
    const decision = await gate.decide({
      tool: toolName,
      args: (event.input as Record<string, unknown>) ?? {},
      task: currentTask,
    });
    if (decision.action === "allow") {
      stats.allowed++;
    } else {
      stats.blocked++;
      return { block: true, reason: decision.reason };
    }
  });

  pi.registerCommand("gate", {
    description: "Gatekeeper status: posture, endpoint, session stats",
    handler: async (_args: string, ctx: AnyCtx) => {
      await refreshConfig(ctx);
      const floors = Object.entries(effective.floors)
        .filter(([, floored]) => floored)
        .map(([tool]) => tool)
        .join(", ");
      const lines = [
        `Gatekeeper ${effective.enabled ? "enabled" : "disabled"}`,
        `Endpoint: ${effective.endpoint.model} @ ${effective.endpoint.baseUrl}`,
        `Threshold: ${effective.threshold} | Floors: ${floors || "none"} | Fail mode: ${effective.failMode}`,
        `Rules: ${effective.rules.length} (incl. shipped defaults) | Log: ${logDir(ctx.cwd)}`,
        `Session: ${stats.allowed} allowed, ${stats.blocked} blocked, ${stats.asked} asked`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("gate:rules", {
    description: "Manage rules: list (default), add <allow|deny> <pattern> [--tool <t>] [--project], rm <u#|p#>, test <tool> [json-args]",
    handler: async (args: string, ctx: AnyCtx) => {
      await refreshConfig(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const clean = parts.filter((p) => p !== "--project");

      if (clean[0] === "add" && (clean[1] === "allow" || clean[1] === "deny") && clean[2]) {
        const level = parts.includes("--project") ? "project" : "user";
        const rule: Rule = { action: clean[1], pattern: clean[2] };
        const toolFlag = clean.indexOf("--tool");
        if (toolFlag !== -1 && clean[toolFlag + 1]) rule.tools = [clean[toolFlag + 1]];
        await writeScoped(level, (scoped) => {
          scoped.rules = [...(scoped.rules ?? []), rule];
        }, ctx.cwd);
        ctx.ui.notify(`gate › added ${rule.action} rule at ${level} level: ${rule.pattern}`, "info");
        return;
      }

      if (clean[0] === "rm" && clean[1]) {
        const ref = clean[1];
        const level = ref.startsWith("p") ? "project" : "user";
        const index = (Number(ref.match(/\d+$/)?.[0] ?? 0) || 0) - 1;
        const scoped = await readScoped(true, ctx.cwd);
        const rules = scoped[level]?.rules ?? [];
        const removed = rules[index];
        if (!removed) {
          ctx.ui.notify(`gate › no rule ${ref} at ${level} level`, "warning");
          return;
        }
        await writeScoped(level, (s) => {
          s.rules = (s.rules ?? []).filter((r) => r !== removed);
        }, ctx.cwd);
        ctx.ui.notify(`gate › removed ${removed.action} rule: ${removed.pattern ?? "(tool rule)"}`, "info");
        return;
      }

      if (clean[0] === "test" && clean[1]) {
        const tool = clean[1];
        let callArgs: Record<string, unknown> = {};
        try {
          callArgs = clean[2] ? (JSON.parse(clean[2]) as Record<string, unknown>) : {};
        } catch {
          ctx.ui.notify(`gate › arguments are not valid JSON: ${clean[2]}`, "error");
          return;
        }
        const rule = matchRules(effective.rules, tool, callArgs, home);
        ctx.ui.notify(
          rule
            ? `gate › ${tool} matches the ${rule.action} rule: ${rule.pattern ?? "(tool rule)"}`
            : `gate › ${tool} matches no rule; it would go to the model gate`,
          "info",
        );
        return;
      }

      // default: list
      const scoped = await readScoped(true, ctx.cwd);
      const listing = (["project", "user"] as const).flatMap((level) =>
        (scoped[level]?.rules ?? []).map(
          (rule, i) => `${level[0]}${i + 1}. ${rule.action} ${rule.pattern ?? ""} ${rule.tools?.join(",") ?? ""}`.trim(),
        ),
      );
      const defaults = DEFAULT_CONFIG.rules.map((rule) => `${rule.action} ${rule.tools?.join(",") ?? ""}`.trim());
      ctx.ui.notify(
        [`gate › rules (project p*, user u*, then shipped defaults):`, ...listing, ...defaults.map((d) => `d. ${d}`)].join("\n") || "gate › no rules",
        "info",
      );
    },
  });

  pi.registerCommand("gate:config", {
    description: "Show config, or set <key> <value> [--project]",
    handler: async (args: string, ctx: AnyCtx) => {
      await refreshConfig(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const level = parts.includes("--project") ? "project" : "user";
      const clean = parts.filter((p) => p !== "--project");

      if (clean[0] === "set" && clean[1] && clean[2] !== undefined) {
        const [, key, ...rest] = clean;
        const value = rest.join(" ");
        const parse = (): unknown => {
          if (value === "true" || value === "false") return value === "true";
          if (key === "threshold" || key === "endpoint.timeoutMs") return Number(value);
          if (key === "policy" || key === "failMode" || key === "log.level" || key.startsWith("endpoint.")) return value;
          return Number.isNaN(Number(value)) ? value : Number(value);
        };
        const parsed = parse();
        await writeScoped(level, (scoped) => {
          if (key === "log.level") {
            scoped.log = { ...DEFAULT_CONFIG.log, ...(scoped.log ?? {}), level: value as "user" | "project" };
          } else if (key.startsWith("endpoint.")) {
            scoped.endpoint = {
              ...DEFAULT_CONFIG.endpoint,
              ...(scoped.endpoint ?? {}),
              [key.slice("endpoint.".length)]: parsed,
            };
          } else {
            (scoped as Record<string, unknown>)[key] = parsed;
          }
        }, ctx.cwd);
        ctx.ui.notify(`gate › set ${key} = ${value} at ${level} level`, "info");
        return;
      }

      ctx.ui.notify(
        [
          `gate › effective config (defaults < user < project):`,
          `enabled: ${effective.enabled}`,
          `threshold: ${effective.threshold}`,
          `endpoint: ${effective.endpoint.baseUrl} (${effective.endpoint.model})`,
          `failMode: ${effective.failMode} | cache: ${effective.cache}`,
          `log: level=${effective.log.level} maxLines=${effective.log.maxLines} keepFiles=${effective.log.keepFiles} retentionDays=${effective.log.retentionDays}`,
          `floors: ${JSON.stringify(effective.floors)}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("gate:log", {
    description: "Tail the decision log: [n] [tool filter]",
    handler: async (args: string, ctx: AnyCtx) => {
      await refreshConfig(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const n = parts[0] && /^\d+$/.test(parts[0]) ? Number(parts[0]) : 20;
      const filter = parts[0] && /^\d+$/.test(parts[0]) ? parts[1] : parts[0];
      const records = await logger(ctx.cwd).tail(n * 4);
      const selected = records.filter((r) => !filter || r.tool.includes(filter)).slice(-n);
      const lines = selected.map(
        (r) => `${r.ts} ${r.tool} → ${r.action} (${r.source}${r.classification ? ` ${r.classification} ${r.confidence?.toFixed(2)}` : ""})`,
      );
      const body = lines.length ? lines : ["(none yet)"];
      ctx.ui.notify([`gate › last ${selected.length} decisions:`, ...body].join("\n"), "info");
    },
  });
}

export default function gatekeeper(pi: ExtensionAPI): void {
  createGatekeeper(pi);
}
