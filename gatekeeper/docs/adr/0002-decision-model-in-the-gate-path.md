# A decision model in the gate path

Static rules alone either nag the operator into rubber-stamping approvals — ask-fatigue is a security failure mode, not a UX nuisance — or miss indirect threats (exfiltration by script, by folder traversal, by written-then-run code). We put a decision model in the hot path of every tool call instead: a Jev/System One-compatible model (default local `clef-flash`) classifies each call `safe`/`unsafe`/`unsure` with confidence, and confident classifications act autonomously. The model's job is making asks rare and high-signal so operator attention stays meaningful.

## Consequences

The accepted vulnerabilities, named:

- **The judge can be steered by what it judges.** The model reads arguments that may embed text absorbed from untrusted sources. Contained by a state invariant: the state is only the tool name, the agent's arguments, and the operator's current message — never file contents, fetched text, or conversation history.
- **Confident-but-wrong is silent.** The model's confidence is concentration of probabilities, not probability of correctness, and a false `safe` auto-allows without a prompt. Contained by confining the delegable surface: ask floors on `bash`, `powershell`, `edit`, and `write`; protected paths decided by static rules only; auto-allow reserved for reads of unprotected paths.
- **Remote endpoints are data egress by design.** Configuring a remote clef/Jev endpoint sends every gated call's tool name, arguments, and current task text off-machine. Local-first is the default; remote must be a conscious choice.
- **Every tool call gains a latency and availability dependency.** The model is large; the gate sits on the critical path. Session caching and model keep-alive mitigate; when the model is down every call degrades to ask (an ask storm in exactly the mode where fatigue sets in), with fail-block available for headless use.

The rejected alternative — static deny-all with operator confirmation on everything — fails operationally within days, when approvals stop being read.
