# Gatekeeper

A pi plugin that gates every agent tool call through static rules and a decision model, so destructive, secret-exposing, or out-of-scope actions stop before they run — while keeping operator prompts rare and high-signal.

Full design: [docs/spec.md](docs/spec.md). Decisions worth knowing: the [ADR index](docs/adr/).

## How a call is decided

Every tool call passes through the gate, in order:

1. **Self-protection** — calls touching the gate's own config or log are always denied. Not overridable by any rule. See [ADR-0003](docs/adr/0003-the-gate-protects-itself.md).
2. **Rules** — ordered allow/deny entries (project rules first, then user, then shipped defaults). First hit wins; no model call, no prompt.
3. **Session cache** — an identical call in the same task reuses its decision.
4. **The model gate** — a Jev/System One-compatible decision model (default: local Ollama `clef-flash`) classifies the call `safe`, `unsafe`, or `unsure` with a confidence score.
   - `safe` ≥ threshold → auto-allow; `unsafe` ≥ threshold → auto-block; everything else → operator.
   - **Ask floors**: tools with a floor (default: `bash`, `powershell`, `edit`, `write`) always reach the operator unless a rule allows them — the model can block or escalate, never auto-allow.
5. **The operator** — a bordered prompt (classification colored green/red/yellow) with `y: allow once · a: allow always · n/esc: deny`. "Allow always" writes a grant rule.

Model failure or timeout routes to the operator (`failMode: ask`) or blocks (`failMode: block`, for headless use).

## Security model

- **The agent cannot configure the gate.** Every agent tool call touching the gate's config or decision-log paths is denied before any rule — a compromised model cannot neuter the gate through the gate. This holds even while the gate is `enabled: false`; only a human edit can change that state.
- **Slash commands are operator-run** — typed by you in the TUI, never issued by the agent.
- **Manual edits are human actions** — your editor is outside the gate.
- **Remote endpoints are data egress**: configuring a remote clef/Jev endpoint sends every gated call's tool name, arguments, and current task to that service (ADR-0002). Local-first is the default.
- Residual: editing gatekeeper's *source* in a dev repo isn't covered by self-protection; it relies on the `edit`/`write` ask floors and operator review.
- Residual: self-protection matches literal, `$HOME`-expanded, and dot-segment-normalized paths in shell text — encoded or obfuscated path spellings fall through to the model gate rather than being denied outright. The static `cd`-into-gate check tracks `cd` chains across the components of a shell chain (so `cd ~ && cd .pi/agent/gate` is caught) but does not track shell variables or dynamic paths — those still fall through to the model gate.
- Residual: the decision log records command arguments (truncated). A secret passed inside a command (`curl -H "Authorization: Bearer …"`) lands in `decisions.jsonl` — the gate creates the log directory with mode `0o700` so other local users can't read it, and rotates with `log.retentionDays`.

## Manual configuration

Config lives in two levels (JSON):

- **User**: `~/.pi/agent/gate/config.json` — your safe defaults, every project.
- **Project**: `.pi/gate/config.json` in the repo root — read only after pi's project trust is granted.

**Precedence (ADR-0001): defaults < user < project, per key.** Rules evaluate in order: project, user, then the shipped defaults (`ls`/`find` allowed), so a scoped rule can override a default but the default posture survives.

Both files are optional; missing keys fall through to defaults. A shipped skill (`gatekeeper-config`) tells agents how to explain all of this to you — the agent cannot edit these files itself.

### Schema

```json
{
  "enabled": true,
  "threshold": 0.85,
  "endpoint": {
    "baseUrl": "http://localhost:11434",
    "model": "clef-flash",
    "apiKey": "…",
    "timeoutMs": 30000,
    "keepAlive": "10m"
  },
  "policy": "…what counts as unsafe…",
  "floors": { "bash": true, "powershell": true, "edit": true, "write": true },
  "failMode": "ask",
  "cache": true,
  "stateBudgetChars": 4000,
  "log": {
    "level": "user",
    "maxLines": 10000,
    "keepFiles": 10,
    "retentionDays": 30,
    "truncateArgsBytes": 2048
  },
  "rules": [ … ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` passes everything through ungated — except self-protection, which applies whenever the gate is loaded. |
