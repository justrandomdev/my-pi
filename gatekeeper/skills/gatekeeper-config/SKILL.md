---
name: gatekeeper-config
description: Explains how the operator configures the pi gatekeeper plugin — rules, threshold, ask floors, model endpoint, decision log. Use when the user asks about configuring or tuning gatekeeper, asks why a call was gated or blocked, or wants a gate setting changed.
---

# Gatekeeper configuration guidance

You cannot configure gatekeeper, and you cannot read its config, decision log, or secrets definitions: every agent tool call touching them is always denied, before any rule (self-protection). Do not attempt edits, reads, or shell workarounds — they are always blocked, including attempts to allow them. Your job here is to explain to the operator how to configure it themselves, with the reference below.

Configuration is done two ways: **slash commands** (operator-run — type them yourself; the agent cannot invoke them) and **manual edits** of the config JSON by the operator.

## Slash commands (primary — tell the user these)

- `/gate` — status: effective posture (endpoints, multi-endpoint mode, threshold, floors, fail mode), rule count, log path, session statistics. With multi-endpoint configs set, it also selects the jury member `modelSelect` serves:
  - `/gate model` — list the configured endpoints and who is serving
  - `/gate model <name>` — select the endpoint `modelSelect` serves, persisted at user level (`--project` supported); unknown name → warning with the candidates
- `/gate:rules` — list, add, remove, and test rules:
  - `/gate:rules` (list; shows project `p*`, user `u*`, then shipped defaults)
  - `/gate:rules add allow "ls ?*"` — user-level allow rule; `add deny "~/creds"` for a protected path
  - `--tool bash` scopes a rule to one tool; `--project` writes it at project level
  - `/gate:rules rm u2` removes user rule #2 as listed; `rm p1` removes a project rule
  - `/gate:rules test bash '{"command":"ls /tmp"}'` shows which rule a sample call hits
- `/gate:config` — show effective config, or set keys:
  - `/gate:config set threshold 0.9` — confidence threshold for autonomous allow/block (auto-allow also requires the model's unsafe probability ≤ 0.1, a fixed bound)
  - `endpoint.model`, `endpoint.url` (full request URL), `endpoint.timeoutMs` — switch between local clef-flash, larger clef, or remote Jev endpoints
  - `endpoints.<name>.url` / `.model` / `.timeoutMs` — set a field on a jury member (ADR-0006) by its resolved name; the entries themselves are configured by a manual edit of the `endpoints` array
  - `multiEndpointMode` — `modelSelect` (default) | `jury` | `fallback` (ADR-0007): how multiple endpoints act. To resume ADR-0006 model evaluation, `/gate:config set multiEndpointMode jury`. To serve only the first entry when a judge is down, `/gate:config set multiEndpointMode fallback`. An invalid value is a config error, never silently defaulted
  - `selectedEndpoint` — the endpoint `modelSelect` serves by resolved name (`/gate model <name>` is the friendlier path)
  - `/gate:config test bash '{"command":"ls /tmp"}'` — fan the sample call out to every configured endpoint and list the verdicts side by side (jury comparison)
  - `secrets.enabled`, `secrets.autoUpdate`, `secrets.source` — the deterministic secrets engine
  - `log.level`, `log.maxLines`, `log.keepFiles`, `log.retentionDays` — decision-log behavior
  - append `--project` to set at project level (project overrides user per key)
- `/gate:secrets` — the secrets engine: status (rules active, source, last update), `update` (force a refresh), `test "<text>"` (which rule matches a sample string, masked). A secret-shaped tool call of yours will be blocked before the model with the rule id — if it is a false positive (a fake key in a test fixture, for example), the operator suppresses it in `~/.pi/agent/gate/secrets.toml` (`[[allow]]` with the rule id and a `path`), never by weakening the rules.
- `/gate:log` — review decisions: `/gate:log 50 bash` tails the last 50 bash decisions. Use this to investigate why a call was allowed, blocked, or asked.

Note: `endpoint.apiKey` is settable via `set` — the echoed value is redacted as `***`, so the key never lands in a notification.

## Manual configuration (secondary)

- User level: `~/.pi/agent/gate/config.json` — safe defaults, applies everywhere.
- Project level: `.pi/gate/config.json` in the repo — read only after project trust is granted; overrides user per key.
- Secrets: `~/.pi/agent/gate/gitleaks.toml` (machine-managed snapshot — auto-updated, do not edit) and `~/.pi/agent/gate/secrets.toml` (the operator's own rules and false-positive suppressions — the updater never touches it). Both live where agent tool calls are always denied.

Full schema with defaults and rule-matching semantics: the package README (`gatekeeper/README.md`), sections "Manual configuration" and "Rules".

When the user asks why a call was gated: the transparency line in the session and `/gate:log` give the classification, confidence, and the reason (below-threshold, unsafe-probability bound, deny rule, or model failure) — walk them through it.
