import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatekeeper } from "./index.js";

const HOME = "/home/op";

let userHome: string; // stand-in home for config/log paths
let projectDir: string;

beforeEach(async () => {
  userHome = await mkdtemp(join(tmpdir(), "gk-home-"));
  projectDir = await mkdtemp(join(tmpdir(), "gk-proj-"));
});
afterEach(async () => {
  await rm(userHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

interface Captured {
  events: Map<string, ((event: any, ctx: any) => any)[]>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>;
}

function fakePi(): { pi: any; captured: Captured } {
  const captured: Captured = { events: new Map(), commands: new Map() };
  const pi: any = {
    on: (name: string, handler: (event: any, ctx: any) => any) => {
      if (!captured.events.has(name)) captured.events.set(name, []);
      captured.events.get(name)!.push(handler);
    },
    registerCommand: (name: string, options: any) => {
      captured.commands.set(name, options);
    },
  };
  return { pi, captured };
}

/** A stubbed System One endpoint + recording ui + fake context. */
function makeEnv(canned: { choice: "safe" | "unsafe" | "unsure"; confidence: number } = { choice: "safe", confidence: 0.99 }) {
  const requests: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          safety: {
            type: "choice",
            choice: canned.choice,
            probabilities: { safe: 0.01, unsafe: 0.01, unsure: 0.01, [canned.choice]: canned.confidence },
            confidence: canned.confidence,
          },
        },
      }),
    } as Response;
  }) as typeof fetch;

  const ui = {
    notified: [] as string[],
    selected: [] as { title: string; options: string[] }[],
    custom: undefined as unknown as ((factory: any) => Promise<any>) | undefined,
    notify: (message: string) => ui.notified.push(message),
    select: async (title: string, options: string[]): Promise<string | undefined> => {
      ui.selected.push({ title, options });
      return "Deny";
    },
    confirm: async () => false,
    input: async () => undefined,
  };
  const ctx = (over: Record<string, unknown> = {}) => ({
    ui,
    hasUI: true,
    cwd: projectDir,
    isProjectTrusted: () => false,
    mode: "tui",
    ...over,
  });
  return { requests, fetchFn, ui, ctx };
}

async function runToolCall(captured: Captured, env: ReturnType<typeof makeEnv>, event: any, ctxOverride: Record<string, unknown> = {}) {
  const handler = captured.events.get("tool_call")![0];
  return handler(event, env.ctx(ctxOverride));
}

async function setup(
  canned?: { choice: "safe" | "unsafe" | "unsure"; confidence: number },
  fetchOverride?: typeof fetch,
) {
  const { pi, captured } = fakePi();
  const env = makeEnv(canned);
  createGatekeeper(pi, { home: userHome, fetchFn: fetchOverride ?? env.fetchFn });
  return { captured, env };
}

