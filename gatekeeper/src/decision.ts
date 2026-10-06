/**
 * The gate: self-protection, deterministic secrets detection, rules, then
 * the model gate (the primary classifier, ADR-0005), then the operator.
 * See docs/spec.md.
 */

import type { ClassifyInput, Classification, ClassificationResult } from "./classifier.js";
import type { GatekeeperConfig } from "./config.js";
import { gateDirs, matchRules, protectedPatterns, touchesGatePaths, type Rule } from "./rules.js";
import type { SecretsHit } from "./secrets.js";

export type DecisionSource = "disabled" | "protected" | "secrets" | "rule" | "model" | "operator" | "fail";

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
  askOperator(prompt: OperatorPromptInfo): Promise<"allow" | "deny" | "no-ui">;
  notify(line: string): void;
  writeLog(record: LogRecord): void;
  scanSecrets(tool: string, args: Record<string, unknown>): Promise<SecretsHit | undefined>;
}

export interface Gate {
  decide(input: DecideInput): Promise<Decision>;
}

/** The model never sees more than this many argument characters
 *  (ADR-0002/0005). A fixed constant, not a knob — knobs invite tuning a
 *  safety property. */
const MODEL_ARGS_CHARS = 100;

/** Auto-allow requires a negligible probability of harm: the model's
 *  `unsafe` probability must sit at or below this bound. A fixed constant,
 *  not a knob — same reasoning as MODEL_ARGS_CHARS. An answer without
 *  probabilities counts as unmet (fail-closed: the call asks). */
const MAX_UNSAFE_PROBABILITY = 0.1;

