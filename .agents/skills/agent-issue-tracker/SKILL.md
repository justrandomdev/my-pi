---
name: agent-issue-tracker
description: "Drive the agent-issue-tracker CLI: tickets, subtasks, comments, status/workflow moves, Kanban dashboard. Use when a repo tracks its work in agent-issue-tracker, the user mentions its tickets/issues, or asks to create, search, update, move, or gate tickets, or serve the dashboard."
---

# Agent Issue Tracker

Agent-first CLI issue tracker. The built binary is `bin/agent-issue-tracker` inside the tool's own checkout (`make build` produces it); if it is missing, tell the user rather than guessing for it. Data commands need the session environment: with `AIT_HOME` pointed at a private directory set `AIT_BACKEND=sqlite` and `AIT_SQLITE_PATH=<dir>/data/agent-issue-tracker.db`; unset, the default home is used. First-time provisioning on a fresh `AIT_HOME` (keys, first admin, workspace, workers): [SETUP.md](SETUP.md).

## Authenticate every shell

Every data command needs **exactly one** principal exported, with a cached session minted by the matching login:

```bash
<$bin> login --agent-identity <name> --key <keypath>   # or --admin-identity <identity>
export AIT_AGENT=<name>    # or AIT_ADMIN=<identity>; never both
```

Both set → `set only one of AIT_AGENT or AIT_ADMIN`; neither → `set AIT_AGENT or AIT_ADMIN (log in first)`. An expired session is cured by re-running `login` with the same key; `AIT_TOKEN_TTL=45s` shortens the lifetime (session-renewal testing).

## IDs, shapes, and output grammar

- Entity IDs are prefixed (`WS-`, `PRJ-`, `TCK-`, `SUB-`, `CMT-`, `STS-`, `AGT-`, `ADM-`); JSON keys are lowercase snake_case (`status_name`, `assignee_id`, `owner_id`). Capture IDs with `jq -r .id`.
- Single-entity commands emit one JSON object. **`ticket search` emits NDJSON** — one object per line; parse line-wise (`jq -r .title`), never as an array. **`ticket list`, `subtask list`, `comment list`, `agent list`, `workspace list`, `status list` emit arrays**. A project-scoped agent gets `workspace list` → `[]`.
- `owner` is the creating agent, set automatically; `--assignee <agent-id>` is optional (`agent list` supplies IDs). `--verbose` on ticket search adds `description` and `assignee`.
- `help` prints to **stderr**. Errors are one terse line naming the domain (`error: store: not found`, `error: workflow: …`) — the domain prefix plus the message is the diagnosis; there is nothing more to read.

## Statuses and workflow

- A new workspace's status catalog is seeded: `To Do`, `In Progress`, `In Review`, `Testing`, `Done` (`status list <WS>` returns their IDs). **`Backlog` has no ID — it is the empty status.** A new project's workflow defaults to `Backlog → To Do → In Progress → In Review → Done`; `Testing` sits in the catalog but off the workflow. Catalog and workflow mutations are admin-only; reads are open.
- `ticket set-status <id> --status <STATUS-ID>` moves **one workflow step at a time** — skipping errors with `transition skips a status`. `--status ""` clears the ticket back to Backlog. Inverse gotcha: **`search --status` filters by status *name*** (`--status "In Progress"`), not by ID.
- Subtasks run on the same workflow and the same one-step rule. A ticket's forward move is **gated by subtasks**: `error: store: ticket is gated by subtasks: SUB-…, SUB-…`. Advance the listed subtasks (step-wise too) and retry the ticket.
- All status names above are the seeded defaults; a workspace may carry custom names — read them from `status list <WS>` and `workflow get <PRJ>` before moving anything.

## Work loop

1. Authenticate, then locate the project: a known `WS` id → `project list <WS>` (or read the id you were given). Unknown workspace id → ask the user — do not guess IDs; prefix-shaped guesses fail as `store: not found`.
2. **Search before create**: `ticket search --project <PRJ> [--mine] [--status <name>] [--title <pattern>]`. Create: `ticket create <PRJ> <title> [--description <d>] [--assignee <id>]`; multi-step work gets `subtask create <TCK> <title>` children; findings and rationale go to `comment create --ticket <id> <body>`.
3. Advance one step at a time with IDs from `status list <WS>`; when the subtask gate fires, advance the listed subtasks and retry the ticket.
4. Verify before reporting: read back every changed entity (`ticket get`, `subtask get`) and report ids + `status_name`. Tracker-state claims quote the tracker's own read-back, not intent.

## Dashboard

`dashboard [--addr 127.0.0.1:8080]` serves a read-only Kanban of one project on loopback only — any non-loopback address is refused. Serve it as a principal whose scope covers the project (the admin does everywhere); the board's one mutation — approving a Backlog ticket into the workflow — is admin-only. CLI-side changes reach the open page within ~1 s. Full local walkthrough (`~/ait-dashboard-test` sandbox in the tool repo's README): point the user there rather than re-deriving it.
