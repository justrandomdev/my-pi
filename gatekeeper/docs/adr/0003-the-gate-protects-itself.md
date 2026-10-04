# The gate protects its own configuration

A compromised model reaches the gate's config through the very tool calls the gate judges — and with ask floors lifted, a self-serving `safe` classification could auto-allow a config edit that neuters the gate. We deny every agent tool call touching the gate's config or decision-log paths, checked before every rule and overridable by none of them.

## Considered Options

- **Ship deny rules for the gate paths as defaults**: rejected — rules evaluate project-first (ADR-0001), so a project or user rule could sit ahead of the deny, and that override would itself be written through the gate. A code-level check has no such window.
- **Rely on ask floors**: rejected — floors are per-tool config the operator can lift (and did, for bash).

## Consequences

- Self-protection precedes the `enabled` check: it holds even while the gate is disabled, so a disabled gate cannot be used as a door to re-enable the gate with weakened rules. Only a human edit can disable the gate.
- Deliberate tension with ADR-0001: project-level config cannot loosen self-protection. ADR-0001 governs the operator's choices about their repos; this is an invariant of the tool itself. The distinction holds because the operator never needs an agent tool call to configure the gate — slash commands are operator-run, and a manual edit happens outside the gate entirely.
- The operator can still disable the gate by hand: editing the config to `enabled: false` is a human action, not an agent tool call. The human's hands are outside the gate by construction.
- Residual: editing the extension's source in a development repo is not covered — source edits rely on the `edit`/`write` ask floors and operator review (see the README's security section).
