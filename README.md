# my-pi

A monorepo of pi plugins and agent skills for the [pi coding harness](https://github.com/earendil-works/pi). More pi plugins are in active development.

## Bootstrap a new repo

The [`init`](./skills/init/SKILL.md) skill scaffolds any repo for agentic coding — it interviews you, then writes AGENTS.md, CLAUDE.md, README.md, and .gitignore, and installs the required pi extensions:

```bash
npx skills add justrandomdev/my-pi/skills -s init
```

Run it from the repo you want to bootstrap and answer the interview.

When you opt into sub-agents during the interview, `init` also installs the [`dev-workflow`](./skills/dev-workflow/SKILL.md) and [`subagent-orchestrator`](./skills/subagent-orchestrator/SKILL.md) skills with their prerequisites — no manual install needed. Skipping init? Same install, any time before your first delegation task: `npx skills add justrandomdev/my-pi/skills -s dev-workflow,subagent-orchestrator`.

## Skills

The skills catalog lives in [skills/README.md](./skills/README.md), with management commands (`npx skills add ./skills`, `update`, `remove`).

## Pi commands

```bash
pi -e ./<plugin>            # load a plugin for one run
pi install <source>         # install a package (npm:, git:, or local path)
pi list                     # show packages
pi remove <source>          # remove one
pi update --extensions      # reconcile installations
```
