# Skills

Agent skills for this repo, managed with the [Vercel skills CLI](https://github.com/vercel-labs/skills). Each skill is a `<name>/SKILL.md` directory; the CLI installs them into agent skill dirs (pi, Claude Code, …) and tracks them in `skills-lock.json`.

A skill is a directory with a `SKILL.md` containing YAML frontmatter (`name`, `description`) followed by instructions the agent loads on demand.

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

## Prerequisites

[`subagent-orchestrator`](./subagent-orchestrator/SKILL.md) drives the [Herdr](https://github.com/herdrdev/herdr) CLI and defers all command syntax to the `herdr` skill, so install that first:

```bash
npx skills add herdrdev/herdr
```

It also needs to run inside a Herdr pane (`HERDR_ENV=1`). Without the skill installed, `herdr --skill` prints the same reference content.

## Skills in this repo

| Skill | Description |
|-------|-------------|
| [subagent-orchestrator](./subagent-orchestrator/SKILL.md) | Orchestrate planner/builder/reviewer subagents in Herdr terminal panes — spawn, prompt, wait, and collect their outputs. |
