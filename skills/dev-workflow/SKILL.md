---
name: dev-workflow
description: Enforced coding workflow — plan (openspec or grill-with-docs), plan review cycle, code, code review cycle, git check-in, each phase run by a subagent role. Use when the user asks to implement a feature or fix, or asks for "the workflow". For non-coding work (pentesting, research), do not use.
---

# Dev Workflow

Every phase is a `subagent-orchestrator` role, and that skill's hard rules bind here — role identity is the call's `agent` parameter, never a prompt claim. You orchestrate only: interviews, briefings, relaying; every write (plan, spec, ADR, code, fix, commit) is a role's. Ambiguous between coding and other work (pentesting, research, ops) → ask first.

## Hard rules

- **Territory:** all writes go only into this repo checkout or a Herdr worktree of it — never another directory, project, home dir, /tmp, or fresh clone; launch children with `cwd` at the repo. Work landing outside is failed work: move it in or redo, and tell the user.
- **Autonomy:** proceed by rule; stop only at operator decisions — interview questions, accepting findings above low, low-finding disposition, the 5-cycle cap, anything beyond an ordinary commit. Never ask permission to start the next phase (plan done → `code` immediately; code done → check-in immediately); keep cycling review loops without pausing between cycles. Surface important issues and decisions as they arise, never batched.

## Phases

1. **Plan.** Ask: openspec, or not?
   - *openspec*: run `openspec init` if no `openspec/` root (user drives); run the **openspec propose** interview yourself; hand settled requirements to `plan` (`agent: plan`, openspec propose skill) — the proposal is the plan.
   - *no openspec*: run the **grill-with-docs** interview yourself, writing nothing; hand the record to `plan` (`agent: plan`, domain-modeling skill for ADRs). Plan goes in the repo's documented convention or `docs/plans/<kebab-slug>.md`.
   - Regular planning uses the role default; user-declared complex work uses the orchestrator's complex-work override.

2. **Plan review.** Hand to `review` (`agent: review`). Show the user the full report — they accept flaws or fix. Fix every medium+ automatically via `plan` (relaunch/resume it with the report; never fix yourself); lows wait for the user. Cycle without pausing, reporting each cycle, until only lows remain, the user accepts, or 5 fix-and-re-review cycles (then report recurring findings and ask how to proceed). Only lows → 1–2 `final-pass-review` rounds (`agent: final-pass-review`); anything above low re-enters the loop. The user is happy when they say so — accepted flaws count. A done plan flows straight into phase 3.

3. **Code.** Hand to `code` (`agent: code`): **openspec apply** against the accepted proposal, or implement per the plan, ADRs, and any phase-1 artifacts.

4. **Code review.** Same as phase 2 on the diff; fixes via `code`. Check-in is the mandatory autonomous next step once review finishes.

5. **Check in.** Hand to `git` (`agent: git`): run the repo's checks, commit, report the SHA. No push, PR, or branch switching; anything beyond the commit is yours.
