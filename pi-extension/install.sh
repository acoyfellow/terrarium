#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
extensions_dir="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
target="$extensions_dir/terrarium"
legacy="$extensions_dir/terrarium-autocontinue.ts"
backup_dir="$HOME/.terrarium/backups"

move_aside() {
  local path="$1"
  if [ -L "$path" ]; then
    rm "$path"
  elif [ -e "$path" ]; then
    mkdir -p "$backup_dir"
    local backup="$backup_dir/$(basename "$path").bak-$(date +%Y%m%d%H%M%S)"
    mv "$path" "$backup"
    echo "Moved $path to $backup"
  fi
}

mkdir -p "$extensions_dir"
move_aside "$legacy"
move_aside "$target"
ln -s "$source_dir" "$target"
echo "Linked $target -> $source_dir"
echo "Reload Pi to load it."
