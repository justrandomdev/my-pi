---
name: init
description: Bootstrap a repo for agentic coding — interviews the operator, then writes AGENTS.md, CLAUDE.md, README.md, and .gitignore, and installs the required pi extensions. Use when the operator wants to initialize or bootstrap a new or existing repository.
---

# Init

Bootstrap a repository for agentic coding. Keep every generated file as short as its job allows; AGENTS.md is loaded into context constantly, so low token count is a hard requirement.

## 0. No assumptions

Every decision belongs to the operator: design, architecture, security, tech stack, conventions, workflow, tooling. If a required detail is missing, **ask** — never fill a gap with a default, a best guess, or "standard practice". Reading facts from the repo (e.g. manifest scripts) is fine; choosing anything is not. The only defaults permitted are the ones this skill explicitly offers (the security one-liner, the workflow loop, the .gitignore entries), and each is **offered** first, never applied silently. "You decide" or silence from the operator is not an answer — re-ask with concrete options. When in doubt: ask.

## 1. Interview

Ask all of this in **one pass**; then follow up on **every** answer that is vague, partial, or missing — a vague answer is a follow-up question, not an invitation to infer.

1. **Tech stack** — languages, framework, package manager, plus any **non-standard commands** (non-default package manager, unusual test invocation, monorepo task runner). Feeds the .gitignore, the README quickstart, and the AGENTS.md Commands section. Standard commands are inferable from the manifest — only capture what would surprise an agent, and cross-check it against the stack.
2. **What is this repo for?** — 2–3 sentences for the AGENTS.md "What this repo is" section.
3. **Coding conventions** — only repo-specific rules an agent would otherwise get wrong. Generic advice ("write clean code") is noise; omit.
4. **Security** — if the operator offers nothing, propose the default below and let them decline.
5. **Architecture & design** — module boundaries, key directories, patterns the agent must respect. Always ask; record only what the operator states — nothing inferred.
6. **Agentic method** — offer: (a) vibe coding, (b) spec-driven development, (c) not sure.
   - (b): recommend `npm install -g @fission-ai/openspec@latest`, but **confirm first** — the operator may prefer another SDD framework. Once installed, OpenSpec's own setup choices (`openspec init` prompts, conventions, directory layout) are operator decisions too — ask before running anything; don't choose for them.
   - (c): offer Matt Pockock's skills as the non-vibe default.
   - Offer Matt Pockock's skills **even when SDD is chosen** — `npx skills add mattpocock/skills`; the operator picks which skills to install.
7. **Monorepo?** — if yes, keep the root AGENTS.md lean and remind the operator they can add a nested AGENTS.md per package later (the nearest one in the tree takes precedence). Do not interview per package in this run.
8. **Sub-agents** — ask whether this repo uses sub-agent delegation (roles: plan, code, review, git, security by default). If yes:
   - Install the workflow skills now (project-level): `npx skills add justrandomdev/my-pi/skills -s dev-workflow,subagent-orchestrator` — and confirm the output lists both skills. Also install the `herdr` prerequisite skill if it is not installed globally (`npx skills add herdrdev/herdr`).
   - Record a one-line pointer to the `dev-workflow` and `subagent-orchestrator` skills in the generated AGENTS.md.

   Role provisioning itself is machine-global — see §2.5.
9. **Additional principles** — appended after the four core principles, same voice.

Also ask:

- **.gitignore?** — default **yes**. Minimal stack-specific entries plus an unconditional `.env*` secrets line.
- **Existing files?** — for each of README.md / AGENTS.md / CLAUDE.md / .gitignore that already exists, ask: skip / review-and-merge / replace (back up the original first). Never silently overwrite.

## 2. Pi extensions

Run `pi list` first. Show the operator any required extensions already installed globally, explain that a project-level entry replaces the personal one (nothing loads twice), then ask them to choose scope — **recommend project-level** (`-l`).

Install each after explicit confirmation. If a command fails (sandboxed, no network, permissions), print it for the operator to run manually and continue — every install is non-fatal.

- `pi install git:https://github.com/justrandomdev/pi-gatekeeper` — **critical**; statically gates destructive, secret-exposing, or out-of-scope tool calls
- `pi install npm:pi-knowledge`
- `pi install npm:@rsrini/pi-rtk`
- `pi install npm:pi-show-diffs`
- `pi install npm:pi-antiloop`
- `pi install npm:@tavily/pi-extension` — needs a `TAVILY_API_KEY`. If the `wizard` skill is installed, generate a one-stage wizard for the key (hidden entry, `.env` upsert); otherwise print the setup instructions. Never block on it

