# Gatekeeper Spec

## Problem Statement

Static guardrails either nag the operator on every risky-looking call — which breeds rubber-stamping, itself a security failure — or rely on fixed path patterns that miss indirect threats: a glob protecting `~/.zshrc` stops nothing from `cat`ing the rest of the folder, or from a script that loops over it. The operator needs asks to be rare and high-signal, and coverage that survives indirection.

## Solution

Gatekeeper: a pi plugin that gates every tool call through two layers. Static rules settle known decisions instantly and for free; a Jev/System One-compatible decision model (default: local Ollama `clef-flash`) classifies everything else as `safe`, `unsafe`, or `unsure` with a confidence score. Confident classifications act autonomously; everything else — `unsure`, low confidence, or an ask floor — goes to the operator. The default posture denies all: only `ls` and `find` are allowed by rule, and auto-allow is reserved for reads of unprotected paths. Every decision is shown to the operator and logged to a rotating, expiring JSONL decision log.

## User Stories

1. As an operator, I want every tool call to pass through the gate, so that nothing runs unexamined by default.
2. As an operator, I want `ls` and `find` allowed out of the box, so that routine exploration works without prompts.
3. As an operator, I want code execution (`bash`, `powershell`) to always reach me unless a rule explicitly allows it, so that no script runs on my machine without my say-so.
4. As an operator, I want file mutation (`edit`, `write`) to always reach me unless a rule explicitly allows it, so that the model's auto-allow is reserved for reads.
5. As an operator, I want confident `safe` classifications of unprotected reads to auto-allow, so that normal work isn't interrupted.
6. As an operator, I want confident `unsafe` classifications to auto-block, so that dangerous calls stop before running even when I'm not watching.
7. As an operator, I want `unsure` classifications and low-confidence reads to ask me, so that judgment calls are mine.
8. As an operator, I want to set the confidence threshold, so that I control how much autonomy the model gets.
9. As an operator, I want static rules evaluated before the model, so that known decisions are instant and cost nothing.
10. As an operator, I want to add, remove, view, and test rules via slash command, so that I manage the rule set without editing JSON by hand.
11. As an operator, I want approvals to become grants — once, for the session, or always-for-this-pattern — so that repeated prompts for the same thing stop.
12. As an operator, I want protected paths to match anywhere in a shell command's text, so that `cat`, pipelines, and inline scripts referencing them are caught.
13. As an operator, I want protected paths to match file-tool targets, so that `read`/`edit`/`write` on protected files is denied statically.
14. As an operator, I want protected paths included in the state the model sees, so that indirect access attempts are judged with that knowledge.
15. As an operator, I want a transparency line for every gated decision including auto-allows, so that I can audit what the gate silently permitted.
16. As an operator, I want every decision logged, so that I can review what the gate did and why.
17. As an operator, I want logs rotated after a configurable number of lines, so that the decision log never grows unbounded.
18. As an operator, I want rotated logs deleted after a configurable number of days, so that retention is bounded.
19. As an operator, I want to choose whether the log lives at user or project level, so that decisions land where I need them.
20. As an operator, I want arguments truncated in log records, so that the gate never copies secret contents into its own records.
21. As an operator, I want user-level config carrying safe defaults, so that every project starts protected.
22. As an operator, I want project-level config to override user-level, so that trusted projects can deliberately loosen the defaults for practical reasons.
23. As an operator, I want to configure the model endpoint — local Ollama `clef-flash` by default; remote clef, remote Jev, or any compatible service — so that I choose where classification runs.
24. As an operator, I want remote endpoints to make their egress explicit, so that sending call data off-machine is a conscious choice.
25. As an operator, I want model failure or timeout to route to me (or fail-block in headless mode), so that the gate never silently opens.
26. As an operator, I want decisions cached for the session, so that retries don't re-pay latency — while operator "allow once" stays once (never cached), and denied calls don't re-nag me.
27. As an operator, I want the operator prompt to show classification, confidence, tool, argument summary, and the model's reason, so that I can decide quickly and correctly.
28. As an operator, I want to edit the policy text, so that "what counts as unsafe" fits my environment.
29. As an operator, I want status and session statistics via slash command, so that I can see the gate's posture and activity at a glance.
30. As an operator, I want to tail and filter the decision log via slash command, so that incident review stays in-band.
31. As an operator, I want the state the model sees to exclude file contents and fetched text, so that the judge cannot be steered by what it judges.
32. As an operator, I want config changes hot-reloaded, so that tuning the gate doesn't require restarting pi.

## Implementation Decisions