| `threshold` | `0.85` | Minimum confidence for autonomous allow/block. Below it: operator. |
| `endpoint.baseUrl` | `http://localhost:11434` | Base of a Jev/System One-compatible service. The gate calls `${baseUrl}/v1/systemone`. |
| `endpoint.model` | `clef-flash` | Any model the endpoint serves (`clef`, a remote Jev, …). |
| `endpoint.apiKey` | — | Bearer token for remote services. Set this by manual edit only — the `set` command echoes values into notifications. |
| `endpoint.timeoutMs` | `30000` | Cold-start load of a large local model takes tens of seconds; warm calls are sub-second. |
| `endpoint.keepAlive` | `"10m"` | Keeps the model warm between calls. |
| `policy` | built-in text | What counts as unsafe — sent to the model as classification instructions. |
| `floors` | bash, powershell, edit, write floored | Per-tool ask floor. `true` = always ask unless a rule allows. |
| `failMode` | `"ask"` | Model down/timeout: `"ask"` routes to the operator, `"block"` denies (headless). |
| `cache` | `true` | Session decision cache, keyed by tool + arguments + task. |
| `stateBudgetChars` | `4000` | Character cap on what the model sees. |
| `notify` | `"always"` | Transparency-line verbosity: `"always"` notifies every decision; `"summary"` notifies only blocks/asks; `"off"` suppresses all notifications. The decision log is unaffected. |
| `log.level` | `"user"` | Where the decision log lives: `~/.pi/agent/gate/` or `.pi/gate/`. One active log. |
| `log.maxLines` | `10000` | Rotate after this many lines. |
| `log.keepFiles` | `10` | Rotated files kept (`decisions.jsonl.1` … `.10`). |
| `log.retentionDays` | `30` | Rotated files older than this are deleted. |
| `log.truncateArgsBytes` | `2048` | Arguments are truncated to this in every record; file contents are never logged. |
| `rules` | `ls`/`find` allowed | Ordered; see below. |

### Rules

```json
{ "action": "allow", "tools": ["bash"], "pattern": "ls ?*", "reason": "optional" }
```

- `action`: `"allow"` or `"deny"`.
- `tools`: tool names; omit for any tool.
- `pattern`: a glob; `~` expands to home. Omit for any arguments.

Matching is asymmetric for safety:

- **File tools** (`read`, `edit`, `write`): the pattern matches the path target, fully (`~/.zshrc` protects exactly that file; `~/*` one level; `~/**` everything below).
- **Shell commands** (`bash`, `powershell`) are split into components on `&&`, `||`, `;`, `|`, `&`, and newlines, quotes respected:
  - an **allow** must match *every* component — `ls /a && rm -rf /b` fails an `ls ?*` rule;
  - a **deny** matches if *any* component matches — `ls /a && cat ~/.creds` is denied by `~/creds`;
  - `*` and `**` cross everything (spaces, slashes); a **leading `*`** opts an allow out of start-anchoring (`*ls*` matches anywhere in a component);
  - **command substitution** (`$(…)`, backticks, `>(…)`) and **file-target redirects** (`> out`, `>> file`, `< in`) defeat an allow — the call falls to the model gate. Redirects to `/dev/null` and fd duplication (`2>&1`) are inert.
- **Other tools**: like shell text, over the serialized arguments.

Operators approve "always" from a prompt to write a grant rule (exact command or path) at user level.

### The decision log

`decisions.jsonl` (plus rotated `.1`, `.2`, …) — one JSON line per decision: timestamp, tool, truncated arguments, action, source (`rule` / `model` / `operator` / `cache` / `fail` / `protected` / `disabled`), classification, confidence, and the reason. It never contains file contents or full unbounded arguments — but note that secrets typed *into commands* are arguments, and do land here truncated.

## Slash commands

All commands are operator-run; the agent cannot invoke them.

### `/gate` — status

Shows the effective posture: enabled, endpoint (model @ baseUrl), threshold, floors, fail mode, rule count, active log path, and session statistics (allowed / blocked / asked).

### `/gate:rules` — manage rules

```
/gate:rules                                     list rules (project p*, user u*, then defaults)
/gate:rules add allow "ls ?*"                   add a user-level allow rule
/gate:rules add deny "~/creds"                  deny reads/edits/exfiltration of ~/creds
/gate:rules add allow "grep ?*" --tool bash    tool-scoped rule
/gate:rules add deny "~/.ssh/**" --project      project-level rule
/gate:rules rm u2                               remove user rule #2 (as listed)
/gate:rules test bash '{"command":"ls /tmp"}'   which rule matches a sample call
```

### `/gate:config` — show or set configuration

```
/gate:config                                    show effective config
/gate:config set threshold 0.9                  user-level key
/gate:config set endpoint.model clef            dotted endpoint keys
/gate:config set endpoint.baseUrl https://…
/gate:config set endpoint.timeoutMs 60000
/gate:config set floors.bash true               re-add a lifted ask floor
/gate:config set log.level project              log into the repo
/gate:config set threshold 0.8 --project        project-level override (ADR-0001)
```

`endpoint.apiKey` is deliberately manual-edit-only — the command echoes values into notifications.

### `/gate:log` — review decisions

```
/gate:log                last 20 decisions
/gate:log 50             last 50
/gate:log 20 bash        last 20 bash decisions
```

Every decision is also shown live as a one-line transparency notification (default `notify: "always"`); set `notify: "summary"` to silence auto-allow notifications, or `notify: "off"` to suppress transparency entirely. Auto-allows are still recorded in the decision log regardless.

## Model endpoints

The gate speaks the System One API (`/v1/systemone`), compatible with Ollama's decision models and remote Jev services:

```json
{ "endpoint": { "baseUrl": "http://localhost:11434", "model": "clef-flash" } }
```

Swap `model` for `clef` (larger, more accurate) or point `baseUrl` at a remote service with an `apiKey`. Decision endpoints accept the tool name, arguments, and current task — nothing else (ADR-0002's judge-steering invariant).