Append `-l` to every command for project scope.

`pi install npm:pi-herdr-agents` is **user-level (no `-l`)**: it is an execution host for Herdr subagents, requested only when the operator answered yes to sub-agents in §1.8, and installed only if `pi list` does not already show it.

### 2.5 Role provisioning (machine-global)

Subagent roles live in `$PI_CODING_AGENT_DIR/agents/` (default `~/.pi/agent/agents/`), not in the repo. Run this at most once per machine:

- If a role catalog already exists there, **do not** offer to overwrite it — report what is installed and move on.
- If the directory has no roles, offer the default catalog **wholesale** (show the full table: role, responsibility, model, thinking). Only if declined, interview per-role for models and thinking.
- Default catalog: `plan` (glm-5.3-flash, medium), `code` (deepseek-v4.1-flash, high), `review` (minimax-m3, high), `git` (deepseek-v4.1-flash, medium), `security` (glm-5.2, high; glm-5.3 override is a per-launch decision, not a file). Models are `provider/model-id` values from the `opencode-go` provider; verify they resolve before writing files.

## 3. Generate files

Before writing anything, check every template placeholder below against the interview answers. If any decision is still unanswered, **stop and ask** — do not write around it, and do not fill it in yourself. Every line in every generated file must trace to an operator answer or a default the operator accepted.

### AGENTS.md

```markdown
# AGENTS.md

## Core principles

1. **Think before coding.** Don't assume — state your interpretation and ask when uncertain. Don't hide confusion. Surface tradeoffs, and push back when a simpler approach exists.
2. **Simplicity first.** Minimum code that solves the problem. No unasked features, single-use abstractions, unrequested configurability, or error handling for impossible cases. If 200 lines could be 50, rewrite.
3. **Surgical changes.** Every changed line traces directly to the request. Match existing style. Mention unrelated dead code — don't delete it. Remove orphans your own changes created; leave pre-existing ones.
4. **Goal-driven execution.** Turn tasks into verifiable goals: "fix the bug" → write a test that reproduces it, then make it pass. For multi-step work, state a plan with a verify check per step, and loop until every check passes.
5. **No assumptions.** Every decision — design, architecture, security, tech stack, conventions — belongs to the operator. If a detail is missing, ask; never fill a gap with a default, a best guess, or "standard practice". When in doubt: ask.
6. **AGENTS.md is authoritative.** Skills inform — they never overrule these principles. When a skill's guidance conflicts with anything here, these principles win; if deviating seems justified, ask the operator first.
{{operator principles appended here as 7+, same voice}}

## Workflow

Every task follows **plan → build (including tests) → review → commit**. A task isn't done until its verify check passes. {{Or the operator's modified loop}}

## What this repo is

{{2–3 sentences from the interview}}

## Commands

{{only non-standard commands — omit the section entirely if everything is conventional for the stack}}

## Security

Never commit secrets or credentials (`.env*` is gitignored). Ask before network access, subprocess use beyond the task, or destructive operations.
{{Or the operator's own version. Omit this section entirely if they decline}}

## Conventions / Gotchas

{{only sections the operator supplied — omit entirely if none}}
```

The six core principles are copied **verbatim** — never paraphrased, never reordered.

### CLAUDE.md

```markdown
All agent instructions live in AGENTS.md — read it before making changes.

@AGENTS.md
```

### README.md

```markdown
# {{repo name}}

{{one-para description}}

## Quickstart

{{bash block: standard commands for the stack plus any non-standard ones; omit the section if none are known yet}}

Agents: read [AGENTS.md](AGENTS.md) before making changes.
```

### .gitignore

Unconditional first line: `.env*`. Then the stack's minimal entries — Node: `node_modules/`, `dist/`; Python: `__pycache__/`, `.venv/`, `*.pyc`; ask or derive from the stack answer for anything else. Nothing speculative.

## 4. Verify

- Re-read every file written. Confirm CLAUDE.md imports AGENTS.md, .gitignore covers the stack's artifacts plus `.env*`, and the commands match the stack.
- **Traceability audit:** scan every generated file for content that cannot be traced to an operator answer or an accepted default. If any is found, ask the operator about it and revise — an assumption that already reached disk is still an assumption.
- Run `pi list` and confirm the extensions installed at the chosen scope.
- Report a summary: files created/merged, extensions installed, and any commands the operator still needs to run manually (failed installs, Tavily key, OpenSpec or skills installs they deferred).