- Two-layer gate: static rules first (allow/deny, tool plus path/argument patterns, first hit wins, skipping the model), then the model gate for everything rules don't settle.
- Self-protection (ADR-0003): agent tool calls touching the gate's own config or decision-log paths are always denied, before the enabled check and every rule, overridable by none. File-tool targets resolve against the cwd, and shell text is matched with `$HOME` expansion, dot-segment normalization, and `cd`-target resolution; encoded path spellings fall through to the model gate, which also sees the gate dirs as protected paths. The operator configures the gate via operator-run slash commands or manual edits.
- A `gatekeeper-config` skill ships with the package: it tells the agent it cannot configure the gate, and carries the slash-command reference and manual-config paths so the agent can explain configuration to the user.
- Decision matrix: `safe` at or above the threshold auto-allows; `unsafe` at or above auto-blocks; explicit `unsure` and anything below the threshold converge on ask. The threshold defaults to 0.85 and is configurable. Choice order lists `safe` first so ties fail toward asking.
- Default posture is deny-all: the shipped allow rules cover `ls` and `find` only.
- Ask floors: `bash`, `powershell`, `edit`, and `write` default to the `ask` floor — the model can block or escalate but never auto-allow them; only a rule or grant can. Auto-allow is reserved for reads of unprotected paths (floors are per-tool and configurable).
- Protected-path matching is target-anchored for file tools. Shell chains split into components (quotes respected): an allow rule must match every component (command substitution defeats an allow, falling to the model gate); a deny rule matches if any component matches. The protected-path list rides in the state sent to the model.
- State invariant: the state contains only the tool name, the agent's arguments, and the operator's current message, under a character budget. File contents, fetched text, and conversation history are never included.
- Policy: default policy text covering destructive operations, secret exposure, exfiltration, and out-of-scope writes; configurable, with protected paths injected into state automatically.
- Endpoint: a single active endpoint (base URL, model, optional API key, timeout defaulting to 30s — cold-start load of a large local model takes tens of seconds, warm calls are sub-second). Any Jev/System One-compatible service works; default is local Ollama `clef-flash` with `keep_alive` so the model stays warm. Failure or timeout routes to ask; a fail-block mode exists for headless use.
- Caching and grants: decisions cache for the session keyed by tool, arguments, and task; approvals offer once or always (always writes a grant rule, user-level by default); denials cache for the session.
- Transparency: one notify line per gated decision, including auto-allows.
- Decision log: JSONL, one active log at the level the effective config selects (default user-level); rotation after a configurable line count (default 10,000, keeping 10 files); deletion of rotated files after a configurable age (default 30 days); arguments truncated (2KB) and file contents never logged — write/edit content keys are redacted to size placeholders before they reach the model state (ADR-0002) or the log.
- Config: one config file per level; project overrides user per key (scalars) and in rule order (project rules evaluate before user rules, first hit wins).
- Slash commands: `/gate` (status and session stats), `/gate:rules` (view/add/remove/test), `/gate:config` (threshold, model, retention, floors, levels), `/gate:log` (tail/filter).
- Scope: replaces pi-guardrails entirely except its herdr integration.

See [adr/0001-project-overrides-user.md](adr/0001-project-overrides-user.md) and [adr/0002-decision-model-in-the-gate-path.md](adr/0002-decision-model-in-the-gate-path.md) for the two decisions that earned separate records.

## Testing Decisions

- Test external behavior only: what the gate decides for a call, not how it decides it.
- Primary seam (confirmed with the operator): the extension boundary — the tool-call handler exercised against a stubbed System One endpoint, asserting decisions (allow/block/ask), rule precedence, floor behavior, state contents, prompt payloads, and log records. Log rotation and retention assert against an injectable clock and line counts.
- One end-to-end smoke test loads the plugin via pi's single-run extension flag and exercises a gated call through the real runtime.
- Prior art: pi-guardrails ships extension tests alongside its source.

## Out of Scope

- Herdr integration (the one pi-guardrails piece not carried over).
- Onboarding wizard; the defaults are ready to run and tuned via `/gate`.
- Primary-plus-fallback endpoint arrangements; a single active endpoint, with failure routing to ask.
- Model fine-tuning or custom classification training.
- Gating human-issued slash commands or pi's own extension loading (pi's project-trust mechanism governs those).

## Further Notes

- Measure classification latency on the operator's actual hardware before release; the model is large and the gate sits on the critical path of every tool call.
- ADR-0002 names the accepted vulnerabilities: judge-steering (contained by the state invariant), silent false-allow (contained by floors and static protected paths), remote-endpoint egress, and the model-down ask storm.
- Residual: the decision log records truncated command arguments — secrets typed into commands land in it. Keep the log directory private.
- Residual: two concurrent pi sessions share one user-level decision log; rotation can race (fail-closed direction, at worst a lost log line).
- The spec's end-to-end smoke test (`pi -e`) has been exercised manually; automating it remains open.
