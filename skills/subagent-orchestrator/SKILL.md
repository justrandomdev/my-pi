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
- **Set model and thinking explicitly** on every orchestrated child with no role frontmatter for them — omitting uses the role's frontmatter model and `thinking` when set, and only inherits the parent level when the role sets neither (discouraged).
- **Role identity is ONLY the subagent call's `agent` parameter.** A prompt that claims a role ("You are the review role") claims nothing — never launch role work without `agent:` set. Before every launch, run the muster: `name | agent=<role> | model/thinking | tools | worktree` — if `agent` is blank, cancel and relaunch before any other action. End the launch by reporting the muster line to the operator, so a blank role is visible in the transcript forever.
- **Children are leaves by default.** They never push, merge, deploy, or orchestrate further agents unless the task explicitly authorizes it. The parent owns integration, verification, and cleanup.

## The orchestrator implements nothing (hard rule)

You converse and coordinate; you never implement. Every artifact — plans, specs and their fixes, ADRs and glossary entries, code, commits — is written by a child role. There is no "too small to delegate" exception: if work needs this conversation's context, brief a child with that context instead of doing it yourself.

Interviews are conversation, not implementation. You may interview the user and relay answers, but every resulting artifact belongs to the role that owns it: the `plan` agent writes and revises plans and spec documentation (including fixes from review feedback), the `code` agent implements and fixes code, the `git` agent commits. When a child needs a user decision mid-task it calls `caller_ping`; ask the user, then answer with `subagent_resume` (ordinary child) or `subagent_send` (persistent specialist).

Ask the user before going past two agents, and surface any substitution of a role's model as a decision for them rather than making it silently.

## Roles

Named roles resolve from `~/.pi/agent/agents/` (global) or the project's `.pi/agents/`. `subagents_list` shows what is visible. Each role has a bounded responsibility:

| Role | Responsibility | Model (frontmatter) |
| --- | --- | --- |
| `plan` | Settled requirements → Markdown plan and spec docs, including fixes from review feedback; no code | `opencode-go/glm-5.3-flash` |
| `code` | Plan/spec → working code with repo checks run | `opencode-go/deepseek-v4.1-flash` |
| `review` | Diff/file/plan → findings with evidence and severity; cycles until only low findings remain | `opencode-go/deepseek-v4-flash` |
| `final-pass-review` | One or two last review rounds after `review` has converged to low-only findings | `opencode-go/minimax-m3` |
| `git` | Verify, commit, report SHA — no push, no PR | `opencode-go/deepseek-v4.1-flash` |
| `security` | Security/pentest analysis with exploit conditions | `opencode-go/glm-5.2` |
| `deep-thinking` | Hard diagnosis and architecture analysis — what resisted the first pass | `opencode-go/glm-5.3` |

Tier overrides, passed as the `model` argument at launch:

- **plan, complex work** — the user must say the work is complex; regular planning is the default. Override to `opencode-go/glm-5.3` (with `thinking: high`).
- **security** — `glm-5.2` is the default; ask the user once per session whether this session's security work uses `glm-5.3` instead.

Launch names as `<task>-<role>[-n]` (e.g. `reviewer-api`, `reviewer-spec`).

## Prompting

Prompt with everything the child cannot discover: the role's job, the exact goal, paths, the diff or artifacts, the constraints in AGENTS.md, and the output format and length. For parallel work, send the prompts without waiting, then let the results arrive.

## Reporting back

Report which agents ran, what each produced, and any decision still waiting on the user. Mark subagent claims as claims until you or the user verify them.
