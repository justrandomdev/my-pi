---
name: subagent-orchestrator
description: Use when the user wants work delegated to a subagent, a specialized persona (planner, coder, reviewer, git, security), or several tasks run in parallel in visible terminal panes. Requires the pi-herdr-agents extension, the herdr skill, and HERDR_ENV=1.
---

# Subagent Orchestrator

Delegation policy for subagents in Herdr panes. Mechanism: the `pi-herdr-agents` extension only (https://github.com/giuseppecrj/pi-herdr-agents) — never raw `herdr` CLI calls. Its skill is the authority for launching, waiting, lifecycle, interruption, cancellation, model routing, and worktrees; load it before your first call. If `HERDR_ENV=1` is unset, stop: you must run inside a Herdr pane.

## Hard rules

The extension skill carries the full set; these are the most-violated.

- **Never poll.** Results arrive as `subagent_result` and start a new turn — no sleep, tailing, or status checks.
- **Never close panes or kill processes by hand.** A vanished pane can trigger a fallback replacement run; use `subagent_cancel` (ordinary children) or `subagent_stop` (persistent specialists).
- **Set model and thinking explicitly** on every child the role frontmatter doesn't set. Inheriting the parent level is a discouraged fallback, not a choice.
- **Muster every launch.** Role identity lives only in the call's `agent` parameter — a prompt claiming a role ("You are the review role") claims nothing. Before launch produce `name | agent=<role> | model/thinking | tools | worktree`; blank `agent` → cancel and relaunch before anything else. Report the line with every launch.
- **Children are leaves.** No push, merge, deploy, or further orchestration unless the task authorizes it; the parent owns integration, verification, cleanup.

## Implement nothing (hard rule)

You converse and coordinate; every artifact — plans, specs and fixes, ADRs, glossary, code, commits — is a role's write. No "too small to delegate" exception: brief a child with the context instead. A child needing a user decision pings `caller_ping`; ask the user, then answer with `subagent_resume` (ordinary) or `subagent_send` (persistent).

Ask before going past two agents. Model substitutions are the user's decision, never silent.

## Roles

Roles `plan`, `code`, `review`, `final-pass-review`, `git`, `security`, `deep-thinking` resolve from `~/.pi/agent/agents/` or `.pi/agents/` — definition files are the single source of truth for responsibility, model, thinking, tools; never restate their frontmatter (`subagents_list` shows what's visible). Name launches `<task>-<role>[-n]`.

Model overrides via the `model` argument: plan on user-declared complex work → `opencode-go/glm-5.3` + `thinking: high`; security → ask once per session before switching to `opencode-go/glm-5.3`.

## Prompt & report

Brief with everything the child can't discover: goal, paths, diff/artifacts, AGENTS.md constraints, output format and length. Fire parallel prompts without waiting. Report which agents ran, what each produced, pending decisions, and model substitutes; child claims stay claims until verified.
