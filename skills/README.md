# Skills

Agent skills for this repo, managed with the [Vercel skills CLI](https://github.com/vercel-labs/skills). Each skill is a `<name>/SKILL.md` directory; the CLI installs them into agent skill dirs (pi, Claude Code, …) and tracks them in `skills-lock.json`.

A skill is a directory with a `SKILL.md` containing YAML frontmatter (`name`, `description`) followed by instructions the agent loads on demand.

## Bootstrap a new repo

The [`init`](./init/SKILL.md) skill scaffolds any repo for agentic coding — it interviews you, then writes AGENTS.md, CLAUDE.md, README.md, and .gitignore, and installs the required pi extensions:

```bash
npx skills add justrandomdev/my-pi/skills -s init
```

Optional companion: install the `wizard` skill first (`npx skills add mattpocock/skills -s wizard`) and `init` will use it to walk you through the Tavily API key entry.

## Managing skills

```bash
# List skills available in this repo
npx skills add ./skills --list

# Install a skill (non-interactively, to detected agents)
npx skills add ./skills

# Remove a skill
npx skills remove subagent-orchestrator -y

# Update after editing a skill's SKILL.md
npx skills update -y
```

`npx skills add ./skills -y` installs to all detected agents at once; add `-a claude-code` (etc.) to target specific ones. Run `npx skills ls` to see what's installed and where.

## Installing the subagent skills

You normally do **not** install [`subagent-orchestrator`](./subagent-orchestrator/SKILL.md) and [`dev-workflow`](./dev-workflow/SKILL.md) by hand: `init` installs both (plus their `herdr` prerequisite skill) automatically when you answer yes to sub-agents in its interview.

Skipping init, or adding them to a repo init already set up? Run this from the target repo, any time before your first task that delegates to a subagent — before or after init otherwise makes no difference:

```bash
npx skills add justrandomdev/my-pi/skills -s dev-workflow,subagent-orchestrator
```

### Prerequisites (init installs these too)

- The [`pi-herdr-agents`](https://github.com/giuseppecrj/pi-herdr-agents) extension — `pi install npm:pi-herdr-agents` (user-level).
- The `herdr` skill — `npx skills add herdrdev/herdr`.
- Both skills must run inside a Herdr pane (`HERDR_ENV=1`).
- The roles they launch live in `~/.pi/agent/agents/` (or the project's `.pi/agents/`); `init` provisions them (§2.5 of its SKILL.md).

## Skills in this repo

| Skill | Description |
|-------|-------------|
| [agent-issue-tracker](./agent-issue-tracker/SKILL.md) | Drive the agent-issue-tracker CLI — auth, entity commands, status/workflow rules, output shapes, and the Kanban dashboard; fresh-environment provisioning in SETUP.md. |
| [dev-workflow](./dev-workflow/SKILL.md) | Enforced coding workflow — plan (openspec or grill-with-docs), plan and code review cycles, git check-in, each phase run by a subagent role; the orchestrating agent implements nothing. |
| [init](./init/SKILL.md) | Bootstrap a repo for agentic coding — interview-driven AGENTS.md/CLAUDE.md/README.md/.gitignore plus pi extension installs, and optional subagent role provisioning. |
| [subagent-orchestrator](./subagent-orchestrator/SKILL.md) | Delegate to subagent roles (plan, code, review, git, security, deep-thinking) via the pi-herdr-agents extension in Herdr terminal panes — the role catalog and delegation policy; the orchestrator implements nothing. |
