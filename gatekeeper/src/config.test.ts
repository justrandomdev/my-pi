import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "./config.js";

describe("config resolution", () => {
  it("defaults to the documented posture", () => {
    expect(DEFAULT_CONFIG.threshold).toBe(0.85);
    expect(DEFAULT_CONFIG.rules).toEqual([{ action: "allow", tools: ["ls", "find"] }]);
    expect(DEFAULT_CONFIG.floors).toEqual({ bash: true, powershell: true, edit: true, write: true });
    expect(DEFAULT_CONFIG.endpoint.baseUrl).toBe("http://localhost:11434");
    expect(DEFAULT_CONFIG.endpoint.model).toBe("clef-flash");
    expect(DEFAULT_CONFIG.failMode).toBe("ask");
    expect(DEFAULT_CONFIG.log).toEqual({
      level: "user",
      maxLines: 10000,
      keepFiles: 10,
      retentionDays: 30,
      truncateArgsBytes: 2048,
    });
  });

  it("user overrides defaults per key", () => {
    const config = resolveConfig({ user: { threshold: 0.9 } });
    expect(config.threshold).toBe(0.9);
    expect(config.failMode).toBe("ask");
  });

  it("project overrides user per key (ADR-0001)", () => {
    const config = resolveConfig({
      user: { threshold: 0.9, policy: "user policy" },
      project: { threshold: 0.7 },
    });
    expect(config.threshold).toBe(0.7);
    expect(config.policy).toBe("user policy");
  });

  it("nested objects merge per key", () => {
    const config = resolveConfig({
      user: { endpoint: { timeoutMs: 1000 } },
      project: { endpoint: { model: "clef" } },
    });
    expect(config.endpoint.model).toBe("clef");
    expect(config.endpoint.timeoutMs).toBe(1000);
    expect(config.endpoint.baseUrl).toBe("http://localhost:11434");
  });

  it("project rules evaluate before user rules (ADR-0001)", () => {
    const config = resolveConfig({
      user: { rules: [{ action: "deny", pattern: "~/work/**" }] },
      project: { rules: [{ action: "allow", tools: ["bash"], pattern: "~/work/**" }] },
    });
    expect(config.rules[0]).toEqual({ action: "allow", tools: ["bash"], pattern: "~/work/**" });
    expect(config.rules[1]).toEqual({ action: "deny", pattern: "~/work/**" });
    // shipped defaults survive, after the scoped rules
    expect(config.rules[2]).toEqual({ action: "allow", tools: ["ls", "find"] });
  });

  it("defaults survive when no scoped config exists", () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });
});
