import { describe, expect, it, vi } from "vitest";
import { createGate, type Decision, type GateDeps } from "./decision.js";
import { DEFAULT_CONFIG, type GatekeeperConfig } from "./config.js";
import type { ClassificationResult } from "./classifier.js";
import type { Rule } from "./rules.js";

const HOME = "/home/op";

function makeDeps(overrides: {
  config?: Partial<GatekeeperConfig>;
  classify?: (input: any) => Promise<ClassificationResult>;
  askOperator?: (prompt: any) => Promise<"allow-once" | "allow-always" | "deny" | "no-ui">;
} = {}): { deps: GateDeps; log: any[]; notified: string[]; grants: Rule[]; classifyCalls: any[] } {
  const log: any[] = [];
  const notified: string[] = [];
  const grants: Rule[] = [];
  const classifyCalls: any[] = [];
  const deps: GateDeps = {
    home: HOME,
    getConfig: () => ({ ...structuredClone(DEFAULT_CONFIG), ...overrides.config }),
    classify: overrides.classify
      ? async (input) => {
          classifyCalls.push(input);
          return overrides.classify!(input);
        }
      : async (input) => {
          classifyCalls.push(input);
          return { choice: "safe", probabilities: { safe: 0.99, unsafe: 0.005, unsure: 0.005 }, confidence: 0.98 };
        },
    askOperator: overrides.askOperator ?? (async () => "deny"),
    notify: (line) => notified.push(line),
    writeLog: (record) => log.push(record),
    addGrant: (rule) => grants.push(rule),
  };
  return { deps, log, notified, grants, classifyCalls };
}

function classifyResult(choice: "safe" | "unsafe" | "unsure", confidence: number): ClassificationResult {
  return { choice, probabilities: { safe: choice === "safe" ? confidence : 0.01, unsafe: choice === "unsafe" ? confidence : 0.01, unsure: choice === "unsure" ? confidence : 0.01 }, confidence };
}

