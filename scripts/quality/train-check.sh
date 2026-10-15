#!/usr/bin/env bash
# Smoke-check that the TorchVision training entry point and required provenance args are exposed.
set -eu
cd "$(dirname "$0")/../.."
PY=.venv/bin/python
[ -x "$PY" ] || PY=python3
"$PY" scripts/train_torchvision_detector.py --help | grep -q -- '--dataset-license'
echo "TorchVision training CLI: OK"
