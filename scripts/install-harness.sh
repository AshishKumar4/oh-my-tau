#!/usr/bin/env bash
# Build and install oh-my-pi with Claude Code / Codex harness impersonation,
# then record the vendor prompt captures the feature needs.
#
# The captures cannot ship in the repo: they are the vendor's proprietary system
# prompt text. This script records them locally from your own licensed clients.
#
# Usage:
#   ./scripts/install-harness.sh                 # build, install, record captures
#   ./scripts/install-harness.sh --record-only   # skip the build, just record
#   ./scripts/install-harness.sh --build-only    # skip recording
#   ./scripts/install-harness.sh --help

set -euo pipefail

REPO="${OMP_HARNESS_REPO:-https://github.com/AshishKumar4/oh-my-tau.git}"
BRANCH="${OMP_HARNESS_BRANCH:-main}"
SRC_DIR="${OMP_HARNESS_SRC:-$HOME/.omp/src/oh-my-pi}"
CACHE_DIR="${OMP_HARNESS_CACHE_DIR:-$HOME/.omp/cache/harness}"
DO_BUILD=1
DO_RECORD=1

for arg in "$@"; do
	case "$arg" in
		--record-only) DO_BUILD=0 ;;
		--build-only) DO_RECORD=0 ;;
		-h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
	esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

free_port() {
	# Ask the kernel for an unused loopback port instead of guessing.
	python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}

# ─── preflight ──────────────────────────────────────────────────────────────

say "Checking prerequisites"
command -v git >/dev/null || die "git is required"
command -v python3 >/dev/null || die "python3 is required (port allocation, JSON edits)"
if [ "$DO_BUILD" = 1 ]; then
	command -v bun >/dev/null || die "bun is required to build. Install: curl -fsSL https://bun.sh/install | bash"
	command -v cargo >/dev/null || die "cargo is required: the native addon is compiled from Rust. Install: https://rustup.rs"
	echo "  bun   $(bun --version)"
	echo "  cargo $(cargo --version | cut -d' ' -f2)"
fi
if [ "$DO_RECORD" = 1 ]; then
	command -v claude >/dev/null || warn "\`claude\` not found: the Claude Code capture will be skipped"
	command -v codex >/dev/null || warn "\`codex\` not found: the Codex capture will be skipped"
fi

# ─── build ──────────────────────────────────────────────────────────────────

if [ "$DO_BUILD" = 1 ]; then
	say "Fetching source ($BRANCH)"
	if [ -d "$SRC_DIR/.git" ]; then
		git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
		git -C "$SRC_DIR" checkout -q FETCH_HEAD
	else
		mkdir -p "$(dirname "$SRC_DIR")"
		git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC_DIR"
	fi
	echo "  $(git -C "$SRC_DIR" log --oneline -1)"

	say "Installing dependencies"
	(cd "$SRC_DIR" && bun install --frozen-lockfile)

	say "Building the native addon (Rust, takes a few minutes)"
	(cd "$SRC_DIR" && bun run build:native)

	say "Compiling the omp binary"
	(cd "$SRC_DIR/packages/coding-agent" && bun scripts/build-binary.ts)
	BUILT="$SRC_DIR/packages/coding-agent/dist/omp"
	[ -x "$BUILT" ] || die "build produced no binary at $BUILT"

	# Install beside an existing omp if there is one, else a sane default.
	TARGET="$(command -v omp || true)"
	[ -n "$TARGET" ] || TARGET="$HOME/.local/bin/omp"
	mkdir -p "$(dirname "$TARGET")"
	if [ -f "$TARGET" ]; then
		BACKUP="$HOME/.omp/omp-backup-$("$TARGET" --version 2>/dev/null | tr -d '/' || echo previous)"
		cp "$TARGET" "$BACKUP"
		echo "  backed up existing binary -> $BACKUP"
	fi
	say "Installing to $TARGET"
	install -m 755 "$BUILT" "$TARGET"
	hash -r 2>/dev/null || true
	echo "  installed $("$TARGET" --version)"
fi

OMP="$(command -v omp || echo "$HOME/.local/bin/omp")"
[ -x "$OMP" ] || die "omp not found on PATH; run without --record-only first"

# ─── record captures ────────────────────────────────────────────────────────

if [ "$DO_RECORD" = 0 ]; then
	say "Done (recording skipped)"
	exit 0
fi

BROKER_PORT="$(free_port)"
GATEWAY_PORT="$(free_port)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/omp-harness-record.XXXXXX")"
BROKER_PID=""
GATEWAY_PID=""

