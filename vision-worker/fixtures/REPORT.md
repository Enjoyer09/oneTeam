# YOLO quality report — fixtures (2026-10-06)

**Default model: `yolo11n.pt`** (switched from `yolov8n.pt` after the
pre-registered upgrade gate passed, see below), `conf=0.25`.
Local = `.venv/bin/python scripts/yolo_quality_check.py` (spawnSync path).
Remote = deployed Railway worker `POST /detect` with data-URL payload.

## Upgrade gate: yolov8n → yolo11n

Latency (local, 640px, CPU, 30 runs each after 5 warmups, `bench_models.py`):

| Model   | median  | p95     | mean    | min     |
| ------- | ------- | ------- | ------- | ------- |
| yolov8n | 31.5 ms | 33.0 ms | 33.2 ms | 29.4 ms |
| yolo11n | 31.1 ms | 34.2 ms | 32.7 ms | 29.7 ms |

mean delta: **−0.5 ms (−1.4%)** — inside noise, well under the 1.5× ceiling.

End-to-end through `scripts/yolo_benchmark.py` (the spawned-worker call,
model load included, median of 5): yolov8n shelf-01 81 ms / shelf-02 67 ms;
yolo11n shelf-01 80 ms / shelf-02 81 ms (+21% on shelf-02, still far under
the 1.5× ceiling). Counts deterministic across all 5 runs.

Detections on the two fixtures (`run_inference`, both models):

| Fixture                      | yolov8n count / synthetic | yolo11n count / synthetic |
| ---------------------------- | ------------------------- | ------------------------- |
| shelf-01.jpg (sauce bottles) | 12 / false                | 11 / false                |
| shelf-02.jpg (canned food)   | 9 / **true (0 real)**     | 1 / **false (1 real)**    |

yolo11n: same COCO classes on shelf-01 (−1 box, same 3 mapped SKUs), and it
finds a **real** bottle on shelf-02 where yolov8n found nothing (COCO misses
cans — `bottle` fires on one HK shelf item). Gate = strictly better on ≥1
fixture, no class regression, latency ≤ 1.5× → **passed → default switched** in
`aiVision.ts` / `server.py` / `yolo_inference.py` / `Dockerfile` prewarm.
Pinned by tests: `test:vision` spawn-args check, `test_server.py` "default
model is yolo11n".

## Baseline — yolov8n (historical, pre-switch)

| Fixture                      | Local count | Local synthetic | Remote count | Remote synthetic | Remote latency |
| ---------------------------- | ----------- | --------------- | ------------ | ---------------- | -------------- |
| shelf-01.jpg (sauce bottles) | 12          | false           | 12           | false            | 985 ms         |
| shelf-02.jpg (canned food)   | 9           | true            | 9            | true             | 700 ms         |

## Read

- Displayed labels ("Coca-Cola Classic 0.5L" …) come from the app's
  SKU-mapping heuristic over the detected boxes, not from the model —
  expected until fine-tuning (Part 2).
- shelf-02 canned goods: COCO classes don't cover cans; yolo11n's single real
  detection is still 0 real SKUs on that shelf — this is exactly what
  fine-tuning must fix.

**Verdict:** local and remote transports agree; pipeline is trustworthy.
Baseline for any model/threshold change: rerun both commands above and diff
this table.
