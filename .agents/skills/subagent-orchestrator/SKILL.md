---
name: subagent-orchestrator
description: Use when the user wants work delegated to a subagent, a specialized persona (planner, coder, reviewer, git, security), or several tasks run in parallel in visible terminal panes. Requires the pi-herdr-agents extension, the herdr skill, and HERDR_ENV=1.
---

# Subagent Orchestrator

Policy for delegating work to subagents running in Herdr panes beside you.

**Mechanism:** the `pi-herdr-agents` extension (https://github.com/giuseppecrj/pi-herdr-agents) is the only subagent mechanism — never raw `herdr` CLI commands. Its skill, `pi-herdr-agents`, is the authority for launching, waiting, lifecycle states, interruption, cancellation, model routing, and worktrees; its rules bind here. Load it before your first subagent call.

If `HERDR_ENV=1` is unset, stop and tell the user you must be inside a Herdr pane.

## Core mechanism rules

These are the rules most often violated; the extension skill carries the full set.

- **Never poll.** `subagent` returns an acknowledgement; results arrive automatically as a `subagent_result` message that starts a new turn. No sleep, no tailing, no status checks.
- **Never close panes or kill processes by hand.** A vanished pane can trigger a fallback replacement run that keeps cancelled work going. Use `subagent_cancel` (ordinary children) or `subagent_stop` (persistent specialists).
- **Set model and thinking explicitly** on every orchestrated child — omitting inherits the parent runtime, which is a discouraged fallback.
- **Children are leaves by default.** They never push, merge, deploy, or orchestrate further agents unless the task explicitly authorizes it. The parent owns integration, verification, and cleanup.

## Delegate or do it myself

Delegate when the work is genuinely parallel, wants its own clean context (a reviewer of a diff you just wrote), or is bulk mechanical work. Do it myself when it needs this conversation's context or is a single small edit — coordination then costs more than the work.

Ask the user before going past two agents, and surface any substitution of a role's model as a decision for them rather than making it silently.

## Roles

Named roles resolve from `~/.pi/agent/agents/` (global) or the project's `.pi/agents/`. `subagents_list` shows what is visible. Each role has a bounded responsibility:

| Role | Responsibility | Model (frontmatter) |
| --- | --- | --- |
| `plan` | Settled requirements → step-by-step Markdown plan, no code | `opencode-go/glm-5.3-flash` |
| `code` | Plan/spec → working code with repo checks run | `opencode-go/deepseek-v4.1-flash` |
| `review` | Diff/file/plan → findings with evidence and severity | `opencode-go/minimax-m3` |
| `git` | Verify, commit, report SHA — no push, no PR | `opencode-go/deepseek-v4.1-flash` |
| `security` | Security/pentest analysis with exploit conditions | `opencode-go/glm-5.2` |

Tier overrides, passed as the `model` argument at launch:

- **plan, complex work** — the user must say the work is complex; regular planning is the default. Override to `opencode-go/glm-5.3` (with `thinking: high`).
- **security** — `glm-5.2` is the default; ask the user once per session whether this session's security work uses `glm-5.3` instead.

Launch names as `<task>-<role>[-n]` (e.g. `reviewer-api`, `reviewer-spec`).

## Prompting

Prompt with everything the child cannot discover: the role's job, the exact goal, paths, the diff or artifacts, the constraints in AGENTS.md, and the output format and length. For parallel work, send the prompts without waiting, then let the results arrive.

## Reporting back

Report which agents ran, what each produced, and any decision still waiting on the user. Mark subagent claims as claims until you or the user verify them.
