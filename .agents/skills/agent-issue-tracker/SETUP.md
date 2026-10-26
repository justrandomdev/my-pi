# agent-issue-tracker: fresh environment setup

Provisioning only — run when [SKILL.md](SKILL.md)'s commands fail with `auth: authentication failed` on a `AIT_HOME` that has no cached session, or the operator asks for a fresh tracker environment. Isolating `AIT_HOME` leaves the real config, session cache, and database untouched; everything lands in `$AIT_HOME/{config,state,data}`.

Environment script — reuse it in every shell that touch the tracker (sourcing is safe; it re-derives its own directory):

```bash
TESTDIR="$HOME/ait-cli-test"; mkdir -p "$TESTDIR/keys"
cat > "$TESTDIR/env.sh" <<'EOF'
export TESTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AIT_HOME="$TESTDIR"
export AIT_BACKEND=sqlite
export AIT_SQLITE_PATH="$TESTDIR/data/agent-issue-tracker.db"
unset AIT_AGENT AIT_ADMIN
EOF
source "$TESTDIR/env.sh"
```

Build once in the tool's checkout if `bin/agent-issue-tracker` is absent: `make build`.

One EC prime256v1 keypair per principal:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out "$TESTDIR/keys/<name>.key"
openssl ec -in "$TESTDIR/keys/<name>.key" -pubout -out "$TESTDIR/keys/<name>.pub" 2>/dev/null
```

First admin — `admin register` is the one unauthenticated mutation and reads its password from stdin:

```bash
printf 'testpass\n' | "$BIN" admin register root --public-key "$TESTDIR/keys/root.pub"
"$BIN" login --admin-identity root --key "$TESTDIR/keys/root.key"
export AIT_ADMIN=root
```

Workspace and project (a new workspace's status catalog comes seeded — see SKILL.md):

```bash
WS=$("$BIN" workspace create <name> | jq -r .id)
PRJ=$("$BIN" project create "$WS" <name> | jq -r .id)
```

Workers are registered by an admin, then log themselves in. Scope forms (exactly one): `workspace:<id>`, `project:<id>`, `projects:<id,...>`. Role breadth within scope: `own` = only entities the agent owns, `project` = any in scope:

```bash
"$BIN" agent register <name> --public-key <pub> --scope "project:$PRJ" --roles "Worker:project"
"$BIN" login --agent-identity <name> --key <keypath>
export AIT_AGENT=<name>
```

Switching principals: `unset` the old variable before exporting the new one — two set at once is an auth error (SKILL.md). Later changes go through an admin session: `admin assign-role` / `admin unassign-role`, `admin set-agent-scope`, `admin revoke-sessions <agent>` (forces the agent to log in again).
