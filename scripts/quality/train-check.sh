#!/usr/bin/env bash
# Self-check for scripts/train_yolo.py dataset validation (3 cases).
set -u
cd "$(dirname "$0")/../.."
PY=.venv/bin/python
fail=0

# 1. missing data.yaml → exit 1, names the file
out=$("$PY" scripts/train_yolo.py --check --data /tmp/no-such-data.yaml 2>&1)
[ $? -eq 1 ] && echo "$out" | grep -q "not found" \
  && echo "  ✓ missing data.yaml rejected" || { echo "  ✗ missing data.yaml: $out"; fail=1; }

# 2. valid layout → exit 0
d=$(mktemp -d)
for split in train val; do mkdir -p "$d/images/$split" "$d/labels/$split"; done
printf '\x89PNG\r\n\x1a\n' > "$d/images/train/x.png"
printf '\x89PNG\r\n\x1a\n' > "$d/images/val/x.png"
printf '0 0.5 0.5 0.2 0.2\n' > "$d/labels/train/x.txt"
printf '0 0.5 0.5 0.2 0.2\n' > "$d/labels/val/x.txt"
printf 'train: images/train\nval: images/val\nnames:\n  0: bottle\n' > "$d/data.yaml"
"$PY" scripts/train_yolo.py --check --data "$d/data.yaml" >/dev/null 2>&1 \
  && echo "  ✓ valid dataset accepted" || { echo "  ✗ valid dataset rejected"; fail=1; }

# 3. no class list → exit 1, names the problem
printf 'train: images/train\nval: images/val\n' > "$d/data.yaml"
out=$("$PY" scripts/train_yolo.py --check --data "$d/data.yaml" 2>&1)
[ $? -eq 1 ] && echo "$out" | grep -q "names" \
  && echo "  ✓ missing names rejected" || { echo "  ✗ missing names: $out"; fail=1; }
rm -rf "$d"

[ $fail -eq 0 ] && echo "train_yolo check: 3/3" || echo "train_yolo check: FAILED"
exit $fail
