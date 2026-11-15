#!/usr/bin/env bash
# End-to-end check for the installed fanout copy. Sandbox mode (default)
# builds the current tree, installs it into a temp home and checks it there
# with the fake adapter (no quota, no spend). --live checks the real
# installation without changing anything.
set -euo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
LIVE=0
if [ "${1:-}" = '--live' ]; then
  LIVE=1
elif [ $# -gt 0 ]; then
  echo "usage: verify.sh [--live]" >&2
  exit 2
fi

pass=0
fail=0
report_pass() {
  echo "PASS $1: $2"
  pass=$((pass + 1))
}
report_fail() {
  echo "FAIL $1: $2"
  fail=$((fail + 1))
}
finish() {
  if [ "$fail" -eq 0 ]; then
    echo 'ALL PASS'
    exit 0
  else
    echo "FAILED $fail"
    exit 1
  fi
}

if [ "$LIVE" = 1 ]; then
  # --live: read-only checks of the real installation.
  case "$(readlink -f "$HOME/.agents/bin/fanout" 2>/dev/null)|$(readlink -f "$HOME/.local/bin/fanout" 2>/dev/null)" in
    "$HOME"/.local/lib/agent-ops/fanout/*"|$HOME"/.local/lib/agent-ops/fanout/*)
      report_pass bin "both links resolve inside the fanout lib dir"
      ;;
    *)
      report_fail bin "links do not resolve inside $HOME/.local/lib/agent-ops/fanout/"
      ;;
  esac

  case "$(readlink -f "$HOME/.claude/skills/fanout" 2>/dev/null)|$(readlink -f "$HOME/.agents/skills/fanout" 2>/dev/null)" in
    "$HOME"/.local/lib/agent-ops/fanout/*"|$HOME"/.local/lib/agent-ops/fanout/*)
      report_pass skill "both skill links resolve into the built copy"
      ;;
    *)
      report_fail skill "skill links missing in ~/.claude/skills or ~/.agents/skills"
      ;;
  esac

  settings="$HOME/.claude/settings.json"
  if ! command -v jq >/dev/null 2>&1; then
    report_fail hooks "no jq to inspect settings"
  elif [ ! -f "$settings" ]; then
    report_fail hooks "no $settings"
  else
    stop_ok=0
    session_ok=0
    if jq -e '[.. | objects | select((.command // "") | contains("fanout-stop-hook"))] | length > 0' "$settings" >/dev/null 2>&1; then
      stop_ok=1
    fi
    if jq -e '[.. | objects | select((.command // "") | contains("fanout-session-hook"))] | length > 0' "$settings" >/dev/null 2>&1; then
      session_ok=1
    fi
    if [ "$stop_ok" = 1 ] && [ "$session_ok" = 1 ]; then
      report_pass hooks "Stop and SessionStart groups call the current wrappers"
    else
      report_fail hooks "missing hook groups (stop: $stop_ok, session-start: $session_ok)"
    fi
  fi

  if systemctl --user is-enabled fanout-upkeep.timer >/dev/null 2>&1; then
    report_pass timer "fanout-upkeep.timer is enabled"
  else
    report_fail timer "fanout-upkeep.timer is not enabled"
  fi

  if [ -n "$(env -i HOME="$HOME" bash -lc 'command -v fanout' 2>/dev/null)" ]; then
    report_pass path "fanout resolves in a login shell"
  else
    report_fail path "fanout not found in a login shell"
  fi

  if [ -f "$HOME/.config/agent-ops/catalog.csv" ]; then
    report_pass catalog "private catalog exists"
  else
    report_fail catalog "no ~/.config/agent-ops/catalog.csv"
  fi

  docs_missing=""
  if ! grep -q 'An approved dispatch covers its own automatic fallbacks' "$HOME/.agents/docs/08-fanout.md" 2>/dev/null; then
    docs_missing="$docs_missing 08-fanout.md"
  fi
  if [ ! -f "$HOME/.agents/docs/24-fanout-ledger.md" ]; then
    docs_missing="$docs_missing 24-fanout-ledger.md"
  fi
  if ! grep -qi 'fanout' "$HOME/.agents/docs/06-hooks.md" 2>/dev/null; then
    docs_missing="$docs_missing 06-hooks.md"
  fi
  if ! grep -q '24-fanout-ledger' "$HOME/.agents/AGENTS.md" 2>/dev/null; then
    docs_missing="$docs_missing AGENTS.md"
  fi
  if [ -z "$docs_missing" ]; then
    report_pass docs "policy, ledger doc, hook exception and pointer all present"
  else
    report_fail docs "missing:$docs_missing"
  fi
  finish
fi

# Sandbox mode from here on.
CHECKOUT="$(readlink -f "$SCRIPT_DIR/../..")"
SETUP_FAIL=""
if [ ! -f "$CHECKOUT/fanout/install/build.sh" ]; then
  SETUP_FAIL="no build.sh in $CHECKOUT (run from a checkout)"
fi

VHOME="$(mktemp -d "${TMPDIR:-/tmp}/fanout-verify-XXXXXXXX")"
[ -n "$VHOME" ] && [ -d "$VHOME" ] || {
  echo 'FAIL setup: cannot make a temp home'
  echo 'FAILED 7'
  exit 1
}
export HOME="$VHOME"
export FANOUT_HOME="$VHOME"
export FANOUT_FAKE=1
export FANOUT_NO_LAZY=1
export FANOUT_NO_SLEEP=1
export FANOUT_CALLER=verify
export FANOUT_SESSION=V1
export FANOUT_WAIT_MAX_S=120
export FANOUT_CATALOG_FILE="${FANOUT_CATALOG_FILE:-$CHECKOUT/fanout/tests/fixtures/catalog.fake.csv}"
export FANOUT_FAKE_WORKER="${FANOUT_FAKE_WORKER:-$CHECKOUT/fanout/tests/helpers/fake-worker.ts}"
export FANOUT_FAKE_SCRIPT="$VHOME/fake-script.json"

BUILD_OUT="$VHOME/lib"
BUILD=""
FANOUT=""
HOOK=""
REPO=""
BRIEF=""

setup() {
  [ -n "$SETUP_FAIL" ] && return 1
  local out
  out="$(bash "$CHECKOUT/fanout/install/build.sh" --out "$BUILD_OUT" --allow-dirty 2>&1)" || {
    SETUP_FAIL="build failed: $(echo "$out" | tail -3 | tr '\n' ' ')"
    return 1
  }
  BUILD="$(echo "$out" | grep '^BUILD ' | tail -1 | sed 's/^BUILD \S\+ -> //')" || true
  [ -n "$BUILD" ] || {
    SETUP_FAIL="no BUILD line in build output"
    return 1
  }
  FANOUT_INSTALL_NO_SYSTEMD=1 bash "$BUILD/install.sh" >/dev/null 2>&1 || {
    SETUP_FAIL="install failed"
    return 1
  }
  FANOUT="$VHOME/.agents/bin/fanout"
  HOOK="$BUILD/fanout-stop-hook"
  REPO="$VHOME/repo"
  git init -q "$REPO" || {
    SETUP_FAIL="cannot init repo"
    return 1
  }
  echo hello >"$REPO/a.txt"
  git -C "$REPO" -c user.email=verify@example.invalid -c user.name=verify add a.txt >/dev/null &&
    git -C "$REPO" -c user.email=verify@example.invalid -c user.name=verify commit -qm initial >/dev/null || {
      SETUP_FAIL="cannot init repo"
      return 1
    }
  BRIEF="$VHOME/brief.txt"
  echo 'Rename foo in a.txt to bar, nothing else.' >"$BRIEF"
  export FANOUT_FAKE_SCRIPT
  return 0
}

setup || true

guard() {
  if [ -n "$SETUP_FAIL" ]; then
    report_fail "$1" "$SETUP_FAIL"
    return 1
  fi
  return 0
}

set_script() {
  printf '%s' "$1" >"$FANOUT_FAKE_SCRIPT"
  rm -f "$VHOME/fake-counters.json"
}

clear_private() {
  rm -f "$VHOME/.config/agent-ops/catalog.csv"
}

write_private() {
  printf '%b' "$1" >"$VHOME/.config/agent-ops/catalog.csv"
}

stop_payload() {
  echo '{"session_id":"V1","stop_hook_active":false}' | CLAUDE_PROJECT_DIR=/tmp/p "$HOOK" 2>/dev/null
}

# 1. version
if guard version; then
  want="fanout $(grep -o '[0-9]*\.[0-9]*\.[0-9]*' "$CHECKOUT/fanout/src/version.ts" | head -1)"
  got="$("$FANOUT" --version 2>&1)" || got=""
  if [ "$got" != "$want" ]; then
    report_fail version "got '$got', want '$want'"
  else
    if dout="$("$FANOUT" doctor 2>&1)"; then
      report_pass version "$got; doctor clean"
    elif echo "$dout" | grep -q '^FAIL'; then
      report_fail version "doctor $(echo "$dout" | grep '^FAIL' | head -1)"
    elif echo "$dout" | grep -qi 'unknown command\|^usage:'; then
      report_fail version "doctor missing: $(echo "$dout" | head -1)"
    else
      report_pass version "$got; doctor warns only"
    fi
  fi
fi

# 2. fallback
if guard fallback; then
  clear_private
  set_script '{"fake/f1-a": ["rate_limited"]}'
  code=0
  out="$("$FANOUT" run --brief "$BRIEF" --dir "$REPO" --kind transcribe 2>"$VHOME/fallback.err")" || code=$?
  job="$(echo "$out" | sed -n 's/^FANOUT job=\([^ ]*\).*/\1/p')"
  if [ "$code" -ne 0 ] || ! echo "$out" | grep -q '^FALLBACK fake/f1-a rate_limited'; then
    report_fail fallback "no FALLBACK line (exit $code)"
  elif ! "$FANOUT" status --brief 2>/dev/null | grep -q 'UNREPORTED'; then
    report_fail fallback "status --brief shows no UNREPORTED"
  else
    hook1="$(stop_payload)" || true
    if [ -z "$hook1" ] || ! echo "$hook1" | grep -q 'ack'; then
      report_fail fallback "stop hook printed no block"
    elif ! ackout="$("$FANOUT" ack "$job" 2>&1)" || ! echo "$ackout" | grep -q "^ACKED "; then
      report_fail fallback "ack failed for $job"
    elif [ -n "$(stop_payload || true)" ]; then
      report_fail fallback "stop hook still blocks after ack"
    else
      report_pass fallback "FALLBACK line, UNREPORTED, hook block, ack clears it"
    fi
  fi
fi

# 3. cost
if guard cost; then
  write_private 'harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired\n'
  set_script '{"fake2/f1-paid": ["ok"]}'
  code=0
  out="$("$FANOUT" run --brief "$BRIEF" --dir "$REPO" --kind transcribe 2>"$VHOME/cost.err")" || code=$?
  if [ "$code" -ne 0 ]; then
    report_fail cost "run exited $code"
  elif ! grep -qF 'ESTIMATE paid API (fake2/f1-paid)' "$VHOME/cost.err"; then
    report_fail cost "no ESTIMATE on stderr"
  elif ! echo "$out" | grep -qF 'COST paid API (fake2/f1-paid):' ||
    ! echo "$out" | grep -qF 'estimated $0.14' ||
    ! echo "$out" | grep -qF 'actual $0.0014'; then
    report_fail cost "no COST line with estimate and actual"
  else
    report_pass cost "ESTIMATE on stderr, COST with estimate and actual"
  fi
fi

# 4. dryrun
if guard dryrun; then
  clear_private
  secrets="$VHOME/secrets.env"
  fake_key="sk-$(printf 'x%.0s' $(seq 1 24))"
  printf 'META_MODEL_API_KEY=%s\n' "$fake_key" >"$secrets"
  chmod 600 "$secrets"
  ok=1
  detail=""
  for h in codex agy meta; do
    dcode=0
    out="$(FANOUT_SECRETS="$secrets" FANOUT_CATALOG_FILE= "$FANOUT" run --dry-run --brief "$BRIEF" --dir "$REPO" --kind transcribe --harness "$h" 2>"$VHOME/dryrun-$h.err")" || dcode=$?
    if [ "$dcode" -ne 0 ] || ! echo "$out" | grep -q "^DRYRUN $h/" || ! echo "$out" | grep -q 'argv='; then
      ok=0
      detail="$h printed no argv"
      break
    fi
    if echo "$out $(cat "$VHOME/dryrun-$h.err")" | grep -qF "$fake_key"; then
      ok=0
      detail="$h leaked the key"
      break
    fi
  done
  if [ "$ok" = 1 ]; then
    report_pass dryrun "codex, agy and meta print an argv and no key text"
  else
    report_fail dryrun "$detail"
  fi
fi

# 5. detach
if guard detach; then
  clear_private
  set_script '{"fake/f1-a": ["ok"]}'
  dout="$("$FANOUT" run --brief "$BRIEF" --dir "$REPO" --kind transcribe --detach 2>/dev/null)" || true
  id="$(echo "$dout" | sed -n 's/^JOB \([0-9A-Z]\{26\}\)$/\1/p')"
  if [ -z "$id" ]; then
    report_fail detach "no JOB id"
  else
    wcode=0
    wout="$("$FANOUT" wait "$id" 2>/dev/null)" || wcode=$?
    if [ "$wcode" -ne 0 ] || ! echo "$wout" | grep -q '^FANOUT job='; then
      report_fail detach "wait printed no block"
    else
      report_pass detach "JOB id, wait prints the block"
    fi
  fi
fi

# 6. report
if guard report; then
  rcode=0
  rout="$("$FANOUT" report 2>"$VHOME/report.err")" || rcode=$?
  if [ "$rcode" -eq 0 ]; then
    report_pass report "report runs"
  elif grep -q 'duckdb not found' "$VHOME/report.err"; then
    report_pass report "duckdb absent; ledger and run unaffected (note)"
  else
    report_fail report "$(tail -1 "$VHOME/report.err")"
  fi
fi

# 7. hygiene
if guard hygiene; then
  if ! command -v bun >/dev/null 2>&1; then
    report_fail hygiene "no bun on PATH"
  else
    hcode=0
    hout="$(cd "$CHECKOUT" && bun test fanout/tests/hygiene.test.ts 2>&1)" || hcode=$?
    if [ "$hcode" -eq 0 ]; then
      report_pass hygiene "hygiene tests pass"
    else
      report_fail hygiene "$(echo "$hout" | tail -3 | tr '\n' ' ')"
    fi
  fi
fi

if [ "$fail" -eq 0 ]; then
  rm -rf "$VHOME"
else
  echo "kept $VHOME" >&2
fi
finish
