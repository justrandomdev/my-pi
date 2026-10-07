import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig, resolveEndpoints, type GatekeeperConfig } from "./config.js";

describe("config resolution", () => {
  it("defaults to the documented posture", () => {
    expect(DEFAULT_CONFIG.threshold).toBe(0.65);
    expect(DEFAULT_CONFIG.rules).toEqual([{ action: "allow", tools: ["ls", "find"] }]);
    expect(DEFAULT_CONFIG.secrets).toEqual({
      enabled: true,
      autoUpdate: true,
      source: "https://raw.githubusercontent.com/gitleaks/gitleaks/refs/heads/master/config/gitleaks.toml",
    });
    expect(DEFAULT_CONFIG.endpoint.url).toBe("http://localhost:11434/v1/systemone");
    expect(DEFAULT_CONFIG.endpoint.model).toBe("clef-flash");
    expect(DEFAULT_CONFIG.endpoint.timeoutMs).toBe(30_000);
    expect(DEFAULT_CONFIG.failMode).toBe("ask");
    expect(DEFAULT_CONFIG.notify).toBe("always");
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
    expect(config.endpoint.url).toBe("http://localhost:11434/v1/systemone");
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

describe("resolveEndpoints", () => {
  it("falls back to the singular endpoint as a one-member jury", () => {
    expect(resolveEndpoints(DEFAULT_CONFIG)).toEqual([{ name: "clef-flash", ...DEFAULT_CONFIG.endpoint }]);
  });

  it("the endpoints array wins over the singular endpoint when present", () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      endpoints: [
        { name: "hermes", url: "http://a/v1/systemone", model: "m1", timeoutMs: 1000, keepAlive: "" },
        { url: "http://b/v1/systemone", model: "m2", timeoutMs: 2000, keepAlive: "10m" },
      ],
    } as GatekeeperConfig;
    expect(resolveEndpoints(config)).toEqual([
      { name: "hermes", url: "http://a/v1/systemone", model: "m1", timeoutMs: 1000, keepAlive: "" },
      { name: "m2", url: "http://b/v1/systemone", model: "m2", timeoutMs: 2000, keepAlive: "10m" },
    ]);
  });

  it("rejects duplicate resolved names", () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      endpoints: [
        { url: "http://a/v1/systemone", model: "same", timeoutMs: 1000, keepAlive: "" },
        { url: "http://b/v1/systemone", model: "same", timeoutMs: 1000, keepAlive: "" },
      ],
    } as GatekeeperConfig;
    expect(() => resolveEndpoints(config)).toThrow(/duplicate endpoint name "same"/);
  });

  it("rejects entries resolving to an empty name", () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      endpoints: [{ name: "   ", url: "http://a/v1/systemone", model: "m", timeoutMs: 1000, keepAlive: "" }],
    } as unknown as GatekeeperConfig;
    expect(() => resolveEndpoints(config)).toThrow(/empty name/);
  });
});
