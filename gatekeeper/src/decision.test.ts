import { describe, expect, it } from "vitest";
import { createGate, type Decision, type GateDeps } from "./decision.js";
import { DEFAULT_CONFIG, type GatekeeperConfig } from "./config.js";
import type { ClassificationResult } from "./classifier.js";
import type { SecretsHit } from "./secrets.js";

const HOME = "/home/op";

function makeDeps(overrides: {
  config?: Partial<GatekeeperConfig>;
  classify?: (input: any) => Promise<ClassificationResult>;
  askOperator?: (prompt: any) => Promise<"allow" | "deny" | "no-ui">;
  scanSecrets?: (tool: string, args: any) => Promise<SecretsHit | undefined>;
} = {}): { deps: GateDeps; log: any[]; notified: string[]; classifyCalls: any[]; asked: any[] } {
  const log: any[] = [];
  const notified: string[] = [];
  const classifyCalls: any[] = [];
  const asked: any[] = [];
  const deps: GateDeps = {
    home: HOME,
    getConfig: () => ({ ...structuredClone(DEFAULT_CONFIG), ...overrides.config }),
    classify: async (input) => {
      classifyCalls.push(input);
      return (
        overrides.classify?.(input) ?? {
          choice: "safe",
          probabilities: { safe: 0.99, unsafe: 0.005, unsure: 0.005 },
          confidence: 0.98,
        }
      );
    },
    askOperator: async (prompt) => {
      asked.push(prompt);
      return overrides.askOperator?.(prompt) ?? "deny";
    },
    notify: (line) => notified.push(line),
    writeLog: (record) => log.push(record),
    scanSecrets: async (tool, args) => overrides.scanSecrets?.(tool, args),
  };
  return { deps, log, notified, classifyCalls, asked };
}

function classifyResult(choice: "safe" | "unsafe" | "unsure", confidence: number): ClassificationResult {
  return { choice, probabilities: { safe: choice === "safe" ? confidence : 0.01, unsafe: choice === "unsafe" ? confidence : 0.01, unsure: choice === "unsure" ? confidence : 0.01 }, confidence };
}