describe("the gate", () => {
  it("allows everything without logging when disabled", async () => {
    const { deps, log } = makeDeps({ config: { enabled: false } });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "rm -rf /" }, task: "clean up" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("disabled");
    expect(log).toHaveLength(0);
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

  it("a safe classification at or above threshold auto-allows an unfoored read", async () => {
    const { deps, notified } = makeDeps({ classify: async () => classifyResult("safe", 0.9) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("model");
    expect(notified[0]).toContain("read");
    expect(notified[0]).toContain("safe");
    expect(notified[0]).toContain("allow");
  });

  it("an unsafe classification at or above threshold auto-blocks", async () => {
    const { deps } = makeDeps({ classify: async () => classifyResult("unsafe", 0.97) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("model");
  });

  it("below-threshold classifications route to the operator", async () => {
    const asked: any[] = [];
    const { deps } = makeDeps({
      classify: async () => classifyResult("safe", 0.6),
      askOperator: async (p) => {
        asked.push(p);
        return "allow-once";
      },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(asked[0].confidence).toBe(0.6);
    expect(asked[0].classification).toBe("safe");
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("operator");
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

  it("the ask floor stops a safe-classified bash call from auto-allowing", async () => {
    const asked: any[] = [];
    const { deps } = makeDeps({
      classify: async () => classifyResult("safe", 0.99),
      askOperator: async (p) => {
        asked.push(p);
        return "allow-once";
      },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "ls" }, task: "t" });
    expect(asked[0].reason).toContain("ask floor");
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("operator");
  });

  it("a floored tool is auto-blocked when the model is confidently unsafe", async () => {
    const { deps } = makeDeps({ classify: async () => classifyResult("unsafe", 0.97) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "ls" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("model");
  });

  it("allow-always writes a grant rule scoped to the call's pattern", async () => {
    const { deps, grants } = makeDeps({
      classify: async () => classifyResult("safe", 0.99),
      askOperator: async () => "allow-always",
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "ls ~/work" }, task: "t" });
    expect(decision.action).toBe("allow");
    expect(grants).toEqual([{ action: "allow", tools: ["bash"], pattern: "ls ~/work" }]);
  });

  it("the session cache short-circuits identical re-issued calls", async () => {
    const { deps, classifyCalls } = makeDeps({ classify: async () => classifyResult("safe", 0.9) });
    const gate = createGate(deps);
    const first = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    const second = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(first.source).toBe("model");
    expect(second.action).toBe("allow");
    expect(second.source).toBe("cache");
    expect(classifyCalls).toHaveLength(1);
  });

  it("a different task does not reuse the cache", async () => {
    const { deps, classifyCalls } = makeDeps({ classify: async () => classifyResult("safe", 0.9) });
    const gate = createGate(deps);
    await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t1" });
    await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t2" });
    expect(classifyCalls).toHaveLength(2);
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
  });

  it("model failure with failMode block blocks without asking", async () => {
    const asked = vi.fn();
    const { deps } = makeDeps({
      config: { failMode: "block" },
      classify: async () => {
        throw new Error("timeout");
      },
      askOperator: async () => {
        asked();
        return "allow-once";
      },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("fail");
    expect(asked).not.toHaveBeenCalled();
  });

  it("no UI to confirm blocks rather than opening the gate", async () => {
    const { deps } = makeDeps({
      classify: async () => classifyResult("safe", 0.6),
      askOperator: async () => "no-ui",
    });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "t" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("operator");
  });

  it("state carries only the tool, arguments, task, and protected paths", async () => {
    const { deps, classifyCalls } = makeDeps({
      config: { rules: [{ action: "deny", pattern: "~/creds" }] },
    });
    const gate = createGate(deps);
    await gate.decide({ tool: "read", args: { path: "/tmp/a" }, task: "read the file" });
    const state = classifyCalls[0];
    expect(Object.keys(state)).toEqual(["tool", "args", "task", "protectedPaths", "policy"]);
    expect(state.protectedPaths).toEqual(["~/creds"]);
    expect(state.args).toContain("/tmp/a");
  });

  it("self-protection: always denies agent writes to the config, even with an allow rule", async () => {
    const { deps } = makeDeps({
      config: { rules: [{ action: "allow", tools: ["write"], pattern: "~/.pi/agent/gate/**" }] },
    });
    const gate = createGate(deps);
    const decision = await gate.decide({
      tool: "write",
      args: { path: "/home/op/.pi/agent/gate/config.json", content: "{}" },
      task: "disable the gate",
    });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("protected");
    expect(decision.reason).toContain("protect");
  });

  it("self-protection: denies reads of the config and decision log", async () => {
    const { deps } = makeDeps();
    const gate = createGate(deps);
    for (const path of ["/home/op/.pi/agent/gate/config.json", "/home/op/.pi/agent/gate/decisions.jsonl.1"]) {
      const decision = await gate.decide({ tool: "read", args: { path }, task: "t" });
      expect(decision.action).toBe("block");
      expect(decision.source).toBe("protected");
    }
  });

  it("self-protection: denies bash commands touching gate paths without consulting the model", async () => {
    const { deps, classifyCalls } = makeDeps({ classify: async () => classifyResult("safe", 0.99) });
    const gate = createGate(deps);
    for (const command of [
      "echo {} > /home/op/.pi/agent/gate/config.json",
      "rm /home/op/.pi/agent/gate/decisions.jsonl",
      "cat ~/.pi/agent/gate/config.json",
    ]) {
      const decision = await gate.decide({ tool: "bash", args: { command }, task: "t" });
      expect(decision.action).toBe("block");
      expect(decision.source).toBe("protected");
    }
    expect(classifyCalls).toHaveLength(0);
  });

  it("self-protection: denies relative project gate paths", async () => {
    const { deps } = makeDeps();
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "bash", args: { command: "cat .pi/gate/config.json" }, task: "t", cwd: "/proj" });
    expect(decision.action).toBe("block");
    expect(decision.source).toBe("protected");
  });

  it("self-protection: paths merely containing similar text pass through", async () => {
    const { deps } = makeDeps({ classify: async () => classifyResult("safe", 0.99) });
    const gate = createGate(deps);
    const decision = await gate.decide({ tool: "read", args: { path: "/home/op/notes.pi/gatekeeper/x.md" }, task: "t" });
    expect(decision.action).toBe("allow");
    expect(decision.source).toBe("model");
  });

  it("huge arguments are capped by the state budget", async () => {
    const { deps, classifyCalls } = makeDeps();
    const gate = createGate(deps);
    const huge = { path: "/tmp/a", content: "x".repeat(50000) };
    await gate.decide({ tool: "write", args: huge, task: "t" });
    expect(classifyCalls[0].args.length).toBeLessThanOrEqual(4100);
  });
});