function cap(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}…`;
}

export function createGate(deps: GateDeps): Gate {
  return {
    async decide({ tool, args, task, cwd }: DecideInput): Promise<Decision> {
      const config = deps.getConfig();

      const raw = JSON.stringify(args ?? {});
      // The operator prompt keeps a capped preview — the operator is human.
      // The model and the log see only the first 100 characters.
      const argsSummary = cap(raw, config.log.truncateArgsBytes);
      const modelArgs = raw.slice(0, MODEL_ARGS_CHARS);
      const logArgs = raw.length > MODEL_ARGS_CHARS ? `${modelArgs}… (${raw.length} chars)` : modelArgs;

      const finish = (decision: Decision): Decision => {
        const label =
          decision.classification !== undefined
            ? `${decision.classification}${decision.confidence !== undefined ? ` (${decision.confidence.toFixed(2)})` : ""}`
            : decision.source;
        // The notify knob: `off` skips every notification; `summary` keeps
        // blocks/asks and skips allows; `always` notifies every decision
        // (`debug` behaves like `always` here — the request/answer dump is
        // wired at the classifier).
        const skipNotify =
          config.notify === "off" || (config.notify === "summary" && decision.action === "allow");
        if (!skipNotify) {
          deps.notify(`gate › ${tool}: ${label} → ${decision.action === "allow" ? "allowed" : "blocked"} (${decision.source})`);
        }
        // A secrets hit can put the matched text inside the first 100
        // characters of the serialized args — exactly the view logArgs
        // captures — so logging it verbatim would copy the secret into
        // the decision log. The masked peek already rides in `reason`;
        // the args column becomes a constant for secrets decisions.
        // Other sources never carry their trigger inside the args view.
        const loggedArgs = decision.source === "secrets" ? "<blocked: secrets>" : logArgs;
        deps.writeLog({
          tool,
          args: loggedArgs,
          action: decision.action,
          source: decision.source,
          classification: decision.classification,
          confidence: decision.confidence,
          probabilities: decision.probabilities,
          reason: decision.reason,
        });
        return decision;
      };

      // Self-protection (ADR-0003): before the enabled check and every
      // layer, overridable by none — it holds even while the gate is
      // disabled, so a disabled gate cannot be used as a door.
      if (await touchesGatePaths(tool, args, deps.home, cwd)) {
        return finish({
          action: "block",
          source: "protected",
          reason:
            "the gate protects its own configuration, log, and secrets definitions; agent tool calls touching them are always denied. The operator configures the gate with /gate commands or a manual edit.",
        });
      }

      if (!config.enabled) {
        return finish({
          action: "allow",
          source: "disabled",
          reason: "gate is disabled; pass-through without detection, classification, or operator review",
        });
      }

      // Secrets detection (ADR-0004): deterministic, before every rule and
      // the model. A hit blocks; only the operator's override file
      // (secrets.toml) suppresses it — no rule, no model, no prompt.
      const hit = await deps.scanSecrets(tool, args);
      if (hit) {
        return finish({
          action: "block",
          source: "secrets",
          reason: `possible secret (${hit.ruleId}): ${hit.masked}; blocked before every rule and the model. False positive? Suppress it in ~/.pi/agent/gate/secrets.toml ([[allow]]) — see /gate:secrets.`,
        });
      }

      // Rules: a first-match fast-path for the obvious and the operator's
      // explicit intent (ADR-0005).
      const rule = matchRules(config.rules, tool, args, deps.home, cwd);
      if (rule) {
        return finish({
          action: rule.action === "allow" ? "allow" : "block",
          source: "rule",
          reason: rule.reason ?? (rule.pattern ? `matched ${rule.action} rule: ${rule.pattern}` : `${rule.action} rule for ${rule.tools?.join(", ") ?? "any tool"}`),
        });
      }

      // The model gate: the primary classifier (ADR-0005).
      let classification: ClassificationResult | undefined;
      let failure: string | undefined;
      try {
        classification = await deps.classify({
          tool,
          args: modelArgs,
          task: cap(task, config.stateBudgetChars),
          // The working directory rides along so "writes outside the project"
          // in the policy is decidable; the gate's own dirs ride along as a
          // backstop for obfuscated spellings that slip past the layers above.
          cwd,
          protectedPaths: [...gateDirs(deps.home, cwd), ...protectedPatterns(config.rules)],
          policy: config.policy,
        });
      } catch (error) {
        failure = `model unavailable: ${(error as Error).message}`;
      }

      if (!failure) {
        const c = classification!;
        // Auto-allow requires negligible harm risk: confidence at or above
        // the threshold AND an unsafe probability at or below the fixed
        // bound — a concentrated `safe` with non-negligible unsafe mass
        // asks. Missing probabilities count as unmet.
        const confidentSafe =
          c.choice === "safe" &&
          c.confidence >= config.threshold &&
          (c.probabilities.unsafe ?? 1) <= MAX_UNSAFE_PROBABILITY;
        const confidentUnsafe = c.choice === "unsafe" && c.confidence >= config.threshold;

        if (confidentUnsafe) {
          return finish({ action: "block", source: "model", reason: `classified unsafe (${c.confidence.toFixed(2)})`, classification: c.choice, confidence: c.confidence, probabilities: c.probabilities });
        }
        if (confidentSafe) {
          return finish({ action: "allow", source: "model", reason: `classified safe (${c.confidence.toFixed(2)})`, classification: c.choice, confidence: c.confidence, probabilities: c.probabilities });
        }
      } else if (config.failMode === "block") {
        return finish({ action: "block", source: "fail", reason: failure });
      }

      // Everything the model cannot settle goes to the operator: allow or
      // deny, nothing persisted (ADR-0005).
      const reason =
        failure ??
        (classification!.choice === "unsure"
          ? `model unsure (${classification!.confidence.toFixed(2)})`
          : classification!.confidence < config.threshold
            ? `confidence ${classification!.confidence.toFixed(2)} below threshold ${config.threshold}`
            : `unsafe probability ${(classification!.probabilities.unsafe ?? 1).toFixed(2)} above the auto-allow bound ${MAX_UNSAFE_PROBABILITY}`);

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
        return finish({ action: "block", source: cause, reason: `${reason}; no UI available to confirm` });
      }
      if (outcome === "deny") {
        return finish({ action: "block", source: cause, reason: `${reason}; operator denied` });
      }
      return finish({ action: "allow", source: cause, reason: `${reason}; operator allowed` });
    },
  };
}
