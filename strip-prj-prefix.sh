#!/usr/bin/env bash
# what it does: strip the `prj--` prefix from directories under projects/.
# Folders without the prefix are left alone.
#
# Usage:
#   ./strip-prj-prefix.sh            # dry-run (prints planned moves)
#   ./strip-prj-prefix.sh --apply    # perform the renames
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)/projects"
PREFIX="prj--"
APPLY=0

if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 1
fi

if [[ ! -d "$ROOT" ]]; then
  echo "Missing directory: $ROOT" >&2
  exit 1
fi

shopt -s nullglob
moved=0
skipped=0

for dir in "$ROOT"/"$PREFIX"*/; do
  dir="${dir%/}"
  base="$(basename "$dir")"
  new_name="${base#"$PREFIX"}"

  if [[ -z "$new_name" ]]; then
    echo "skip (empty name): $dir" >&2
    skipped=$((skipped + 1))
    continue
  fi

  dest="$ROOT/$new_name"
  if [[ -e "$dest" ]]; then
    echo "skip (target exists): $dest" >&2
    skipped=$((skipped + 1))
    continue
  fi

  echo "$base  ->  $new_name"

  if [[ "$APPLY" -eq 1 ]]; then
    git mv "$dir" "$dest" 2>/dev/null || mv "$dir" "$dest"
  fi
  moved=$((moved + 1))
done

if [[ "$moved" -eq 0 && "$skipped" -eq 0 ]]; then
  echo "No directories with prefix '$PREFIX' under $ROOT"
elif [[ "$APPLY" -eq 0 ]]; then
  echo
  echo "Dry-run: $moved would be renamed, $skipped skipped. Re-run with --apply to rename."
else
  echo
  echo "Renamed $moved, skipped $skipped."
fi