describe("gatekeeper extension", () => {
  it("registers the tool_call handler and the four commands", () => {
    const { pi, captured } = fakePi();
    createGatekeeper(pi, { home: userHome });
    expect(captured.events.has("tool_call")).toBe(true);
    expect([...captured.commands.keys()].sort()).toEqual(["gate", "gate:config", "gate:log", "gate:rules"]);
  });

  it("an allow rule passes ls through without consulting the model", async () => {
    const { captured, env } = await setup();
    const result = await runToolCall(captured, env, { type: "tool_call", toolName: "ls", input: { path: "/tmp" } });
    expect(result).toBeUndefined();
    expect(env.requests).toHaveLength(0);
  });

  it("a confident safe read auto-allows with a transparency line", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.9 });
    const result = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: "/tmp/a" } });
    expect(result).toBeUndefined();
    expect(env.ui.notified[0]).toContain("read");
    expect(env.ui.notified[0]).toContain("safe (0.90)");
  });

  it("a confident unsafe classification blocks with a reason", async () => {
    const { captured, env } = await setup({ choice: "unsafe", confidence: 0.97 });
    const result = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: "/etc/passwd" } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("unsafe");
  });

  it("a floored bash call asks the operator even when classified safe", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.99 });
    const result = await runToolCall(captured, env, { type: "tool_call", toolName: "bash", input: { command: "ls ~/work" } });
    expect(env.ui.selected).toHaveLength(1);
    expect(env.ui.selected[0].options).toEqual(["Allow once", "Allow for session", "Allow always", "Deny"]);
    expect(env.ui.selected[0].title).toContain("bash");
    // the stub operator picks Deny
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("operator denied");
  });

  it("uses the custom bordered prompt when the mode provides ui.custom", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.99 });
    let component: any;
    const ctx = env.ctx();
    ctx.ui.custom = (async (factory: any) =>
      new Promise((resolve) => {
        component = factory({}, { fg: (_c: any, t: any) => t, bold: (t: any) => t } as any, {}, resolve);
      })) as any;
    const handler = captured.events.get("tool_call")![0];
    const pending = handler({ type: "tool_call", toolName: "bash", input: { command: "ls ~/work" } }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    // the component renders a bordered box
    const lines = component.render(80) as string[];
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines[lines.length - 1].endsWith("╯")).toBe(true);
    // pressing a settles the dialog; allow-always writes the grant
    component.handleInput("a");
    const result = await pending;
    expect(result).toBeUndefined();
    expect(env.ui.selected).toHaveLength(0); // the selector was not used
    // the grant write is fire-and-forget; poll until it lands
    const configPath = join(userHome, ".pi/agent/gate/config.json");
    let rules: any[] = [];
    for (let i = 0; i < 50 && rules.length < 1; i++) {
      try {
        rules = (JSON.parse(await readFile(configPath, "utf8")) ?? {}).rules ?? [];
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(rules).toContainEqual({ action: "allow", tools: ["bash"], pattern: "ls ~/work" });
  });

  it("gate:rules rm removes exactly the listed rule and preserves the rest", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    await mkdir(join(userHome, ".pi/agent/gate"), { recursive: true });
    await writeFile(
      join(userHome, ".pi/agent/gate/config.json"),
      JSON.stringify({
        rules: [
          { action: "deny", pattern: "~/creds" },
          { action: "allow", tools: ["bash"], pattern: "ls ?*" },
        ],
      }),
    );
    const handler = captured.commands.get("gate:rules")!.handler;
    const ctx = env.ctx();
    await handler("rm u1", ctx);
    const after = JSON.parse(await readFile(join(userHome, ".pi/agent/gate/config.json"), "utf8"));
    expect(after.rules).toEqual([{ action: "allow", tools: ["bash"], pattern: "ls ?*" }]);
    // removing a rule that does not exist reports and changes nothing
    await handler("rm u9", ctx);
    expect(env.ui.notified.some((n) => n.includes("no rule"))).toBe(true);
    const unchanged = JSON.parse(await readFile(join(userHome, ".pi/agent/gate/config.json"), "utf8"));
    expect(unchanged.rules).toEqual([{ action: "allow", tools: ["bash"], pattern: "ls ?*" }]);
  });

  it("a dismissed operator dialog denies", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.99 });
    env.ui.select = async (): Promise<string | undefined> => undefined;
    const result = await runToolCall(captured, env, { type: "tool_call", toolName: "bash", input: { command: "ls" } });
    expect(result?.block).toBe(true);
  });

  it("model failure routes to the operator with a model-unavailable reason", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { captured, env } = await setup(undefined, failing);
    const result = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: "/tmp/a" } });
    expect(env.ui.selected).toHaveLength(1);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("model unavailable");
  });

  it("the current task from before_agent_start rides in the model state", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.9 });
    const startHandler = captured.events.get("before_agent_start")![0];
    startHandler({ type: "before_agent_start", prompt: "clean up the tmp folder" }, env.ctx());
    await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: "/tmp/a" } });
    expect(env.requests[0].state.task).toBe("clean up the tmp folder");
  });

  it("every decision lands in the JSONL decision log", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.9 });
    await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: "/tmp/a" } });
    const logPath = join(userHome, ".pi/agent/gate/decisions.jsonl");
    // the log write is fire-and-forget; poll until it lands
    let lines: string[] = [];
    for (let i = 0; i < 50 && lines.length < 1; i++) {
      try {
        lines = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (!lines.length) lines = ["(log never flushed)"];
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.tool).toBe("read");
    expect(record.action).toBe("allow");
    expect(record.source).toBe("model");
    expect(record.ts).toBeTruthy();
  });

  it("a user-level deny rule blocks a protected read without the model", async () => {
    await mkdir(join(userHome, ".pi/agent/gate"), { recursive: true });
    await writeFile(
      join(userHome, ".pi/agent/gate/config.json"),
      JSON.stringify({ rules: [{ action: "deny", pattern: "~/creds" }] }),
    );
    const { captured, env } = await setup();
    const result = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: join(userHome, "creds") } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("deny rule");
    expect(env.requests).toHaveLength(0);
  });

  it("project config overrides the user deny (ADR-0001), trusted projects only", async () => {
    await mkdir(join(userHome, ".pi/agent/gate"), { recursive: true });
    await writeFile(
      join(userHome, ".pi/agent/gate/config.json"),
      JSON.stringify({ rules: [{ action: "deny", pattern: "~/creds" }] }),
    );
    await mkdir(join(projectDir, ".pi/gate"), { recursive: true });
    await writeFile(
      join(projectDir, ".pi/gate/config.json"),
      JSON.stringify({ rules: [{ action: "allow", tools: ["read"], pattern: "~/creds" }] }),
    );
    const { captured, env } = await setup({ choice: "safe", confidence: 0.9 });

    // untrusted project: the user deny stands
    const denied = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: join(userHome, "creds") } });
    expect(denied?.block).toBe(true);

    // trusted project: the project allow overrides the user deny
    const allowed = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: join(userHome, "creds") } }, { isProjectTrusted: () => true });
    expect(allowed).toBeUndefined();
  });

  it("set endpoint.apiKey redacts the value in the notify so the secret doesn't leak", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:config")!.handler;
    const ctx = env.ctx();
    await handler("set endpoint.apiKey super-secret-token", ctx);
    // the value must not appear in any notify
    expect(env.ui.notified.some((n) => n.includes("super-secret-token"))).toBe(false);
    // ...but it does appear as "***" in the success line
    expect(env.ui.notified.some((n) => n.includes("endpoint.apiKey = ***"))).toBe(true);
    // ...and the actual value landed in the config file
    const cfg = JSON.parse(await readFile(join(userHome, ".pi/agent/gate/config.json"), "utf8"));
    expect(cfg.endpoint.apiKey).toBe("super-secret-token");
  });

  it("set log.maxLines / log.keepFiles / log.retentionDays / log.truncateArgsBytes and stateBudgetChars actually write", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:config")!.handler;
    const ctx = env.ctx();
    for (const args of [
      "set log.maxLines 5000",
      "set log.keepFiles 5",
      "set log.retentionDays 7",
      "set log.truncateArgsBytes 1024",
      "set stateBudgetChars 2000",
    ]) {
      await handler(args, ctx);
    }
    const cfg = JSON.parse(await readFile(join(userHome, ".pi/agent/gate/config.json"), "utf8"));
    expect(cfg.log.maxLines).toBe(5000);
    expect(cfg.log.keepFiles).toBe(5);
    expect(cfg.log.retentionDays).toBe(7);
    expect(cfg.log.truncateArgsBytes).toBe(1024);
    expect(cfg.stateBudgetChars).toBe(2000);
    // and not as stray top-level dotted keys (the bug we fixed)
    expect(cfg["log.maxLines"]).toBeUndefined();
    expect(cfg["log.keepFiles"]).toBeUndefined();
    expect(cfg["log.retentionDays"]).toBeUndefined();
    expect(cfg["log.truncateArgsBytes"]).toBeUndefined();
  });

  it("set log.level rejects values that are not user|project", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:config")!.handler;
    const ctx = env.ctx();
    await handler("set log.level foo", ctx);
    expect(env.ui.notified.some((n) => n.includes("must be"))).toBe(true);
  });

  it("--project writes are blocked when project trust is not granted", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:rules")!.handler;
    const ctx = env.ctx(); // isProjectTrusted: () => false
    await handler("add deny \"~/test\" --project", ctx);
    // the project file should not exist
    const projectCfg = join(projectDir, ".pi/gate/config.json");
    let exists = true;
    try {
      await stat(projectCfg);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    // ...and the operator was warned
    expect(env.ui.notified.some((n) => n.includes("project trust"))).toBe(true);
  });

  it("add allow '*' warns and requires explicit confirmation; aborts without it", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:rules")!.handler;
    const ctx = env.ctx();
    ctx.ui.confirm = async (): Promise<boolean> => false; // operator declines
    await handler("add allow \"*\"", ctx);
    const cfgPath = join(userHome, ".pi/agent/gate/config.json");
    let wroteRule = false;
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      wroteRule = (cfg.rules ?? []).some((r: any) => r.pattern === "*");
    } catch {
      // no file at all — also fine
    }
    expect(wroteRule).toBe(false);
    expect(env.ui.notified.some((n) => n.includes("aborted"))).toBe(true);
  });

  it("add allow '*' with confirm=true writes the wide-open rule", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:rules")!.handler;
    const ctx = env.ctx();
    ctx.ui.confirm = async (): Promise<boolean> => true; // operator confirms
    await handler("add allow \"*\"", ctx);
    const cfg = JSON.parse(await readFile(join(userHome, ".pi/agent/gate/config.json"), "utf8"));
    expect(cfg.rules).toContainEqual({ action: "allow", pattern: "*" });
  });

  it("a quoted multi-token pattern arrives whole: add allow \"ls ?*\" --tool bash", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:rules")!.handler;
    await handler('add allow "ls ?*" --tool bash', env.ctx());
    const cfg = JSON.parse(await readFile(join(userHome, ".pi/agent/gate/config.json"), "utf8"));
    expect(cfg.rules).toContainEqual({ action: "allow", tools: ["bash"], pattern: "ls ?*" });
  });

  it("gate:config set rejects unknown keys, rules, and invalid values without writing", async () => {
    const { pi, captured } = fakePi();
    const env = makeEnv();
    createGatekeeper(pi, { home: userHome, fetchFn: env.fetchFn });
    const handler = captured.commands.get("gate:config")!.handler;
    await handler("set threshold abc", env.ctx());
    await handler("set rules []", env.ctx());
    await handler("set nonsense 1", env.ctx());
    await handler("set log.maxLines -5", env.ctx());
    await handler("set enabled maybe", env.ctx());
    let cfg: any = {};
    try {
      cfg = JSON.parse(await readFile(join(userHome, ".pi/agent/gate/config.json"), "utf8"));
    } catch {
      // no file at all — nothing was ever written
    }
    expect(cfg.rules).toBeUndefined();
    expect(cfg.threshold).toBeUndefined();
    expect(cfg.nonsense).toBeUndefined();
    expect(cfg.log).toBeUndefined();
    expect(cfg.enabled).toBeUndefined();
    expect(env.ui.notified.some((n) => n.includes("unknown key"))).toBe(true);
    expect(env.ui.notified.some((n) => n.includes("must be a number between 0 and 1"))).toBe(true);
    expect(env.ui.notified.some((n) => n.includes("use gate:rules"))).toBe(true);
  });

  it("self-protection blocks relative reads of the gate's own config and log", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.99 });
    const project = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: ".pi/gate/config.json" } });
    expect(project?.block).toBe(true);
    expect(project?.reason).toContain("protects its own");
    const user = await runToolCall(captured, env, { type: "tool_call", toolName: "read", input: { path: ".pi/agent/gate/config.json" } });
    expect(user?.block).toBe(true);
    expect(env.requests).toHaveLength(0);
  });

  it("the plain selector maps Allow for session to a cached session allow", async () => {
    const { captured, env } = await setup({ choice: "safe", confidence: 0.99 });
    env.ui.select = async (title: string, options: string[]): Promise<string | undefined> => {
      env.ui.selected.push({ title, options });
      return options[1]; // "Allow for session"
    };
    const first = await runToolCall(captured, env, { type: "tool_call", toolName: "bash", input: { command: "ls ~/work" } });
    expect(first).toBeUndefined();
    const second = await runToolCall(captured, env, { type: "tool_call", toolName: "bash", input: { command: "ls ~/work" } });
    expect(second).toBeUndefined();
    expect(env.ui.selected).toHaveLength(1); // the second came from the session cache
  });
});
