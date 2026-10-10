# AGENTS.md

## Core principles

1. **Think before coding.** Don't assume — state your interpretation and ask when uncertain. Don't hide confusion. Surface tradeoffs, and push back when a simpler approach exists.
2. **Simplicity first.** Minimum code that solves the problem. No unasked features, single-use abstractions, unrequested configurability, or error handling for impossible cases. If 200 lines could be 50, rewrite.
3. **Surgical changes.** Every changed line traces directly to the request. Match existing style. Mention unrelated dead code — don't delete it. Remove orphans your own changes created; leave pre-existing ones.
4. **Goal-driven execution.** Turn tasks into verifiable goals: "fix the bug" → write a test that reproduces it, then make it pass. For multi-step work, state a plan with a verify check per step, and loop until every check passes.
5. **No assumptions.** Every decision — design, architecture, security, tech stack, conventions — belongs to the operator. If a detail is missing, ask; never fill a gap with a default, a best guess, or "standard practice". When in doubt: ask.

## What this repo is

A monorepo of pi plugins and agent skills. Plugins target the [pi coding harness](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`), each making pi easier to work with or more useful. Agent skills live in `skills/<name>/SKILL.md` (one skill per directory, not related to any plugin) and are installed to agent skill dirs by the Vercel `skills` CLI — `npx skills add ./skills` — tracked in `skills-lock.json`. Every skill added there must also be listed in `skills/README.md`; the README is the human-facing catalog of the skills repo.

**Token efficiency is a hard design constraint.** A plugin that inflates context, attention, or output spend is a regression even when the feature works:
- Prefer on-demand material (commands, tools) over always-loaded context — every always-on cost justifies itself.
- Keep descriptions, UI strings, and output terse; extension output lands in the model's window or the user's screen.

## Pi harness documentation

Authoritative harness docs: `$(npm root -g)/@earendil-works/pi-coding-agent/docs/` (the `docs/` folder inside the installed package). Hot files: `extensions.md` (extension API and events), `packages.md` (packaging), `skills.md` (skills); `sdk.md`, `rpc.md`, `custom-provider.md` for deep integration. When docs and code disagree, the exported types in `extensions/types.ts` are final.

## Plugin conventions

- One plugin per top-level directory (outside `skills/`), as a standard pi package (conventional `extensions/`/`skills/`/`prompts/`/`themes/` dirs or a `pi` manifest — `packages.md`).
- Extensions are plain TypeScript (jiti — no build step); don't add bundlers or compilers.
- Extensions run with the user's permissions — no network, filesystem, or subprocess access beyond the plugin's function.

## Commands

```bash
pi -e ./<plugin>            # load for one run — the verification loop
pi install ./<plugin> -l    # install into this project (needs project trust)
pi list                     # show packages
pi remove <source>          # remove one
pi update --extensions      # reconcile installations
```

Every plugin change ends verified: load it with `pi -e` and exercise the feature end-to-end before reporting done.

## Gotchas

- `.agents/skills/` is populated by the Vercel `skills` CLI: upstream skills are vendored via `skills-lock.json`, and repo-owned skills are copied in from `skills/`. Pi scans `.agents/skills/` natively; `.pi/skills/` and `.claude/skills/` are symlinks into it. Don't hand-edit anything under those three paths — upstream changes belong at the upstream source, and repo skills are edited in `skills/` then re-synced with `npx skills update -y`.
