#!/usr/bin/env bash
# Point this machine at the built copy this script lives in. Idempotent:
# re-running switches nothing unless the build is newer, and every file it
# edits is backed up first. Task 49 owns the instruction files, settings
# and docs; this script never touches them.
set -euo pipefail

DRY=0
if [ "${1:-}" = '--dry-run' ]; then
  DRY=1
elif [ $# -gt 0 ]; then
  echo "usage: install.sh [--dry-run]" >&2
  exit 2
fi

BUILD="$(dirname "$(readlink -f "$0")")"
if [ ! -f "$BUILD/BUILD" ]; then
  echo "install.sh: no BUILD stamp in $BUILD (run build.sh first)" >&2
  exit 2
fi

LIB="$HOME/.local/lib/agent-ops/fanout"
TS="$(date -u +%Y%m%d%H%M%S)"
BACKUP_DIR="$HOME/.agents/backups/fanout-install-$TS"

say_link() { echo "LINK $1 -> $2"; }
say_edit() { echo "EDIT $1"; }
say_backup() { echo "BACKUP $1 -> $2"; }
say_mkdir() { echo "MKDIR $1"; }

make_dir() {
  if [ ! -d "$1" ]; then
    say_mkdir "$1"
    [ "$DRY" = 1 ] || mkdir -p "$1"
  fi
  if [ -n "${2:-}" ] && [ "$DRY" != 1 ]; then chmod "$2" "$1"; fi
}

link_to() {
  say_link "$2" "$1"
  [ "$DRY" = 1 ] || ln -sfn "$1" "$2"
}

# 5. Runtime data and config dirs (0700) come first so BACKUP_DIR exists.
make_dir "$HOME/.local/share/agent-ops/fanout" 0700
for sub in events learned run logs worktrees patches smoke mined; do
  make_dir "$HOME/.local/share/agent-ops/fanout/$sub" 0700
done
make_dir "$HOME/.config/agent-ops" 0700
make_dir "$HOME/.agents/backups" ""
if [ "$DRY" != 1 ]; then mkdir -p "$BACKUP_DIR"; fi

backup_file() {
  if [ -f "$1" ]; then
    say_backup "$1" "$BACKUP_DIR/$2"
    if [ "$DRY" != 1 ]; then cp -p "$1" "$BACKUP_DIR/$2"; fi
  fi
}

# 1. Atomically point current at this build, then prune to the newest 3.
say_link "$LIB/current" "$BUILD"
if [ "$DRY" != 1 ]; then
  mkdir -p "$LIB"
  tmp_link="$LIB/.current-tmp-$$"
  ln -s "$BUILD" "$tmp_link"
  mv -Tf "$tmp_link" "$LIB/current"
  target="$(readlink -f "$LIB/current")"
  n=0
  # Newest first; never delete the live target (a rollback re-install keeps all).
  for d in $(ls -t "$LIB"); do
    [ -d "$LIB/$d" ] || continue
    [ "$d" = 'current' ] && continue
    [ "${d#.current-tmp-}" != "$d" ] && continue
    n=$((n + 1))
    if [ "$n" -gt 3 ] && [ "$LIB/$d" != "$target" ]; then rm -rf "$LIB/$d"; fi
  done
fi

# 2. Bin links (already on PATH everywhere).
make_dir "$HOME/.agents/bin" ""
make_dir "$HOME/.local/bin" ""
link_to "$LIB/current/fanout" "$HOME/.agents/bin/fanout"
link_to "$LIB/current/fanout" "$HOME/.local/bin/fanout"

# 3. PATH block in .profile and .bashrc (before the interactivity guard).
BLOCK_START='# >>> fanout PATH >>>'
BLOCK_END='# <<< fanout PATH <<<'
BLOCK_LINE='export PATH="$HOME/.agents/bin:$PATH"'

ensure_block() {
  local file="$1" mode="$2"
  say_edit "$file"
  [ "$DRY" = 1 ] && return 0
  local tmpf
  tmpf="$(mktemp)"
  if [ -f "$file" ] && grep -qF "$BLOCK_START" "$file"; then
    perl -0777 -pe 's/# >>> fanout PATH >>>.*?# <<< fanout PATH <<</# >>> fanout PATH >>>\nexport PATH="\$HOME\/.agents\/bin:\$PATH"\n# <<< fanout PATH <<</s' "$file" >"$tmpf"
  elif [ "$mode" = guard ] && [ -f "$file" ] && grep -q '^case \$- in' "$file"; then
    awk -v start="$BLOCK_START" -v line="$BLOCK_LINE" -v end="$BLOCK_END" '
      !done && /^case \$- in/ { print start; print line; print end; done=1 }
      { print }
    ' "$file" >"$tmpf"
  else
    if [ -f "$file" ]; then cat "$file" >"$tmpf"; fi
    printf '%s\n%s\n%s\n' "$BLOCK_START" "$BLOCK_LINE" "$BLOCK_END" >>"$tmpf"
  fi
  if [ -f "$file" ] && cmp -s "$file" "$tmpf"; then
    rm -f "$tmpf"
    return 0
  fi
  if [ -f "$file" ]; then
    case "$file" in
      "$HOME/.bashrc") backup_file "$file" 'bashrc' ;;
      "$HOME/.profile") backup_file "$file" 'profile' ;;
      *) backup_file "$file" "$(echo "$file" | tr '/' '_')" ;;
    esac
  fi
  cat "$tmpf" >"$file"
  rm -f "$tmpf"
}

ensure_block "$HOME/.profile" append
ensure_block "$HOME/.bashrc" guard

# 4. Skill links; a real directory is moved into the backup, never deleted.
make_dir "$HOME/.claude/skills" ""
make_dir "$HOME/.agents/skills" ""
link_skill() {
  local dest="$1" name="$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    say_backup "$dest" "$BACKUP_DIR/$name/"
    if [ "$DRY" != 1 ]; then mv "$dest" "$BACKUP_DIR/$name"; fi
  fi
  say_link "$dest" "$BUILD/skill"
  [ "$DRY" = 1 ] || ln -sfn "$BUILD/skill" "$dest"
}
link_skill "$HOME/.claude/skills/fanout" 'skills-claude-fanout'
link_skill "$HOME/.agents/skills/fanout" 'skills-agents-fanout'

# 6. Daily upkeep timer. Skipped whole when asked; a failing systemctl warns,
# never fails the install (fail open: the timer is convenience, not the CLI).
if [ "${FANOUT_INSTALL_NO_SYSTEMD:-0}" != 1 ]; then
  make_dir "$HOME/.config/systemd/user" ""
  if [ -f "$BUILD/systemd/fanout-upkeep.service" ]; then
    say_edit "$HOME/.config/systemd/user/fanout-upkeep.service"
    cp "$BUILD/systemd/fanout-upkeep.service" "$HOME/.config/systemd/user/fanout-upkeep.service"
  else
    echo "WARN install: no systemd units in $BUILD; skipped" >&2
  fi
  if [ -f "$BUILD/systemd/fanout-upkeep.timer" ]; then
    say_edit "$HOME/.config/systemd/user/fanout-upkeep.timer"
    cp "$BUILD/systemd/fanout-upkeep.timer" "$HOME/.config/systemd/user/fanout-upkeep.timer"
  fi
  # shellcheck disable=SC2312
  systemctl --user daemon-reload || echo "WARN install: systemctl --user daemon-reload failed; enable the timer by hand"
  # shellcheck disable=SC2312
  systemctl --user enable --now fanout-upkeep.timer ||
    echo "WARN install: systemctl --user enable --now fanout-upkeep.timer failed; enable the timer by hand"
fi
