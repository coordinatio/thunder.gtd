#!/usr/bin/env bash
# Pack the Thunderbird extension into dist/<name>-<version>.xpi.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

read_json() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]], end="")' "$1" "$2"
}

name=$(read_json package.json name)
version=$(read_json manifest.json version)

files=(
  manifest.json
  background.js
  parse-clipboard.js
  format-clipboard.js
  api/subjectCopy/schema.json
  api/subjectCopy/implementation.js
  icons/jump.svg
  _locales/en/messages.json
  _locales/ru/messages.json
)

for file in "${files[@]}"; do
  if [[ ! -f $file ]]; then
    echo "missing $file" >&2
    exit 1
  fi
done

mkdir -p dist
out="dist/${name}-${version}.xpi"
rm -f "$out"
zip -X -q "$out" "${files[@]}"
echo "$root/$out"
