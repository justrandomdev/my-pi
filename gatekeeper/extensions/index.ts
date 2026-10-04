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

  /** Tokenize a slash-command argument string: strips whitespace, recognizes
   *  `--project`, returns the target level and the remaining parts. Each
   *  remaining part has matching surrounding quotes stripped, so
   *  `add allow "*"` and `add allow *` produce the same pattern. */
  function parseCmdArgs(raw: string): { level: "user" | "project"; parts: string[] } {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    const level: "user" | "project" = parts.includes("--project") ? "project" : "user";
    return {
      level,
      parts: parts.filter((p) => p !== "--project").map(stripEnclosingQuotes),
    };
  }

  function stripEnclosingQuotes(text: string): string {
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
      return text.slice(1, -1);
    }
    return text;
  }

  /** Write a scoped config file, creating it if needed. Project-level writes
   *  require trust; user-level writes don't. The ctx is supplied so the gate
   *  can check it (and report blocks) where the caller's ctx isn't available. */
  async function writeScoped(
    level: "user" | "project",
    mutate: (scoped: DeepPartial<GatekeeperConfig>) => void,
    cwd: string,
    ctx: AnyCtx | undefined,
  ): Promise<void> {
    const trusted = ctx?.isProjectTrusted() ?? currentCtx?.isProjectTrusted() ?? false;
    if (level === "project" && !trusted) {
      const notify = ctx?.ui.notify ?? currentCtx?.ui.notify;
      notify?.(
        "gate › --project writes are blocked until you grant project trust for the repo",
        "warning",
      );
      return;
    }
    const scoped = await readScoped(true, cwd);
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
    addGrant: async (rule: Rule): Promise<void> => {
      const cwd = currentCtx?.cwd ?? process.cwd();
      // The gate decides whether the write is allowed; the caller (decision
      // layer) handles failures so the operator sees them.
      await writeScoped("user", (scoped) => {
        scoped.rules = [...(scoped.rules ?? []), rule];
      }, cwd, undefined);
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
      cwd: currentCtx.cwd,
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
      const { level, parts: clean } = parseCmdArgs(args);

      if (clean[0] === "add" && (clean[1] === "allow" || clean[1] === "deny") && clean[2]) {
        const pattern = clean[2];
        // A bare `*` or `**` matches every argument — a wide-open rule. Warn
        // and require explicit confirmation, but allow it if the operator
        // confirms. The default confirm returns false.
        if (pattern === "*" || pattern === "**") {
          ctx.ui.notify(
            `gate › pattern "${pattern}" matches every argument — this is a wide-open ${clean[1]} rule`,
            "warning",
          );
          const proceed = await ctx.ui.confirm?.(
            `gate › write the ${clean[1]} rule with pattern "${pattern}"?`,
          );
          if (!proceed) {
            ctx.ui.notify(`gate › rule add aborted`, "info");
            return;
          }
        }
        const rule: Rule = { action: clean[1], pattern };
        const toolFlag = clean.indexOf("--tool");
        if (toolFlag !== -1 && clean[toolFlag + 1]) rule.tools = [clean[toolFlag + 1]];
        await writeScoped(level, (scoped) => {
          scoped.rules = [...(scoped.rules ?? []), rule];
        }, ctx.cwd, ctx);
        ctx.ui.notify(`gate › added ${rule.action} rule at ${level} level: ${rule.pattern}`, "info");
        return;
      }

      if (clean[0] === "rm" && clean[1]) {
        const ref = clean[1];
        const rmLevel = ref.startsWith("p") ? "project" : "user";
        const index = (Number(ref.match(/\d+$/)?.[0] ?? 0) || 0) - 1;
        const scoped = await readScoped(true, ctx.cwd);
        const removed = scoped[rmLevel]?.rules?.[index];
        if (!removed) {
          ctx.ui.notify(`gate › no rule ${ref} at ${rmLevel} level`, "warning");
          return;
        }
        const signature = JSON.stringify(removed);
        await writeScoped(rmLevel, (s) => {
          // Remove by deep equality inside the read-modify-write, so a
          // rule added between listing and removal survives.
          const rules = s.rules ?? [];
          const at = rules.findIndex((r) => JSON.stringify(r) === signature);
          s.rules = at === -1 ? rules : rules.filter((_, i) => i !== at);
        }, ctx.cwd, ctx);
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
      const { level, parts: clean } = parseCmdArgs(args);

      if (clean[0] === "set" && clean[1] && clean[2] !== undefined) {
        const [, key, ...rest] = clean;
        const value = rest.join(" ");
        // Validate before writing so a bad value doesn't half-overwrite the file.
        if (key === "log.level" && value !== "user" && value !== "project") {
          ctx.ui.notify(`gate › log.level must be "user" or "project", got "${value}"`, "warning");
          return;
        }
        if (key === "failMode" && value !== "ask" && value !== "block") {
          ctx.ui.notify(`gate › failMode must be "ask" or "block", got "${value}"`, "warning");
          return;
        }
        const parse = (): unknown => {
          if (value === "true" || value === "false") return value === "true";
          if (
            key === "threshold" || key === "stateBudgetChars" || key === "endpoint.timeoutMs" ||
            (key.startsWith("log.") && key !== "log.level")
          ) return Number(value);
          if (
            key === "policy" || key === "failMode" || key === "log.level" ||
            key.startsWith("endpoint.")
          ) return value;
          return Number.isNaN(Number(value)) ? value : Number(value);
        };
        const parsed = parse();
        await writeScoped(level, (scoped) => {
          if (key === "log.level") {
            scoped.log = { ...DEFAULT_CONFIG.log, ...(scoped.log ?? {}), level: value as "user" | "project" };
          } else if (key.startsWith("log.")) {
            scoped.log = { ...DEFAULT_CONFIG.log, ...(scoped.log ?? {}), [key.slice("log.".length)]: parsed as number };
          } else if (key.startsWith("endpoint.")) {
            scoped.endpoint = {
              ...DEFAULT_CONFIG.endpoint,
              ...(scoped.endpoint ?? {}),
              [key.slice("endpoint.".length)]: parsed,
            };
          } else if (key.startsWith("floors.")) {
            scoped.floors = {
              ...DEFAULT_CONFIG.floors,
              ...(scoped.floors ?? {}),
              [key.slice("floors.".length)]: parsed as boolean,
            };
          } else if (key === "stateBudgetChars") {
            scoped.stateBudgetChars = parsed as number;
          } else {
            (scoped as Record<string, unknown>)[key] = parsed;
          }
        }, ctx.cwd, ctx);
        // Redact secrets in the echo so apiKey doesn't leak into notifications
        // (which can persist in TUI history or breadcrumbs).
        const echo = key === "endpoint.apiKey" ? "***" : value;
        ctx.ui.notify(`gate › set ${key} = ${echo} at ${level} level`, "info");
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