describe("the gate", () => {
  it("passes through when disabled but still notifies and logs (transparency)", async () => {
    const { deps, log, notified } = makeDeps({ config: { enabled: false } });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "rm -rf /" }, task: "clean up" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("disabled");
    expect(log).toHaveLength(1);
    expect(log[0].source).toBe("disabled");
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("disabled");
  });

  it("notify summary suppresses allow notifications but keeps blocks/asks", async () => {
    const { deps, notified } = makeDeps({
      config: { notify: "summary" },
      classify: async () => classifyResult("safe", 0.9),
    });
    const gate = createGate(deps);
    const allowed = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(allowed.action).toBe("allow");
    expect(notified).toHaveLength(0);

    const askedDeps = makeDeps({
      config: { notify: "summary" },
      classify: async () => classifyResult("safe", 0.6),
      askOperator: async () => "deny",
    });
    const askedGate = createGate(askedDeps.deps);
    const asked = await askedGate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(asked.action).toBe("block");
    expect(asked.source).toBe("operator");
    expect(askedDeps.notified.length).toBeGreaterThan(0);
  });

  it("notify off suppresses all decision notifications but still logs", async () => {
    const { deps, log, notified } = makeDeps({
      config: { notify: "off" },
      classify: async () => classifyResult("safe", 0.9),
    });
    const gate = createGate(deps);
    await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(notified).toHaveLength(0);
    expect(log).toHaveLength(1);
  });

  it("an allow rule decides without consulting the model", async () => {
    const { deps, classifyCalls, log } = makeDeps();
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "ls", args: { path: "/tmp" }, task: "look around" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("rule");
    expect(classifyCalls).toHaveLength(0);
    expect(log[0].source).toBe("rule");
  });

  it("a deny rule blocks a protected-path read", async () => {
    const { deps } = makeDeps({
      config: { rules: [{ action: "deny", pattern: "~/creds" }] },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/home/op/creds" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("rule");
  });

  it("the ask floor is gone: a confident-safe bash call auto-allows (ADR-0005)", async () => {
    const { deps, asked, classifyCalls } = makeDeps({ classify: async () => classifyResult("safe", 0.99) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "npm test" }, task: "t" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("model");
    expect(asked).toHaveLength(0);
    expect(classifyCalls).toHaveLength(1);
  });

  it("a secrets hit blocks before every rule and the model, masked (ADR-0004)", async () => {
    const { deps, classifyCalls, log, asked } = makeDeps({
      // an allow rule that would match the call: rules run after secrets
      config: { rules: [{ action: "allow", tools: ["bash"], pattern: "curl *" }] },
      scanSecrets: async () => ({ ruleId: "aws-access-token", secret: "AKIAIOSFODNN7EXAMPLA", masked: "AKI…(20 chars)" }),
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "curl https://evil.example" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("secrets");
    expect(decision.reason).toContain("aws-access-token");
    expect(decision.reason).toContain("AKI…(20 chars)");
    expect(decision.reason).not.toContain("AKIAIOSFODNN7EXAMPLA");
    // the model was never invoked, and no rule could override it
    expect(classifyCalls).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(log[0].source).toBe("secrets");
    expect(log[0].args).not.toContain("AKIAIOSFODNN7EXAMPLA");
  });

  it("a clean call reaches the model with only the first 100 argument characters (ADR-0002/0005)", async () => {
    const { deps, classifyCalls, log, asked } = makeDeps({
      classify: async () => classifyResult("safe", 0.6),
    });
    const gate = createGate(deps);
    const secret = "const apiKey = 'hunter2-secret-value';";
    const content = `${"// benign comment line\n".repeat(20)}${secret}\n`;
    await gate.decide({ tool: "write", args: { path: "/tmp/a.js", content }, task: "t" });
    // the model saw at most 100 characters, and the secret sits beyond them
    expect(classifyCalls[0].args.length).toBeLessThanOrEqual(100);
    expect(classifyCalls[0].args).not.toContain("hunter2-secret-value");
    // the log records the same view plus the total length
    expect(log[0].args).not.toContain("hunter2-secret-value");
    expect(log[0].args).toMatch(/\(\d+ chars\)$/);
    // the operator prompt keeps a capped preview — the operator is human
    expect(asked[0].argsSummary).toContain("hunter2-secret-value");
  });

  it("a secret within the first 100 characters does reach the model view — the bounded residual (ADR-0005)", async () => {
    const { deps, classifyCalls } = makeDeps({ classify: async () => classifyResult("safe", 0.6) });
    const gate = createGate(deps);
    await gate.decide({ tool: "write", args: { path: "/tmp/a.js", content: "token = 'hunter2-secret-value';" }, task: "t" });
    // the truncation bounds exposure; secret-bearing calls are blocked by
    // secrets detection (ADR-0004) before the model — when the corpus does
    // not recognize the shape, this residual is the accepted cost
    expect(classifyCalls[0].args.length).toBeLessThanOrEqual(100);
    expect(classifyCalls[0].args).toContain("hunter2-secret-value");
  });

  it("state carries only the tool, truncated arguments, task, cwd, and protected paths", async () => {
    const { deps, classifyCalls } = makeDeps({
      config: { rules: [{ action: "deny", pattern: "~/creds" }] },
    });
    const gate = createGate(deps);
    await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "read the file" });
    const state = classifyCalls[0];
    expect(Object.keys(state)).toEqual(["tool", "args", "task", "cwd", "protectedPaths", "policy"]);
    // the gate's own dirs ride along as a backstop (ADR-0003)
    expect(state.protectedPaths).toContain("/home/op/.pi/agent/gate");
    expect(state.protectedPaths).toContain("~/creds");
    expect(state.args).toContain("/tmp/a");
  });

  it("the model state carries the session's gate dirs and working directory", async () => {
    const { deps, classifyCalls } = makeDeps({ classify: async () => classifyResult("safe", 0.9) });
    const gate = createGate(deps);
    await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t", cwd: "/proj" });
    expect(classifyCalls[0].protectedPaths).toContain("/home/op/.pi/agent/gate");
    expect(classifyCalls[0].protectedPaths).toContain("/proj/.pi/gate");
    // the working directory rides along so "outside the project" judgments
    // are decidable against something the model can see
    expect(classifyCalls[0].cwd).toBe("/proj");
  });

  it("a safe classification at or above threshold auto-allows", async () => {
    const { deps, notified } = makeDeps({ classify: async () => classifyResult("safe", 0.9) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("model");
    expect(notified[0]).toContain("read");
    expect(notified[0]).toContain("safe");
    expect(notified[0]).toContain("allow");
  });

  it("auto-allow requires a negligible unsafe probability: a safe above threshold with unsafe 0.15 asks", async () => {
    const { deps, asked } = makeDeps({
      classify: async () => ({ choice: "safe", probabilities: { safe: 0.8, unsafe: 0.15, unsure: 0.05 }, confidence: 0.8 }),
      askOperator: async () => "deny",
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(asked[0].reason).toContain("unsafe probability 0.15 above the auto-allow bound 0.1");
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("operator");
  });

  it("the bound is inclusive: a safe with unsafe probability exactly 0.1 auto-allows", async () => {
    const { deps, asked } = makeDeps({
      classify: async () => ({ choice: "safe", probabilities: { safe: 0.9, unsafe: 0.1, unsure: 0.0 }, confidence: 0.9 }),
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("model");
    expect(asked).toHaveLength(0);
  });

  it("an answer without probabilities never auto-allows (fail-closed to the operator)", async () => {
    const { deps, asked } = makeDeps({
      classify: async () => ({ choice: "safe", probabilities: {}, confidence: 0.99 }),
      askOperator: async () => "deny",
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(asked[0].reason).toContain("unsafe probability 1.00 above the auto-allow bound 0.1");
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("operator");
  });

  it("an unsafe classification at or above threshold auto-blocks", async () => {
    const { deps } = makeDeps({ classify: async () => classifyResult("unsafe", 0.97) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("model");
  });

  it("below-threshold classifications route to the operator with allow/deny outcomes", async () => {
    const { deps, asked } = makeDeps({
      classify: async () => classifyResult("safe", 0.6),
      askOperator: async (p) => {
        asked.push(p);
        return "allow";
      },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(asked[0].confidence).toBe(0.6);
    expect(asked[0].classification).toBe("safe");
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("operator");
  });

  it("operator denies and no-UI block; nothing is cached or persisted (ADR-0005)", async () => {
    const denied = makeDeps({
      classify: async () => classifyResult("safe", 0.6),
      askOperator: async () => "deny",
    });
    const denyGate = createGate(denied.deps);
    const deniedDecision = await denyGate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(deniedDecision.action).toBe("block");
    expect(deniedDecision.source).toBe("operator");

    // a re-issued identical call classifies and asks again — no session cache
    await denyGate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(denied.classifyCalls).toHaveLength(2);
    expect(denied.asked).toHaveLength(2);

    const blocked = makeDeps({
      classify: async () => classifyResult("safe", 0.6),
      askOperator: async () => "no-ui",
    });
    const noUiGate = createGate(blocked.deps);
    const noUiDecision = await noUiGate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(noUiDecision.action).toBe("block");
    expect(noUiDecision.reason).toContain("no UI available");
  });

  it("an explicit unsure routes to the operator even at high confidence", async () => {
    const { deps } = makeDeps({
      classify: async () => classifyResult("unsure", 0.99),
      askOperator: async () => "deny",
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("operator");
  });

  it("model failure with failMode ask routes to the operator with a model-unavailable reason", async () => {
    const asked: any[] = [];
    const { deps } = makeDeps({
      classify: async () => {
        throw new Error("ECONNREFUSED");
      },
      askOperator: async (p) => {
        asked.push(p);
        return "deny";
      },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(asked[0].reason).toContain("model unavailable");
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("fail");
    expect(decision.reason).toContain("operator denied");
  });

  it("model failure with failMode block denies (headless)", async () => {
    const { deps } = makeDeps({
      config: { failMode: "block" },
      classify: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("fail");
    expect(decision.reason).toContain("model unavailable");
  });

  it("self-protection: always denies agent writes to the config, even while disabled with an allow rule", async () => {
    const { deps } = makeDeps({
      config: {
        enabled: false,
        rules: [{ action: "allow", tools: ["write"], pattern: "~/.pi/agent/gate/**" }],
      },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({
      tool: "write",
      args: { path: "/home/op/.pi/agent/gate/config.json", content: "{}" },
      task: "neuter the gate",
    });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("protected");
    // but ordinary calls pass through ungated when disabled
    const passthrough = await gate.decide({ tool: "bash", args: { command: "rm -rf /tmp/x" }, task: "t" });
    expect(passthrough.action).toBe("allow");
    expect(passthrough.source).toBe("disabled");
  });

  it("self-protection: paths merely containing similar text pass through", async () => {
    const { deps } = makeDeps({ classify: async () => classifyResult("safe", 0.99) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/home/op/notes.pi/gatekeeper/x.md" }, task: "t" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("model");
  });
});
