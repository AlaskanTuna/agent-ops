#!/usr/bin/env bash
# Bundle the fanout CLI into a single file plus its shims, skill, units and
# installer. Never touches the `current` link; install.sh does that.
set -euo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
ROOT="$(readlink -f "$SCRIPT_DIR/../..")"

OUT="$HOME/.local/lib/agent-ops/fanout"
ALLOW_DIRTY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      OUT="$2"
      shift 2
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    *)
      echo "usage: build.sh [--out <dir>] [--allow-dirty]" >&2
      exit 2
      ;;
  esac
done

if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
  if [ "$ALLOW_DIRTY" -eq 0 ]; then
    echo "working tree is dirty; commit, or pass --allow-dirty" >&2
    exit 2
  fi
  DIRTY=true
else
  DIRTY=false
fi

VERSION="$(grep -o "[0-9]*\.[0-9]*\.[0-9]*" "$ROOT/fanout/src/version.ts" | head -1)"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
if [ -n "${FANOUT_NOW:-}" ]; then
  STAMP="$(date -u -d "$FANOUT_NOW" +%Y%m%d%H%M%S)"
else
  STAMP="$(date -u +%Y%m%d%H%M%S)"
fi
if [ "$DIRTY" = true ]; then
  ID="$VERSION-$SHA-dirty-$STAMP"
else
  ID="$VERSION-$SHA-$STAMP"
fi
DEST="$OUT/$ID"
mkdir -p "$DEST"

if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "build.sh: bun not found (tried PATH and \$HOME/.bun/bin/bun)" >&2
  exit 2
fi

BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$BUN" build "$ROOT/fanout/src/cli.ts" --target bun --outfile "$DEST/fanout.js"

cp "$ROOT/fanout/bin/fanout" "$ROOT/fanout/bin/fanout-stop-hook" "$ROOT/fanout/bin/fanout-session-hook" "$DEST/"
chmod +x "$DEST/fanout" "$DEST/fanout-stop-hook" "$DEST/fanout-session-hook"
mkdir -p "$DEST/skill"
cp "$ROOT/fanout/skill/SKILL.md" "$DEST/skill/"
for extra in "systemd:fanout/systemd" "install.sh:fanout/install/install.sh" "verify.sh:fanout/install/verify.sh"; do
  src="$ROOT/${extra#*:}"
  name="${extra%%:*}"
  if [ -e "$src" ]; then
    if [ -d "$src" ]; then
      mkdir -p "$DEST/$name"
      cp "$src/"* "$DEST/$name/"
    else
      cp "$src" "$DEST/$name"
      chmod +x "$DEST/$name"
    fi
  else
    echo "WARN build: missing $src; skipped" >&2
  fi
done

printf 'id=%s\nsha=%s\ndirty=%s\nbuilt_at=%s\n' "$ID" "$SHA" "$DIRTY" "$BUILT_AT" >"$DEST/BUILD"
echo "BUILD $ID -> $DEST"
