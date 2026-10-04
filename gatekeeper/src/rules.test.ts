import { describe, expect, it } from "vitest";
import { matchRules, protectedPatterns, ruleMatches, touchesGatePaths, type Rule } from "./rules.js";

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

  it("allow rules on shell commands anchor to the command start, with * crossing everything", () => {
    const rule: Rule = { action: "allow", tools: ["bash"], pattern: "ls *" };
    expect(ruleMatches(rule, "bash", { command: "ls /home/op/code && ls /home/op/code/other 2>/dev/null" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "cat notes && ls /a" }, HOME)).toBe(false);
    expect(ruleMatches(rule, "bash", { command: "rm -rf / && ls" }, HOME)).toBe(false);
  });

  it("a leading * opts an allow rule out of anchoring", () => {
    const rule: Rule = { action: "allow", tools: ["bash"], pattern: "*ls*" };
    expect(ruleMatches(rule, "bash", { command: "xargs ls" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "cd /opt && grep x" }, HOME)).toBe(false);
  });

  it("deny rules stay unanchored so they catch exfiltration mid-command", () => {
    const rule: Rule = { action: "deny", pattern: "~/creds" };
    expect(ruleMatches(rule, "bash", { command: "tar czf backup.tgz ~/creds" }, HOME)).toBe(true);
  });

  it("a chained command splits into components; an allow needs every component to match", () => {
    const rule: Rule = { action: "allow", tools: ["bash"], pattern: "ls *" };
    expect(ruleMatches(rule, "bash", { command: "ls /a && ls /b" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "ls /a && rm -rf /b" }, HOME)).toBe(false);
    expect(ruleMatches(rule, "bash", { command: "ls /a | grep x" }, HOME)).toBe(false);
    expect(ruleMatches(rule, "bash", { command: "ls /a & rm -rf /" }, HOME)).toBe(false);
  });

  it("a deny matches if any component of a chain matches", () => {
    const rule: Rule = { action: "deny", pattern: "~/creds" };
    expect(ruleMatches(rule, "bash", { command: "ls /a && cat ~/creds" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "ls /a && cat ~/notes" }, HOME)).toBe(false);
  });

  it("quoted separators are not chain separators", () => {
    const rule: Rule = { action: "allow", tools: ["bash"], pattern: "ls *" };
    expect(ruleMatches(rule, "bash", { command: 'ls "a && b"' }, HOME)).toBe(true);
  });

  it("command substitution defeats an allow rule and falls to the model gate", () => {
    const rule: Rule = { action: "allow", tools: ["bash"], pattern: "ls *" };
    expect(ruleMatches(rule, "bash", { command: "ls $(rm -rf /)" }, HOME)).toBe(false);
    expect(ruleMatches(rule, "bash", { command: "ls `rm -rf /`" }, HOME)).toBe(false);
  });

  it("redirects defeat allow rules, except inert ones to /dev/null and fd duplication", () => {
    const rule: Rule = { action: "allow", tools: ["bash"], pattern: "ls ?*" };
    expect(ruleMatches(rule, "bash", { command: "ls /a && ls /b 2>/dev/null" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "ls /a >/dev/null" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "ls /a 2>&1" }, HOME)).toBe(true);
    expect(ruleMatches(rule, "bash", { command: "ls /a > out.txt" }, HOME)).toBe(false);
    expect(ruleMatches(rule, "bash", { command: "ls /a >> /etc/passwd" }, HOME)).toBe(false);
    expect(ruleMatches(rule, "bash", { command: "ls -la> /etc/passwd" }, HOME)).toBe(false);
    expect(ruleMatches(rule, "bash", { command: "cat notes < ~/.creds" }, HOME)).toBe(false);
  });

  it("self-protection catches env-var and dot-segment path spellings in shell text", () => {
    const touches = (command: string) => touchesGatePaths("bash", { command }, HOME);
    expect(touches("cat $HOME/.pi/agent/gate/config.json")).toBe(true);
    expect(touches("cat ${HOME}/.pi/agent/gate/config.json")).toBe(true);
    expect(touches("cat /home/op/.pi/agent/../agent/gate/config.json")).toBe(true);
    expect(touches("sed -i s/../../ /home/op/.pi/agent/gate/../gate/config.json")).toBe(true);
  });

  it("self-protection catches cd into a gate directory before relative access", () => {
    const touches = (command: string) => touchesGatePaths("bash", { command }, HOME);
    expect(touches("cd ~/.pi/agent/gate && cat config.json")).toBe(true);
    expect(touches("cd /home/op/code && cat notes.md")).toBe(false);
  });

  it("self-protection tracks cwd across a chain of cd commands", () => {
    const touches = (command: string, cwd?: string) => touchesGatePaths("bash", { command }, HOME, cwd);
    // `cd ~` then `cd .pi/agent/gate` lands inside the user-level gate dir.
    expect(touches("cd ~ && cd .pi/agent/gate && cat config.json")).toBe(true);
    // The chain is detected regardless of the original cwd — `cd ~` overrides it.
    expect(touches("cd ~ && cd .pi/agent/gate && cat config.json", "/elsewhere")).toBe(true);
    // An absolute-path cd followed by a relative one resolves against the new cwd,
    // not the original (without cwd tracking the second cd would resolve to
    // /proj/.pi/agent/gate, which isn't a gate dir; with tracking it resolves
    // to /home/op/.pi/agent/gate, which is).
    expect(touches("cd /home/op && cd .pi/agent/gate && cat config.json", "/proj")).toBe(true);
    // The same relative cd from the original cwd, without the chain, lands somewhere
    // else and is harmless.
    expect(touches("cd .pi/agent/gate", "/proj")).toBe(false);
  });

  it("self-protection still ignores look-alike paths", () => {
    const touches = (command: string) => touchesGatePaths("bash", { command }, HOME);
    expect(touches("ls /home/op/notes.pi/gatekeeper")).toBe(false);
    expect(touches("cat $HOME/notes.txt")).toBe(false);
  });

  it("matchRules returns the first hit in order", () => {
    const rules: Rule[] = [
      { action: "allow", tools: ["bash"], pattern: "~/work/**" },
      { action: "deny", pattern: "~/work/**" },
    ];
    expect(matchRules(rules, "bash", { command: "~/work/bin/run --all" }, HOME)?.action).toBe("allow");
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
