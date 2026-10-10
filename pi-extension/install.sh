#!/usr/bin/env bash
set -euo pipefail

source_file="$(cd "$(dirname "$0")" && pwd)/terrarium-autocontinue.ts"
extensions_dir="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
target="$extensions_dir/terrarium-autocontinue.ts"

mkdir -p "$extensions_dir"
if [ -e "$target" ] && [ ! -L "$target" ]; then
  backup_dir="$HOME/.terrarium/backups"
  mkdir -p "$backup_dir"
  backup="$backup_dir/terrarium-autocontinue.ts.bak-$(date +%Y%m%d%H%M%S)"
  mv "$target" "$backup"
  echo "Moved your existing extension to $backup"
fi
ln -sfn "$source_file" "$target"
echo "Linked $target -> $source_file"
echo "Reload Pi to load it."
