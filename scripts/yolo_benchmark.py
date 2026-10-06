"""Benchmark yolov8n vs yolo11n on the Part-1 fixtures, end to end.

Runs `run_inference` (the same call the spawned worker makes — model load
included) N=5 times per model per fixture, prints median ms, detection counts
and synthetic-fallback status side by side.

Usage: .venv/bin/python scripts/yolo_benchmark.py
"""
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yolo_inference import run_inference  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vision-worker', 'fixtures')
MODELS = ('yolov8n.pt', 'yolo11n.pt')
N = 5


def main() -> int:
    fixtures = sorted(
        os.path.join(FIXTURES, f) for f in os.listdir(FIXTURES) if f.endswith('.jpg')
    )
    if not fixtures:
        print('No fixtures found in vision-worker/fixtures/', file=sys.stderr)
        return 1

    for model in MODELS:
        for fixture in fixtures:
            times, counts, synth = [], [], []
            for _ in range(N):
                t0 = time.perf_counter()
                out = run_inference(fixture, model_path=model)
                times.append((time.perf_counter() - t0) * 1000)
                counts.append(out.get('detected_count', 0))
                synth.append(bool(out.get('synthetic_fallback', True)))
            print(
                model,
                os.path.basename(fixture),
                f'median={statistics.median(times):.0f}ms',
                counts,
                'synthetic:',
                any(synth),
            )
    return 0


if __name__ == '__main__':
    sys.exit(main())
