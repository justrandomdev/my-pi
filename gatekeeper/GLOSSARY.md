# Gatekeeper

A pi plugin that gates every tool call through static rules and a decision model, so destructive, secret-exposing, or out-of-scope actions stop before they run.

## Language

**Gate**:
The decision layer every tool call passes through: rules first, then the model, then the operator if neither settles it.
_Avoid_: guardrail, filter

**Rule**:
A static allow or deny entry matching a tool plus path/argument patterns; first hit wins and skips the model.
_Avoid_: policy, permission

**Classification**:
The decision model's judgment of a call: `safe`, `unsafe`, or `unsure`.
_Avoid_: verdict, rating

**Confidence**:
How concentrated the model's probabilities are, from 0 to 1. Not the probability the classification is correct.
_Avoid_: probability, score

**Threshold**:
The minimum confidence at which a `safe` or `unsafe` classification acts autonomously; below it, the call goes to the operator.
_Avoid_: cutoff

**Decision**:
The final action on a call: allow, block, or ask.
_Avoid_: verdict, outcome

**Operator**:
The human who approves or denies a call at the ask step.
_Avoid_: user (collides with "user level")

**Grant**:
An operator approval persisted as a rule: once, or always-for-this-pattern.
_Avoid_: permission, whitelist entry

**Protected path**:
A path or glob whose contents must not be read, modified, or exfiltrated.
_Avoid_: blocked file, restricted file

**Chain**:
A shell command joined by separators (`&&`, `||`, `;`, `|`, `&`); rules evaluate it component by component, quotes respected.
_Avoid_: compound command, command line

**State**:
The payload sent to the model for classification: tool name, arguments, and the current task.
_Avoid_: prompt, context

**Ask floor**:
A per-tool minimum action: classification can block or escalate to the operator, but never auto-allow beneath it.
_Avoid_: deny floor, minimum permission

**Policy**:
The configurable text defining what counts as unsafe, sent to the model as classification instructions.
_Avoid_: criteria, rules text

**Decision log**:
The JSONL record of every gate decision, with line-count rotation and day-based retention.
_Avoid_: audit trail, history