cleanup() {
	restore_claude_config
	[ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
	[ -n "$BROKER_PID" ] && kill "$BROKER_PID" 2>/dev/null || true
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

wait_for_port() {
	local port="$1" tries=0
	while [ "$tries" -lt 100 ]; do
		if python3 -c "import socket,sys;s=socket.socket();s.settimeout(0.2);sys.exit(0 if s.connect_ex(('127.0.0.1',$port))==0 else 1)"; then
			return 0
		fi
		sleep 0.3
		tries=$((tries + 1))
	done
	return 1
}

say "Starting the local auth broker (127.0.0.1:$BROKER_PORT)"
"$OMP" auth-broker serve --bind "127.0.0.1:$BROKER_PORT" >"$WORK_DIR/broker.log" 2>&1 &
BROKER_PID=$!
wait_for_port "$BROKER_PORT" || { cat "$WORK_DIR/broker.log" >&2; die "broker did not start"; }

TOKEN_FILE="$HOME/.omp/auth-broker.token"
[ -f "$TOKEN_FILE" ] || die "broker token missing at $TOKEN_FILE"
BROKER_TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"

say "Starting the recording gateway (127.0.0.1:$GATEWAY_PORT)"
# --no-auth is refused on a non-loopback bind, which is why this stays on 127.0.0.1:
# any host that could reach it would be able to author the prompts omp later serves.
OMP_AUTH_BROKER_URL="http://127.0.0.1:$BROKER_PORT" \
OMP_AUTH_BROKER_TOKEN="$BROKER_TOKEN" \
	"$OMP" auth-gateway serve --record-harness --no-auth --bind "127.0.0.1:$GATEWAY_PORT" \
	>"$WORK_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
wait_for_port "$GATEWAY_PORT" || { cat "$WORK_DIR/gateway.log" >&2; die "gateway did not start"; }

# Claude Code refuses to run in an untrusted directory and its trust prompt is
# interactive. Pre-accept it for this throwaway directory, keeping a byte-exact
# backup so the user's config is restored verbatim rather than reserialized.
CLAUDE_CFG="$HOME/.claude.json"
CLAUDE_CFG_BACKUP="$WORK_DIR/claude.json.orig"

restore_claude_config() {
	if [ -f "$CLAUDE_CFG_BACKUP" ]; then
		cp "$CLAUDE_CFG_BACKUP" "$CLAUDE_CFG"
		rm -f "$CLAUDE_CFG_BACKUP"
	fi
}

trust_scratch_dir() {
	[ -f "$CLAUDE_CFG" ] || return 0
	cp "$CLAUDE_CFG" "$CLAUDE_CFG_BACKUP"
	python3 - "$CLAUDE_CFG" "$WORK_DIR" <<'PY'
import json, sys, pathlib
cfg_path, work_dir = pathlib.Path(sys.argv[1]), sys.argv[2]
cfg = json.loads(cfg_path.read_text())
cfg.setdefault("projects", {}).setdefault(work_dir, {})["hasTrustDialogAccepted"] = True
cfg_path.write_text(json.dumps(cfg, indent=2))
PY
}

# `claude -p` is NOT usable here: print mode routes through the Agent SDK and
# reports `cc_entrypoint=sdk-cli`, which the recorder rejects on purpose. Only
# the interactive TUI sends the `cli` entrypoint omp serves, so drive a PTY.
# One recording per model: the vendor prompt names the model it runs on, so a
# Fable recording replayed to Opus would assert the wrong identity.
CLAUDE_MODELS="${OMP_HARNESS_CLAUDE_MODELS:-claude-fable-5-1 claude-opus-5}"

drive_claude_tui() {
	python3 - "$WORK_DIR" "$GATEWAY_PORT" "$1" <<'PY'
import os, pty, select, sys, time

work_dir, port, model = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work_dir)
    os.environ["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{port}"
    try:
        os.execvp("claude", ["claude", "--model", model])
    finally:
        os._exit(1)


def drain(seconds):
    end = time.time() + seconds
    out = b""
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.5)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    return out


try:
    banner = drain(8)
    # Trust is pre-accepted, but answer the prompt anyway if this client still
    # shows it: the second option is "Yes, I trust this folder".
    if b"trust" in banner.lower():
        os.write(fd, b"\x1b[B\r")
        drain(4)
    os.write(fd, b"hi\r")
    drain(25)
finally:
    os.close(fd)
    try:
        os.kill(pid, 15)
        os.waitpid(pid, 0)
    except OSError:
        pass
PY
}

if command -v claude >/dev/null; then
	say "Recording the Claude Code prompt (interactive TUI)"
	trust_scratch_dir
	# The capture is written from the INBOUND request, before omp calls Anthropic,
	# so a rate-limited or out-of-quota account still produces a valid capture.
	for model in $CLAUDE_MODELS; do
		say "  model $model"
		drive_claude_tui "$model" || true
	done
	restore_claude_config
fi


if command -v codex >/dev/null; then
	say "Recording the Codex prompt"
	(cd "$WORK_DIR" && timeout 120 codex exec --skip-git-repo-check \
		-c 'model_provider="omprec"' \
		-c 'model_providers.omprec.name="omprec"' \
		-c "model_providers.omprec.base_url=\"http://127.0.0.1:$GATEWAY_PORT/v1\"" \
		-c 'model_providers.omprec.wire_api="responses"' \
		"hi" >/dev/null 2>&1) || true
fi

# ─── verify ─────────────────────────────────────────────────────────────────

say "Verifying"
FOUND=0
for profile in claude-code codex; do
	dir="$CACHE_DIR/$profile"
	if [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
		for f in "$dir"/*.json; do
			printf '  %s %s (%s bytes)\n' "$profile" "$(basename "$f")" "$(wc -c <"$f")"
			FOUND=$((FOUND + 1))
		done
	else
		warn "no $profile capture recorded"
	fi
done

if [ "$FOUND" -eq 0 ]; then
	echo
	warn "No captures were recorded. omp still renames tools and matches the vendor's"
	warn "cache framing under a profile, but it will serve its own system prompt."
	warn "Gateway log: $WORK_DIR/gateway.log (copied below)"
	tail -20 "$WORK_DIR/gateway.log" >&2 || true
	exit 1
fi

cat <<EOF

Done. $("$OMP" --version) installed, $FOUND capture(s) in $CACHE_DIR

Models post-trained on Claude Code (Opus 5, Fable 5.1) and Codex (GPT-6 Astra,
GPT-5.6 Sol) now receive that client's system prompt, tool names, and prompt-cache
framing. Every other model is untouched.

Re-run this script after upgrading Claude Code or Codex to refresh the captures;
they are keyed by client version, and an older capture keeps serving until then.

To disable without uninstalling: move $CACHE_DIR aside.
EOF
