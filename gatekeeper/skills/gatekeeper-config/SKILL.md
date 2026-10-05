---
name: gatekeeper-config
description: Explains how the operator configures the pi gatekeeper plugin — rules, threshold, ask floors, model endpoint, decision log. Use when the user asks about configuring or tuning gatekeeper, asks why a call was gated or blocked, or wants a gate setting changed.
---

# Gatekeeper configuration guidance

You cannot configure gatekeeper, and you cannot read its config or decision log: every agent tool call touching them is always denied, before any rule (self-protection, ADR-0003). Do not attempt edits, reads, or shell workarounds — they are always blocked, including attempts to allow them. Your job here is to explain to the operator how to configure it themselves, with the reference below.

Configuration is done two ways: **slash commands** (operator-run — type them yourself; the agent cannot invoke them) and **manual edits** of the config JSON by the operator.

## Slash commands (primary — tell the user these)

- `/gate` — status: effective posture (endpoint, threshold, floors, fail mode), rule count, log path, session statistics.
- `/gate:rules` — list, add, remove, and test rules:
  - `/gate:rules` (list; shows project `p*`, user `u*`, then shipped defaults)
  - `/gate:rules add allow "ls ?*"` — user-level allow rule; `add deny "~/creds"` for a protected path
  - `--tool bash` scopes a rule to one tool; `--project` writes it at project level
  - `/gate:rules rm u2` removes user rule #2 as listed; `rm p1` removes a project rule
  - `/gate:rules test bash '{"command":"ls /tmp"}'` shows which rule a sample call hits
- `/gate:config` — show effective config, or set keys:
  - `/gate:config set threshold 0.9` — confidence threshold for autonomous allow/block
  - `/gate:config set floors.bash true` — re-add an ask floor (floored tools always ask unless a rule allows them)
  - `endpoint.model`, `endpoint.url` (full request URL), `endpoint.timeoutMs` — switch between local clef-flash, larger clef, or remote Jev endpoints
  - `log.level`, `log.maxLines`, `log.keepFiles`, `log.retentionDays` — decision-log behavior
  - append `--project` to set at project level (project overrides user, per ADR-0001)
- `/gate:log` — review decisions: `/gate:log 50 bash` tails the last 50 bash decisions. Use this to investigate why a call was allowed, blocked, or asked.

Note: `endpoint.apiKey` must be set by manual edit — the `set` command echoes values into notifications.

## Manual configuration (secondary)

- User level: `~/.pi/agent/gate/config.json` — safe defaults, applies everywhere.
- Project level: `.pi/gate/config.json` in the repo — read only after project trust is granted; overrides user per key.

Full schema with defaults and rule-matching semantics: the package README (`gatekeeper/README.md`), sections "Manual configuration" and "Rules".

When the user asks why a call was gated: the transparency line in the session and `/gate:log` give the classification, confidence, and the reason (ask floor, below-threshold, deny rule, or model failure) — walk them through it.
