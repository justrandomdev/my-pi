import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
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
    expect(env.ui.selected[0].options).toEqual(["Allow once", "Allow always", "Deny"]);
    expect(env.ui.selected[0].title).toContain("bash");
    // the stub operator picks Deny
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("operator denied");
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
});
