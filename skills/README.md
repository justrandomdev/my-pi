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

## Prerequisites

[`subagent-orchestrator`](./subagent-orchestrator/SKILL.md) drives the [Herdr](https://github.com/herdrdev/herdr) CLI and defers all command syntax to the `herdr` skill, so install that first:

```bash
npx skills add herdrdev/herdr
```

It also needs to run inside a Herdr pane (`HERDR_ENV=1`). Without the skill installed, `herdr --skill` prints the same reference content.

## Skills in this repo

| Skill | Description |
|-------|-------------|
| [init](./init/SKILL.md) | Bootstrap a repo for agentic coding — interview-driven AGENTS.md/CLAUDE.md/README.md/.gitignore plus pi extension installs. |
| [subagent-orchestrator](./subagent-orchestrator/SKILL.md) | Orchestrate planner/builder/reviewer subagents in Herdr terminal panes — spawn, prompt, wait, and collect their outputs. |
