/**
 * The gate: rules first, then the session cache, then the model gate
 * (matrix + ask floors), then the operator. See docs/spec.md.
 */

import type { ClassifyInput, Classification, ClassificationResult } from "./classifier.js";
import type { GatekeeperConfig } from "./config.js";
import { grantPattern, matchRules, protectedPatterns, touchesGatePaths, type Rule } from "./rules.js";

export type DecisionSource = "disabled" | "protected" | "rule" | "model" | "operator" | "cache" | "fail";

export interface Decision {
  action: "allow" | "block";
  source: DecisionSource;
  reason?: string;
  classification?: Classification;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface LogRecord {
  tool: string;
  args: string;
  action: "allow" | "block";
  source: DecisionSource;
  classification?: Classification;
  confidence?: number;
  probabilities?: Record<string, number>;
  reason?: string;
}

export interface OperatorPromptInfo {
  tool: string;
  argsSummary: string;
  classification?: Classification;
  confidence?: number;
  probabilities?: Record<string, number>;
  /** Why this call reached the operator. */
  reason: string;
}

export interface DecideInput {
  tool: string;
  args: Record<string, unknown>;
  task: string;
  /** Working directory, for project-level gate paths. */
  cwd?: string;
}

export interface GateDeps {
  home: string;
  getConfig(): GatekeeperConfig;
  classify(input: ClassifyInput): Promise<ClassificationResult>;
  askOperator(prompt: OperatorPromptInfo): Promise<"allow-once" | "allow-always" | "deny" | "no-ui">;
  notify(line: string): void;
  writeLog(record: LogRecord): void;
  addGrant(rule: Rule): void;
}

export interface Gate {
  decide(input: DecideInput): Promise<Decision>;
}

function cap(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}…`;
}

export function createGate(deps: GateDeps): Gate {
  const sessionCache = new Map<string, Decision>();

  return {
    async decide({ tool, args, task, cwd }: DecideInput): Promise<Decision> {
      const config = deps.getConfig();
      if (!config.enabled) return { action: "allow", source: "disabled" };

      const argsSummary = cap(JSON.stringify(args ?? {}), config.log.truncateArgsBytes);

      // Self-protection (ADR-0003): before every rule, overridable by none.
      const cacheKey = config.cache ? `${tool}||${JSON.stringify(args)}||${task}` : "";

      const finish = (decision: Decision): Decision => {
        const label =
          decision.classification !== undefined
            ? `${decision.classification}${decision.confidence !== undefined ? ` (${decision.confidence.toFixed(2)})` : ""}`
            : decision.source;
        deps.notify(`gate › ${tool}: ${label} → ${decision.action === "allow" ? "allowed" : "blocked"} (${decision.source})`);
        deps.writeLog({
          tool,
          args: argsSummary,
          action: decision.action,
          source: decision.source,
          classification: decision.classification,
          confidence: decision.confidence,
          probabilities: decision.probabilities,
          reason: decision.reason,
        });
        return decision;
      };

      // Self-protection (ADR-0003): before every rule, overridable by none.
      if (touchesGatePaths(tool, args, deps.home, cwd)) {
        return finish({
          action: "block",
          source: "protected",
          reason:
            "the gate protects its own configuration and log; agent tool calls touching them are always denied. The operator configures the gate with /gate commands or a manual edit.",
        });
      }

      // Layer 1: static rules. First hit wins; no model call.
      const rule = matchRules(config.rules, tool, args, deps.home);
      if (rule) {
        return finish({
          action: rule.action === "allow" ? "allow" : "block",
          source: "rule",
          reason: rule.reason ?? (rule.pattern ? `matched ${rule.action} rule: ${rule.pattern}` : `${rule.action} rule for ${rule.tools?.join(", ") ?? "any tool"}`),
        });
      }

      // Layer 2: session cache. Identical call in the same task reuses the decision.
      if (config.cache && sessionCache.has(cacheKey)) {
        return finish({ ...sessionCache.get(cacheKey)!, source: "cache" });
      }

      // Layer 3+ decisions are cacheable; rule hits are not (they never re-classify).
      const settle = (decision: Decision): Decision => {
        if (config.cache) sessionCache.set(cacheKey, decision);
        return finish(decision);
      };

      // Layer 3: the model gate.
      let classification: ClassificationResult | undefined;
      let failure: string | undefined;
      try {
        classification = await deps.classify({
          tool,
          args: cap(JSON.stringify(args ?? {}), config.stateBudgetChars),
          task: cap(task, config.stateBudgetChars),
          protectedPaths: protectedPatterns(config.rules),
          policy: config.policy,
        });
      } catch (error) {
        failure = `model unavailable: ${(error as Error).message}`;
      }

      const askFloor = config.floors[tool] === true;

      if (!failure) {
        const c = classification!;
        const confidentSafe = c.choice === "safe" && c.confidence >= config.threshold;
        const confidentUnsafe = c.choice === "unsafe" && c.confidence >= config.threshold;

        if (confidentUnsafe) {
          return settle({ action: "block", source: "model", reason: `classified unsafe (${c.confidence.toFixed(2)})`, classification: c.choice, confidence: c.confidence, probabilities: c.probabilities });
        }
        if (!askFloor && confidentSafe) {
          return settle({ action: "allow", source: "model", reason: `classified safe (${c.confidence.toFixed(2)})`, classification: c.choice, confidence: c.confidence, probabilities: c.probabilities });
        }
      } else if (config.failMode === "block") {
        return settle({ action: "block", source: "fail", reason: failure });
      }

      // Everything else routes to the operator.
      const reason =
        failure ??
        (askFloor
          ? `ask floor: ${tool} calls always require operator review (classification ${classification!.choice}, ${classification!.confidence.toFixed(2)})`
          : classification!.choice === "unsure"
            ? `model unsure (${classification!.confidence.toFixed(2)})`
            : `confidence ${classification!.confidence.toFixed(2)} below threshold ${config.threshold}`);

      const outcome = await deps.askOperator({
        tool,
        argsSummary,
        classification: classification?.choice,
        confidence: classification?.confidence,
        probabilities: classification?.probabilities,
        reason,
      });

      const cause: DecisionSource = failure ? "fail" : "operator";
      if (outcome === "no-ui") {
        return settle({ action: "block", source: cause, reason: `${reason}; no UI available to confirm` });
      }
      if (outcome === "deny") {
        return settle({ action: "block", source: cause, reason: `${reason}; operator denied` });
      }

      if (outcome === "allow-always") {
        const pattern = grantPattern(tool, args);
        if (pattern) {
          deps.addGrant({ action: "allow", tools: [tool], pattern });
          return settle({ action: "allow", source: cause, reason: `${reason}; operator granted always: ${pattern}` });
        }
        return settle({ action: "allow", source: cause, reason: `${reason}; operator allowed once (no grant pattern derivable)` });
      }

      return settle({ action: "allow", source: cause, reason: `${reason}; operator allowed once` });
    },
  };
}
