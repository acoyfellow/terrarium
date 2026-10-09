#!/usr/bin/env bash
set -u
here=$(cd "$(dirname "$0")" && pwd)
receipts="$here/receipts"
good=$(cat "$receipts/LATEST")
restore() { echo "$good" > "$receipts/LATEST"; rm -rf "$receipts/tamper-check"; }
trap restore EXIT
pass=0
fail=0
check() { if [ "$1" = "$2" ]; then pass=$((pass + 1)); echo "PASS $3"; else fail=$((fail + 1)); echo "FAIL $3 (exit $1)"; fi; }

before=$(ls "$receipts")
MUTANT_ALLOW_ALL=1 bun "$here/run.ts" >/dev/null 2>&1
mutant=$(comm -13 <(echo "$before") <(ls "$receipts") | head -1)
mv "$receipts/$mutant" "$receipts/mutant-allow-all-$mutant"
echo "mutant-allow-all-$mutant" > "$receipts/LATEST"
bun "$here/recompute.ts" >/dev/null 2>&1; [ $? -ne 0 ] && r=red || r=green
check "$r" red "allow-all mutant broker is rejected"

cp -r "$receipts/$good" "$receipts/tamper-check"
python3 - "$receipts/tamper-check/run-1.json" <<'EOF'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
for cell in data["cells"]:
    if cell["cell"] == "leaky-owner-env":
        cell["escapes"] = 0
        cell["expected"] = "green"
json.dump(data, open(path, "w"))
EOF
echo tamper-check > "$receipts/LATEST"
bun "$here/recompute.ts" >/dev/null 2>&1; [ $? -ne 0 ] && r=red || r=green
check "$r" red "a receipt that hides escapes is rejected"

restore
bun "$here/recompute.ts" >/dev/null 2>&1; [ $? -eq 0 ] && r=green || r=red
check "$r" green "honest receipts still pass"
echo "== $pass pass, $fail fail"
[ "$fail" -eq 0 ]
