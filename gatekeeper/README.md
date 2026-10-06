# Gatekeeper

A pi plugin that gates every agent tool call through deterministic secret detection, static rules, and a decision model — the model is the primary classifier, so destructive, secret-exposing, or out-of-scope actions stop before they run while operator prompts stay rare and high-signal.

Full design: [docs/spec.md](docs/spec.md). Decisions worth knowing: the [ADR index](docs/adr/).

## How a call is decided

Every tool call passes through the gate, in order:

1. **Self-protection** — calls touching the gate's own config, log, or secrets definitions are always denied, `realpath`-resolved so symlink chains are caught too. Not overridable by any rule. See [ADR-0003](docs/adr/0003-the-gate-protects-itself.md).
2. **Secrets detection** — the gitleaks corpus (~220 rules, compiled to a JS regex subset) scans the full command and file contents. A hit blocks before every rule and the model, masked (`sk-…(51 chars)`), overridable only by your `secrets.toml`. See [ADR-0004](docs/adr/0004-deterministic-secret-detection.md).
3. **Rules** — ordered allow/deny entries (project rules first, then user, then shipped defaults). First hit wins; a fast-path, not a guard.
4. **The model gate** — a Jev/System One-compatible decision model (default: local Ollama `clef-flash`) classifies the call `safe`, `unsafe`, or `unsure` with a confidence score. **The model is the primary classifier** ([ADR-0005](docs/adr/0005-the-decision-model-is-the-primary-classifier.md)): `safe` ≥ threshold **and** an unsafe probability ≤ 0.1 (a fixed bound) → auto-allow (any tool); `unsafe` ≥ threshold → auto-block; everything else → operator.
5. **The operator** — a bordered prompt (classification and probabilities colored green/red/yellow) with `a: allow · n/esc: deny`. Nothing persists from a prompt; persistent allows are explicit rules.

Model failure or timeout routes to the operator (`failMode: ask`) or blocks (`failMode: block`, for headless use).

## Security model

