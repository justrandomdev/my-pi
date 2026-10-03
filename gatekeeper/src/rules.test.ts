import { describe, expect, it } from "vitest";
import { matchRules, protectedPatterns, ruleMatches, type Rule } from "./rules.js";

const HOME = "/home/op";

describe("rule matching", () => {
  it("a tool-only allow rule matches any call of that tool", () => {
    const rule: Rule = { action: "allow", tools: ["ls", "find"] };
    expect(ruleMatches(rule, "ls", { path: "/anything" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "read", { path: "/anything" }, HOME)).toBe(false);
  });

  it("a pattern without a glob matches a file tool target exactly", () => {
    const rule: Rule = { action: "deny", pattern: "~/.zshrc" };
    expect(ruleMatches(rule, "read", { path: "/home/op/.zshrc" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "read", { path: "/home/op/.zshrc.local" }, HOME)).toBe(false);
  });

  it("globs work on file tool targets: * stays within one segment, ** crosses", () => {
    const one: Rule = { action: "deny", pattern: "~/*" };
    expect(ruleMatches(one, "read", { path: "/home/op/.zshrc" }, HOME)).toBe(true);
    expect(ruleMatches(one, "read", { path: "/home/op/.config/a" }, HOME)).toBe(false);
    const deep: Rule = { action: "deny", pattern: "~/**" };
    expect(ruleMatches(deep, "read", { path: "/home/op/.config/a" }, HOME)).toBe(true);
    const tail: Rule = { action: "deny", pattern: "**/.zshrc" };
    expect(ruleMatches(tail, "read", { path: "/home/op/.zshrc" }, HOME)).toBe(true);
  });

  it("shell commands are matched content-wide, with ~ expanded", () => {
    const rule: Rule = { action: "deny", pattern: "~/.zshrc" };
    expect(ruleMatches(rule, "bash", { command: "cat ~/.zshrc" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "node -e \"readFileSync('/home/op/.zshrc')\"" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "cat ~/.zshenv" }, HOME)).toBe(false);
  });

  it("a glob rule searches the shell command text, not just the target", () => {
    const rule: Rule = { action: "deny", pattern: "~/.ssh/**" };
    expect(ruleMatches(rule, "bash", { command: "for f in ~/.ssh/*; do cat $f; done" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "cat ~/notes.txt" }, HOME)).toBe(false);
  });

  it("other tools are matched content-wide over their serialized arguments", () => {
    const rule: Rule = { action: "deny", pattern: "~/.zshrc" };
    expect(ruleMatches(rule, "web_fetch", { urls: ["file:///home/op/.zshrc"] }, HOME)).toBe(true);
    expect(ruleMatches(rule, "web_fetch", { urls: ["https://example.com"] }, HOME)).toBe(false);
  });

  it("matchRules returns the first hit in order", () => {
    const rules: Rule[] = [
      { action: "allow", tools: ["bash"], pattern: "~/work/**" },
      { action: "deny", pattern: "~/work/**" },
    ];
    expect(matchRules(rules, "bash", { command: "ls ~/work/src" }, HOME)?.action).toBe("allow");
    expect(matchRules(rules, "read", { path: "/home/op/work/src/a.ts" }, HOME)?.action).toBe("deny");
  });

  it("no rule matches when the list is empty", () => {
    expect(matchRules([], "bash", { command: "rm -rf /" }, HOME)).toBeUndefined();
  });

  it("protectedPatterns collects deny-rule patterns for state injection", () => {
    const rules: Rule[] = [
      { action: "deny", pattern: "~/.zshrc" },
      { action: "allow", tools: ["ls"] },
      { action: "deny", pattern: "~/.ssh/**" },
    ];
    expect(protectedPatterns(rules)).toEqual(["~/.zshrc", "~/.ssh/**"]);
  });
});
