# YOLO quality report — fixtures (2026-10-06)

Model: `yolov8n.pt` (COCO pretrained, no fine-tune), `conf=0.25`.
Local = `.venv/bin/python scripts/yolo_quality_check.py` (spawnSync path).
Remote = deployed Railway worker `POST /detect` with data-URL payload.

| Fixture | Local count | Local synthetic | Remote count | Remote synthetic | Remote latency |
|---|---|---|---|---|---|
| shelf-01.jpg (sauce bottles) | 12 | false | 12 | false | 985 ms |
| shelf-02.jpg (canned food) | 9 | true | 9 | true | 700 ms |

**Read:**

- shelf-01: COCO classes fire on the bottles → real detections. The displayed
  labels ("Coca-Cola Classic 0.5L" …) come from the app's SKU-mapping heuristic
  (color/position over the detected boxes), not from the model — expected until
  fine-tuning.
- shelf-02: COCO finds nothing on canned goods (cans are not a COCO class) →
  zero real detections → synthetic fallback fires. The 9 listed products are
  fallback content, NOT detections. This is exactly what fine-tuning (Part 2)
  must fix.

**Verdict:** local and remote transports agree exactly; pipeline is trustworthy.
Baseline for any model/threshold change: rerun both commands above and diff
this table.
