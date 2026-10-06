"""Run the real YOLO model over the shelf fixtures and report quality.

Exit 0 — at least one fixture produced a real (non-synthetic) detection.
Exit 1 — synthetic fallback everywhere means the model sees nothing.

Usage: .venv/bin/python scripts/yolo_quality_check.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yolo_inference import run_inference  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vision-worker', 'fixtures')


def main() -> int:
    fixtures = sorted(
        os.path.join(FIXTURES, f) for f in os.listdir(FIXTURES) if f.endswith('.jpg')
    )
    if not fixtures:
        print('No fixtures found in vision-worker/fixtures/', file=sys.stderr)
        return 1

    rows = []
    for path in fixtures:
        outcome = run_inference(path)
        rows.append({
            'fixture': os.path.basename(path),
            'detected_count': outcome.get('detected_count', 0),
            'synthetic': outcome.get('synthetic_fallback', True),
            'labels': [d.get('label') for d in outcome.get('detections', [])][:12],
        })

    print(json.dumps(rows, indent=2))
    real = [r for r in rows if not r['synthetic']]
    print(f'\n{len(real)}/{len(rows)} fixtures with real detections')
    return 0 if real else 1


if __name__ == '__main__':
    sys.exit(main())
