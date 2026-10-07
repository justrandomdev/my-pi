---
name: subagent-orchestrator
description: Use when the user wants work delegated to a subagent, a specialized persona (planner, builder, reviewer), or several tasks run in parallel in visible terminal panes. Requires the herdr skill and HERDR_ENV=1.
---

# Subagent Orchestrator

Policy for delegating work to subagents running in Herdr panes beside you. The **herdr skill** is the authority for every command, flag, lifecycle state, and error code, and its Safety and coordination rules bind here. Load it before your first control command; `herdr --skill` prints the same content when the skill is not installed.

If `HERDR_ENV=1` is unset, stop and tell the user you must be inside a Herdr pane.

## Delegate or do it myself

Delegate when the work is genuinely parallel, wants its own clean context (a reviewer of a diff you just wrote), or is bulk mechanical work. Do it myself when it needs this conversation's context or is a single small edit — coordination then costs more than the work.

Name the kind and model per agent, and ask the user before going past two agents.

## Personas

- **Planner** — requirements in, step-by-step Markdown checklist out, no code.
- **Builder** — checklist in, working code out, with the repo's checks run.
- **Reviewer** — file or diff in, actionable findings out with evidence quoted, no rewrites.

## Lifecycle

Each step ends on a completion criterion; herdr's JSON responses are the evidence.

1. **Split a sibling pane.** Done when you hold the new pane ID parsed from the response.
2. **Start a uniquely named agent** — persona plus slice, as in `reviewer-api` and `reviewer-spec`. Done when herdr reports the agent ready; when it reports the agent is not ready, wait for idle rather than starting over.
3. **Prompt with everything it cannot discover** — persona, exact goal, paths, the diff, the constraints in `AGENTS.md`, and the output format and length. Done when the prompt is accepted and the agent shows activity.
4. **Wait, then read.** A bare `agent wait` already covers every settled state; adding `--until` narrows it and can hang past a finished agent. Read the agent's output rather than the pane — when a response outruns the scrollback, ask that agent to write Markdown to a temp path and read the file.
5. **Collect and close.** Done when the user has the digest, and the panes this skill created are closed if the history is not wanted.

For parallel work, send the prompts without waiting, then wait on every agent before reading any of them.

## Failure handling

Inspect state before acting: a timeout does not prove the prompt was never delivered, so a resend duplicates paid work.

- **blocked** — the agent sits at an approval or question dialog, and herdr rejects prompts sent to it. Surface the dialog to the user and let them answer.
- **stalled or timed out** — read the agent to see what it actually did before touching it again.
- **failed or unexpected output** — report it, quoting the agent, rather than respawning.

## Reporting back

Report which agents ran, what each produced, and any decision still waiting on the user. Mark subagent claims as claims until you or the user verify them.
