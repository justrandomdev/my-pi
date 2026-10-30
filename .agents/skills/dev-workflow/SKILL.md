---
name: dev-workflow
description: Enforced coding workflow — plan (openspec or grill-with-docs), plan review cycle, code, code review cycle, git check-in, each phase run by a subagent role. Use when the user asks to implement a feature or fix, or asks for "the workflow". For non-coding work (pentesting, research), do not use.
---

# Dev Workflow

The enforced coding workflow. Every phase runs through a subagent role from `subagent-orchestrator`; that skill's delegation policy and the `pi-herdr-agents` mechanism rules bind here. If the task is ambiguous between coding and something else (pentesting, research, ops), ask the user before starting.

You orchestrate only: you interview the user, brief the roles, and relay reports. You implement nothing and write nothing — every write (plan, spec, ADR, code, fix, commit) is a role's write. `subagent-orchestrator`'s hard rules bind here, including the **muster**: role identity lives only in the subagent call's `agent` parameter — every launch below carries `agent: <role>`, and a prompt claiming a role claims nothing.

## Territory (hard rule)

The only acceptable place for any agent to write anything — plans, specs, code, fixes, commits — is the current repo checkout, the directory this orchestrator runs in (or a Herdr-managed worktree of it). Never write to another directory, another project, the home dir, /tmp, or a fresh clone; never create a sibling project. Launch every child with `cwd` set to the repo (or its worktree). If a child reports work landing outside the repo, treat it as failed: bring the changes into the repo or redo them, and tell the user.

## Autonomy: decide vs. ask

This workflow is autonomous by default. Run every step that has a clear rule through to the end; stop only at points where the decision is genuinely the operator's.

- **Ask the user** when the call is theirs: interview questions, whether to accept a finding above low instead of fixing it, what to do about low findings, the 5-cycle cap decision, and anything beyond an ordinary commit in check-in.
- **Never ask permission to continue.** When a step's exit condition is met, start the next step immediately and tell the user what you are doing — a status report is not a question, and flowing into the next phase is not a decision. Specifically: the moment the plan is done (final-pass-review clean, or the user accepted what remains), hand it straight to the `code` role — phase 3 starts on its own. The moment the code is done (final-pass-review clean or user-accepted), hand the work straight to the `git` role — phase 5 starts on its own. A phase passing final review is the end of *that* phase, never a place to end your turn waiting for a "go" the workflow never required.
- Report genuinely important issues and operator decisions the moment they surface; don't batch them.

## 1. Plan

Ask the user: openspec, or not?

- **openspec**: if the repo has no `openspec/` root, run `openspec init` first (interactive — the user drives it). Then run the **openspec propose** interview with the user yourself — the questioning is yours, the writing is not. Hand the settled requirements to the **`plan`** agent (`agent: plan` on the call; launch it with the **openspec propose** skill) to write the change proposal; the proposal is the plan.
- **No openspec**: run the **grill-with-docs** interview with the user yourself — questioning only, writing nothing. Hand the interview record to the **`plan`** agent (`agent: plan` on the call) to write the plan and any ADR/glossary updates (launch it with the **domain-modeling** skill when ADRs are needed). Plan location: the repo's own convention if documented (AGENTS.md), otherwise `docs/plans/<kebab-slug>.md`.

For regular planning launch `plan` as defined; when the user says the work is complex, launch `plan` with `model: opencode-go/glm-5.3`, `thinking: high`.

## 2. Plan review cycle

Hand the plan to the **`review`** role (`agent: review` on the call).

- Show the user the full review report — they decide whether to accept flaws or fix.
- **Automatically fix** every medium, high, and critical finding; low findings wait for the user's call. Plan and spec fixes are made by the **`plan`** agent — relaunch it (or resume its session) with the review report as the task; never fix anything yourself — then the plan is reviewed again.
- Do not pause between cycles to ask whether to continue — keep cycling until only lows remain, the user accepts findings, or the cap hits. Report each cycle's results as you go.
- **Cap: 5 fix-and-re-review cycles.** At the cap without a clean or user-accepted report, stop cycling and report to the user: why so many cycles were needed (the recurring findings across the reports), what remains outstanding, and ask how to proceed — continue cycling or their other instructions.
- When a report leaves only low findings, the `review` cycle is done. Then hand the plan to the **`final-pass-review`** role (`agent: final-pass-review` on the call) for one or two final rounds (fresh eyes on what the cycle normalized). Anything above low it finds re-enters the fix-and-re-review loop; otherwise the plan is done.

The user is happy with the plan when they say so — accepted flaws count as happy. A finished plan is a report and a handoff, not a stopping point: proceed directly into phase 3 without waiting for a go-ahead.

## 3. Code

Hand the plan to the **`code`** role (`agent: code` on the call).

- **openspec path**: the code phase follows the **openspec apply** skill against the accepted change proposal.
- **No openspec**: the code phase implements per the plan, the ADRs, and any other documented artifacts from phase 1.

## 4. Code review cycle

Hand the diff to the **`review`** role (`agent: review` on the call). Same rules as phase 2, five-cycle cap and the two-stage finish included: cycle the report, fixing mediums and above with the **`code`** agent, until only lows remain — then one or two **`final-pass-review`** rounds; anything above low they find re-enters the fix-and-re-review loop. Do not pause between cycles to ask whether to continue — keep cycling until only lows remain or the cap hits, reporting results as you go.

Check-in is the mandatory next step after a finished review cycle, taken autonomously — no go-ahead from the user first.

## 5. Check in

Hand the work to the **`git`** role (`agent: git` on the call): run the repo's checks, commit, report the SHA. No push, no PR, no branch switching. Anything beyond the commit is yours.