- **The agent cannot configure the gate.** Every agent tool call touching the gate's config, decision log, or secrets definitions (`gitleaks.toml`, `secrets.toml`) is denied before any rule — a steered model cannot neuter the gate through the gate. File-tool targets resolve against the working directory and are `realpath`'d, so relative spellings (`.pi/gate/config.json`) and symlink chains into the gate dir are caught. This holds even while the gate is `enabled: false`; only a human edit can change that state.
- **Secret exfiltration never reaches a judge or a rubber stamp.** A deterministic gitleaks-sourced scan runs before every rule and the model; a hit blocks with the rule id and a masked match, never the secret itself. The only override is your `secrets.toml` — which lives where agent tool calls are always denied.
- **Slash commands are operator-run** — typed by you in the TUI, never issued by the agent.
- **Manual edits are human actions** — your editor is outside the gate.
- **Remote endpoints are data egress**: configuring a remote clef/Jev endpoint sends every gated call's tool name, the first 100 characters of its arguments, the working directory, and the current task to that service (ADR-0002). Local-first is the default. The secrets auto-update fetch is operator-configured (`secrets.source`) and failure keeps the last snapshot.
- **Ask fatigue is a security failure, not a UX nuisance.** The model is the primary classifier (ADR-0005) precisely so the operator is asked only when the model is genuinely uncertain. The accepted tradeoff: a confident-but-wrong `safe` can auto-allow any tool — contained by the deterministic layers ahead of the model and the threshold, not by forced asks.
- Residual: editing gatekeeper's *source* in a dev repo isn't covered by self-protection; it relies on the decision model and operator review.
- Residual: self-protection matches literal, `$HOME`-expanded, dot-segment-normalized, and `realpath`-resolved paths — obfuscated spellings (base64, dynamic paths, shell variables) fall through to the model gate, which sees the gate dirs as protected paths.
- Residual: the decision log records the first 100 characters of arguments — a short secret inside them lands in `decisions.jsonl`. The log directory is created `0o700`; rotate with `log.retentionDays`.
- Residual: secrets past the 256KB per-call scan cap, and obfuscations the gitleaks corpus doesn't cover, fall through to the model gate.

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
  "threshold": 0.65,
  "endpoint": {
    "url": "http://localhost:11434/v1/systemone",
    "model": "clef-flash",
    "apiKey": "…",
    "timeoutMs": 30000,
    "keepAlive": "10m"
  },
  "policy": "…what counts as unsafe…",
  "failMode": "ask",
  "stateBudgetChars": 4000,
  "log": {
    "level": "user",
    "maxLines": 10000,
    "keepFiles": 10,
    "retentionDays": 30,
    "truncateArgsBytes": 2048
  },
  "secrets": {
    "enabled": true,
    "autoUpdate": true,
    "source": "https://raw.githubusercontent.com/gitleaks/gitleaks/refs/heads/master/config/gitleaks.toml"
  },
  "rules": [ … ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` passes everything through ungated — except self-protection, which applies whenever the gate is loaded. |
| `threshold` | `0.65` | Minimum confidence for autonomous allow/block. Auto-allow additionally requires the model's unsafe probability ≤ 0.1 (a fixed bound, not configurable). Below either: operator. |
| `endpoint.url` | `http://localhost:11434/v1/systemone` | Full request URL of a Jev/System One-compatible service — the gate POSTs here verbatim. |
| `endpoint.model` | `clef-flash` | Any model the endpoint serves (`clef`, a remote Jev, …). |
| `endpoint.apiKey` | — | Bearer token for remote services. Set this by manual edit only — the `set` command echoes values into notifications. |
| `endpoint.timeoutMs` | `30000` | Cold-start load of a large local model takes tens of seconds; warm calls are sub-second. |
| `endpoint.keepAlive` | `"10m"` | Ollama-only; keeps the model warm between calls. Set `""` for strict endpoints (e.g. Cloudflare) that reject extra fields. |
| `policy` | built-in text | What counts as unsafe — sent to the model as classification instructions. |
| `failMode` | `"ask"` | Model down/timeout: `"ask"` routes to the operator, `"block"` denies (headless). |
| `stateBudgetChars` | `4000` | Character cap on the **task text** the model sees; arguments are capped to a fixed 100 characters (ADR-0002/0005). |
| `notify` | `"always"` | Transparency-line verbosity: `"always"` notifies every decision; `"summary"` notifies only blocks/asks; `"off"` suppresses all notifications; `"debug"` is `always` **plus** a dump of the full model request and answer per classification (opt-in diagnostics — the request includes the 100-char arguments view verbatim). The decision log is unaffected. |
| `log.level` | `"user"` | Where the decision log lives: `~/.pi/agent/gate/` or `.pi/gate/`. One active log. |
| `log.maxLines` | `10000` | Rotate after this many lines. |
| `log.keepFiles` | `10` | Rotated files kept (`decisions.jsonl.1` … `.10`). |
| `log.retentionDays` | `30` | Rotated files older than this are deleted. |
| `log.truncateArgsBytes` | `2048` | Cap on the argument preview shown in the **operator prompt**; the model and the log see only the first 100 characters. |
| `secrets.enabled` | `true` | The deterministic secrets engine (ADR-0004). One switch — a disabled gate turns it off too. |
| `secrets.autoUpdate` | `true` | Fetch `secrets.source` on start and adopt it when it passes the sanity gates. |
| `secrets.source` | gitleaks master | The gitleaks.toml source URL. Pin a release tag by changing it. |
| `rules` | `ls`/`find` allowed | Ordered; see below. |

### Rules

```json
{ "action": "allow", "tools": ["bash"], "pattern": "ls ?*", "reason": "optional" }
```

- `action`: `"allow"` or `"deny"`.
- `tools`: tool names; omit for any tool.
- `pattern`: a glob; `~` expands to home. Omit for any arguments.

Matching is asymmetric for safety:

- **File tools** (`read`, `edit`, `write`): the pattern matches the path target, fully (`~/.zshrc` protects exactly that file; `~/*` one level; `~/**` everything below). Targets resolve against the working directory, so absolute patterns catch relative spellings; a glob-free **deny** also covers everything beneath the pattern (`~/creds` protects `~/creds/token` too — a file can never sit beneath a file, so this widens directories only).
- **Shell commands** (`bash`, `powershell`) are split into components on `&&`, `||`, `;`, `|`, `&`, and newlines, quotes respected:
  - an **allow** must match *every* component — `ls /a && rm -rf /b` fails an `ls ?*` rule; a glob-free allow pattern (`ls -la /tmp`) matches the component *exactly* — `ls -la /tmpsecrets` does not ride through (write `ls -la /tmp *` for prefix behavior);
  - a **deny** matches if *any* component matches — `ls /a && cat ~/.creds` is denied by `~/creds`;
  - `*` and `**` cross everything (spaces, slashes); a **leading `*`** opts an allow out of start-anchoring (`*ls*` matches anywhere in a component);
  - **command substitution** (`$(…)`, backticks, `>(…)`) and **file-target redirects** (`> out`, `>> file`, `< in`) defeat an allow — the call falls to the model gate. Redirects to `/dev/null` and fd duplication (`2>&1`) are inert.
- **Other tools**: like shell text, over the serialized arguments.

### Secrets detection

Deterministic, gitleaks-sourced (ADR-0004), running before every rule and the model on every call. Two files, both in the gate dir (agent tool calls touching them are always denied):

- **`~/.pi/agent/gate/gitleaks.toml`** — the machine-managed snapshot, auto-updated from `secrets.source` on start. Do not edit it; the updater overwrites it. Pin a release tag via `/gate:config set secrets.source …`.
- **`~/.pi/agent/gate/secrets.toml`** — yours; the updater never touches it. Two shapes:

```toml
# extra rules, gitleaks-shaped — copy verbatim out of upstream's file
[[rules]]
id = "my-internal-token"
regex = "mycorp_[a-z0-9]{24}"
keywords = ["mycorp_"]

# false-positive suppressions: id plus optional match (the matched text)
# and path (the tool's target path) — every present condition must hold
[[allow]]
id = "aws-access-token"
match = "^AKIAEXAMPLE"
path = "^/home/op/tests/"
```

The scan covers the full `bash`/`powershell` command and the full serialized arguments of other tools (`write`/`edit` content included), capped at 256KB per call. Hits block with the rule id and a masked match (`AKI…(20 chars)`) — the secret is never reprinted in a notification or the log. Note: agents legitimately writing fake secrets (test fixtures, docs) will be blocked — that's fail-closed by design; suppress via `[[allow]]` with a `path`, not by weakening rules.

### The decision log

`decisions.jsonl` (plus rotated `.1`, `.2`, …) — one JSON line per decision: timestamp, tool, the same first-100-character argument view the model saw (plus the total length; a secrets block logs a constant in the args column — a detected secret never lands in this log), action, source (`rule` / `model` / `operator` / `fail` / `protected` / `secrets` / `disabled`), classification, confidence, and the reason. Full file contents never reach the model state (ADR-0002) or this log — but a short secret the corpus misses, inside the first 100 characters of a command, is an argument and does land here.

## Slash commands

All commands are operator-run; the agent cannot invoke them.

### `/gate` — status

Shows the effective posture: enabled, endpoint (model @ url), threshold, fail mode, secrets engine (rules active, last update), rule count, active log path, and session statistics.

### `/gate:secrets` — the secrets engine

```
/gate:secrets                            status: rules active, source, last update, file paths
/gate:secrets update                     force a refresh now (reports the outcome)
/gate:secrets test "AKIAIOSFODNN7EXAMPLA"  which rule matches a sample string (masked)
```

The auto-update runs in the background on start and reports only on change or failure.

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
/gate:config set endpoint.url https://…
/gate:config set endpoint.timeoutMs 60000
/gate:config set secrets.autoUpdate false     stop the background auto-update
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

Every decision is also shown live as a one-line transparency notification (default `notify: "always"`); set `notify: "summary"` to silence auto-allow notifications, or `notify: "off"` to suppress transparency entirely. `notify: "debug"` additionally dumps the exact request body posted to the decision model and the answer it acted on, for every classification — the way to see precisely what the judge saw and concluded. Auto-allows are still recorded in the decision log regardless.

## Model endpoints

The gate speaks the System One API (`/v1/systemone`), compatible with Ollama's decision models and remote Jev services:

```json
{ "endpoint": { "url": "http://localhost:11434/v1/systemone", "model": "clef-flash" } }
```

Swap `model` for `clef` (larger, more accurate) or point `url` at a remote service with an `apiKey`. Decision endpoints accept the tool name, the first 100 characters of the arguments, the working directory (so out-of-scope-write judgments are decidable), and the capped current task — nothing else (ADR-0002's judge-steering invariant).
