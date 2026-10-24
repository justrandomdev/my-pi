---
name: dev-workflow
description: Enforced coding workflow — plan (openspec or grill-with-docs), plan review cycle, code, code review cycle, git check-in, each phase run by a subagent role. Use when the user asks to implement a feature or fix, or asks for "the workflow". For non-coding work (pentesting, research), do not use.
---

# Dev Workflow

The enforced coding workflow. Every phase runs through a subagent role from `subagent-orchestrator`; that skill's delegation policy and the `pi-herdr-agents` mechanism rules bind here. If the task is ambiguous between coding and something else (pentesting, research, ops), ask the user before starting.

## 1. Plan

Ask the user: openspec, or not?

- **openspec**: if the repo has no `openspec/` root, run `openspec init` first (interactive — the user drives it). Then run the **openspec propose** skill yourself — do not delegate it. Its change proposal is the plan.
- **No openspec**: run the **grill-with-docs** skill (interview + ADRs/glossary), then hand the settled requirements to the **`plan`** role to write the plan. Plan location: the repo's own convention if documented (AGENTS.md), otherwise `docs/plans/<kebab-slug>.md`.

For regular planning launch `plan` as defined; when the user says the work is complex, launch `plan` with `model: opencode-go/glm-5.3`, `thinking: high`.

## 2. Plan review cycle

Hand the plan to the **`review`** role.

- Show the user the full review report — they decide whether to accept flaws or fix.
- **Automatically fix** every medium, high, and critical finding; low findings wait for the user's call. Fixes are made (by you or the `code` role), then the plan is reviewed again.
- After each plan-review cycle, ask the user whether to continue cycling.

The user is happy with the plan when they say so — accepted flaws count as happy.

## 3. Code

Hand the plan to the **`code`** role.

- **openspec path**: the code phase follows the **openspec apply** skill against the accepted change proposal.
- **No openspec**: the code phase implements per the plan, the ADRs, and any other documented artifacts from phase 1.

## 4. Code review cycle

Hand the diff to the **`review`** role. Same rules as phase 2: show the report, auto-fix medium and above, re-review after fixes, ask the user after each cycle.

## 5. Check in

Hand the work to the **`git`** role: run the repo's checks, commit, report the SHA. No push, no PR, no branch switching. Anything beyond the commit is yours.
