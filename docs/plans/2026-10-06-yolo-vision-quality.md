# YOLO Vision Quality & Operations — Implementation Plan

> **For Hermes:** Execute task-by-task, in order. TDD (RED → GREEN) per task, commit after each.

**Goal:** Take the deployed Ultralytics pipeline from "plumbing proven" to "quality measured, model tunable, thresholds configurable, and the known test flake understood".

**Architecture:** Worker (`vision-worker/`) serves YOLO over HTTP on Railway; local dev uses `scripts/yolo_inference.py` via `spawnSync` from `src/services/aiVision.ts`. Both transports must stay in lockstep — every config change lands in BOTH plus the worker's `server.py`.

**Tech Stack:** Ultralytics (YOLOv8n now), Python 3 `.venv`, TypeScript `aiVision.ts`, `vision-worker/test_server.py` (stub), `src/services/vision/vision.test.ts` (HTTP stub), Railway service `vision-worker` (builder: `vision-worker/Dockerfile`, auto-deploy on push to `main`).

**Ground rules (from repo state):**
- Commands: `npm run test:vision` (41 checks), `.venv/bin/python vision-worker/test_server.py` (10 checks), `unset NODE_ENV; node scripts/quality/local-gate.mjs` (12 steps), `unset NODE_ENV; bash scripts/quality/local-live-tests.sh` (562 checks + break detectors).
- Env vars to never print: anything with `password=`, `secret=`, `token=`. Secret scan before every push.
- `NODE_ENV=production` is exported in the shell — always `unset` for harness commands.

---

## Part 1 — Real-photo quality check (measure before tuning)

### Task 1.1: Fetch licensed real shelf fixtures

**Objective:** Have 2 real supermarket-shelf photos in the repo, license-clean, small enough to commit.

**Files:**
- Create: `vision-worker/fixtures/shelf-01.jpg`, `vision-worker/fixtures/shelf-02.jpg`
- Create: `vision-worker/fixtures/LICENSE.md` (source URL + license per image)

**Step 1:** Search Wikimedia Commons for "supermarket shelf" / "grocery shelf" images with CC0/PD license (`web_search` + `web_extract` to confirm the license on the file page).

**Step 2:** Download, downscale to ≤1280px longest edge, save as JPEG quality 80 (each ≤400 KB):

```bash
.venv/bin/python -c "
import urllib.request, cv2, numpy as np
url, out = '<URL>', 'vision-worker/fixtures/shelf-01.jpg'
raw = np.frombuffer(urllib.request.urlopen(url, timeout=60).read(), np.uint8)
img = cv2.imdecode(raw, cv2.IMREAD_COLOR)
s = 1280 / max(img.shape[:2])
img = cv2.resize(img, (int(img.shape[1]*s), int(img.shape[0]*s))) if s < 1 else img
cv2.imwrite(out, img, [cv2.IMWRITE_JPEG_QUALITY, 80])
"
```

**Step 3:** Verify: `ls -la vision-worker/fixtures/` → both ≤400 KB, `LICENSE.md` names the source page + license. If Commons has no clean-license photo, use any CC0 source (e.g. public-domain stock) and record it.

### Task 1.2: Quality check script (the assert-based self-check)

**Objective:** One runnable command that answers "does YOLO see real detections on real shelf photos?"

**Files:**
- Create: `scripts/yolo_quality_check.py`

**Step 1: write the check (this IS the test — assert-based):**

```python
"""Run the real YOLO model over the shelf fixtures and report quality.

Exit 0  — every fixture produced at least one real detection.
Exit 1  — synthetic fallback everywhere means the model sees nothing.

Usage: .venv/bin/python scripts/yolo_quality_check.py [--json]
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from yolo_inference import run_inference

def main() -> int:
    fixtures = sorted(
        os.path.join(os.path.dirname(__file__), '..', 'vision-worker', 'fixtures', f)
        for f in os.listdir(os.path.join(os.path.dirname(__file__), '..', 'vision-worker', 'fixtures'))
        if f.endswith('.jpg')
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
            'detections': [d['label'] for d in outcome.get('detections', [])][:10],
        })
    print(json.dumps(rows, indent=2))
    real = [r for r in rows if not r['synthetic']]
    print(f'\n{len(real)}/{len(rows)} fixtures with real detections')
    return 0 if real else 1

if __name__ == '__main__':
    sys.exit(main())
```

*(adjust the `run_inference` import/signature to match `scripts/yolo_inference.py:115` — read the file first; if `run_inference` is not importable as-is, import the module and call its actual entry point)*

**Step 2: run — EXPECT realistic output** (real shelf photos should give `synthetic: false` with COCO labels like `bottle`, `cup`, `person`; if every fixture is synthetic, the model/fixture pairing is broken — investigate before moving on):

```bash
.venv/bin/python scripts/yolo_quality_check.py
# expect: exit 0, "N/2 fixtures with real detections"
```

**Step 3: also run the same fixtures through the DEPLOYED worker** (HTTP transport parity):

```bash
.venv/bin/python - <<'PY'
import base64, json, urllib.request, glob, os
base = 'https://vision-worker-production-d9b4.up.railway.app'
for p in sorted(glob.glob('vision-worker/fixtures/*.jpg')):
    url = 'data:image/jpeg;base64,' + base64.b64encode(open(p,'rb').read()).decode()
    r = urllib.request.Request(base + '/detect', data=json.dumps({'image': url, 'conf': 0.25}).encode(),
                               headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(r, timeout=120) as resp:
        j = json.loads(resp.read())
    print(os.path.basename(p), 'synthetic:', j.get('synthetic_fallback'), 'count:', j.get('detected_count'))
PY
```

**Step 4: record numbers** in `vision-worker/fixtures/REPORT.md` (per fixture: local + remote count, labels, latency).

**Step 5: Commit**

```bash
git add vision-worker/fixtures scripts/yolo_quality_check.py
git commit -m "test(vision): real-photo quality check with licensed shelf fixtures"
```

---

## Part 2 — Fine-tune pipeline (the real precision lever)

### Task 2.1: RED — dataset validation must reject a bad layout

**Objective:** `train_yolo.py --check` exits non-zero with a clear message on a broken dataset, zero on a valid one.

**Files:**
- Create: `scripts/train_yolo.py`
- Test: shell-level (run the two commands below; both are the RED/GREEN proof)

**Step 1 (RED):**

```bash
.venv/bin/python scripts/train_yolo.py --check --data /tmp/no-such-data.yaml
echo "exit=$?"   # expect: non-zero, message naming the missing file
```

Currently: file does not exist → RED (command not found).

**Step 2 (GREEN) — minimal `scripts/train_yolo.py`:**

```python
"""Fine-tune a YOLO detection model on a labelled shelf dataset.

Dataset layout (Ultralytics standard):
  data.yaml  — train/val paths + names
  images/{train,val}/*.jpg
  labels/{train,val}/*.txt   — YOLO format: class cx cy w h (normalized)

Usage:
  .venv/bin/python scripts/train_yolo.py --check --data path/to/data.yaml
  .venv/bin/python scripts/train_yolo.py --data path/to/data.yaml --epochs 50
"""
import argparse, os, sys, yaml

def check_dataset(data_yaml: str) -> list[str]:
    """Return a list of problems; empty means the dataset is usable."""
    problems = []
    if not os.path.isfile(data_yaml):
        return [f'data.yaml not found: {data_yaml}']
    with open(data_yaml) as fh:
        spec = yaml.safe_load(fh)
    root = os.path.dirname(os.path.abspath(data_yaml))
    for split in ('train', 'val'):
        path = spec.get(split)
        if not path:
            problems.append(f'missing "{split}" key in data.yaml')
            continue
        resolved = os.path.join(root, path) if not os.path.isabs(path) else path
        if not os.path.isdir(resolved):
            problems.append(f'"{split}" directory not found: {resolved}')
        elif not any(f.endswith(('.jpg', '.jpeg', '.png')) for f in os.listdir(resolved)):
            problems.append(f'"{split}" directory has no images: {resolved}')
    if not spec.get('names'):
        problems.append('missing "names" (class list) in data.yaml')
    return problems

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--check', action='store_true', help='validate dataset and exit')
    ap.add_argument('--model', default='yolov8n.pt')
    ap.add_argument('--epochs', type=int, default=50)
    ap.add_argument('--imgsz', type=int, default=640)
    args = ap.parse_args()

    problems = check_dataset(args.data)
    if problems:
        for p in problems:
            print(f'ERROR: {p}', file=sys.stderr)
        return 1
    if args.check:
        print(f'OK: {args.data} is a valid YOLO dataset')
        return 0

    from ultralytics import YOLO
    model = YOLO(args.model)
    results = model.train(data=args.data, epochs=args.epochs, imgsz=args.imgsz,
                          project='runs/detect', name='shelf', exist_ok=True)
    best = os.path.join(results.save_dir, 'weights', 'best.pt')
    print(f'TRAINED: {best}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
```

**Step 3 (verify GREEN):**

```bash
.venv/bin/python scripts/train_yolo.py --check --data /tmp/no-such-data.yaml
# expect: exit 1, "ERROR: data.yaml not found: /tmp/no-such-data.yaml"
```

Plus a positive case: build a 2-image fake dataset in `/tmp/fake-yolo` (valid data.yaml, images/, labels/) → `--check` exit 0. Add both runs as `scripts/quality/train-check.sh` if you want them repeatable in gate; otherwise the two commands above are the runnable check.

**Step 4: Commit** — `git commit -am "feat(vision): YOLO fine-tune pipeline with dataset validation"`

### Task 2.2: Dataset acquisition decision

**Objective:** Either obtain a real labelled shelf dataset (small, YOLO format) or document exactly what the user must supply.

**Step 1:** `web_search` for a small public YOLO-format grocery/shelf dataset (HuggingFace `datasets`, Roboflow public). Constraints: ≤200 MB, YOLO labels, permissive license.

**Step 2a — found:** download to `datasets/shelf/` (add to `.gitignore` — datasets do not go in git), run `--check`, then a 2-epoch smoke train to prove the pipeline end-to-end:

```bash
.venv/bin/python scripts/train_yolo.py --data datasets/shelf/data.yaml --epochs 2
# expect: "TRAINED: runs/detect/shelf/weights/best.pt"
```

**Step 2b — not found:** write `datasets/README.md` with the exact layout + labelling instructions (labelimg/Roboflow export) and STOP — training needs the user's photos. Do not fabricate data.

**Step 3:** Commit (script/docs only — `datasets/` stays ignored).

---

## Part 3 — Model upgrade + measured latency

### Task 3.1: RED — model name must come from `ONETEAM_YOLO_MODEL`

**Files:**
- Modify: `src/services/vision/vision.test.ts` (stub asserts `--model` arg / payload)
- Modify: `src/services/aiVision.ts:~319` (spawn args), `vision-worker/server.py:~103,137`

**Step 1 (RED):** in `vision.test.ts` remote-worker section, set `process.env.ONETEAM_YOLO_MODEL = 'yolo11n.pt'` before `providerBuf.analyze(...)`, assert `lastRequest.raw` (or a new captured field) carries `yolo11n.pt` — if the remote payload carries the model at all (decide the contract: **the worker owns the model**, the API does NOT send it — see Step 2; if so, the RED test belongs on `server.py` instead: `test_server.py` asserts `GET /health` reports the env-configured model).

**Contract decision (fixed now):** the **model lives in the worker**; local spawn passes `--model`, remote does not send it. So:
- RED A (TS): local path — set env, stub not involved; assert via a unit-visible seam: extract `yoloCliArgs(source)` helper in `aiVision.ts`, test it returns `['--model', 'yolo11n.pt', ...]` under env.
- RED B (Python): `vision-worker/test_server.py` — start server with `ONETEAM_YOLO_MODEL=yolo11n.pt`, assert `/health` body `"model": "yolo11n.pt"`.

**Step 2 (GREEN):**

```ts
// aiVision.ts, replacing the literal in spawn args
const model = process.env.ONETEAM_YOLO_MODEL || 'yolov8n.pt';
res = spawnSync(venvPython, [scriptPath, '--image', source, '--model', model, ...]);
```

```python
# vision-worker/server.py
MODEL = os.environ.get('ONETEAM_YOLO_MODEL', 'yolov8n.pt')   # used everywhere yolov8n.pt is hard-coded
```

**Step 3:** RED both, GREEN both, run `npm run test:vision` + `.venv/bin/python vision-worker/test_server.py`.

**Step 4: Commit** — `feat(vision): YOLO model selectable via ONETEAM_YOLO_MODEL`

### Task 3.2: Benchmark yolov8n vs yolo11n on the Part-1 fixtures

**Files:** Create `scripts/yolo_benchmark.py` — runs `run_inference` N=5 times per model per fixture, prints median ms + detection counts side by side.

```python
# core loop (same import pattern as yolo_quality_check.py)
for model in ('yolov8n.pt', 'yolo11n.pt'):
    for fixture in fixtures:
        times, counts, synth = [], [], []
        for _ in range(5):
            t0 = time.perf_counter()
            out = run_inference(fixture, model_path=model)   # match real signature
            times.append((time.perf_counter() - t0) * 1000)
            counts.append(out.get('detected_count', 0)); synth.append(out.get('synthetic_fallback'))
        print(model, os.path.basename(fixture), f'median={sorted(times)[2]:.0f}ms', counts, 'synthetic:', any(synth))
```

`yolo11n.pt` downloads on first use (~5 MB). Run:

```bash
.venv/bin/python scripts/yolo_benchmark.py
```

**Decision rule (pre-registered):** switch default to `yolo11n.pt` only if it is (a) strictly better detections on ≥1 fixture with no regression on others, AND (b) median latency ≤ 1.5× yolov8n. If it wins: change defaults in `aiVision.ts` + `server.py` + `Dockerfile:47` (pre-warm line) together; if not — keep `yolov8n.pt`, record numbers in the benchmark output, done.

**Commit** — `perf(vision): benchmark yolov8n vs yolo11n, <switch|keep> default`

### Task 3.3: Deploy + verify if the default changed

- `git push origin main` → Railway auto-deploy (builder `vision-worker/Dockerfile`).
- Verify: `railway deployment list` shows new commit `SUCCESS`; `GET https://vision-worker-production-d9b4.up.railway.app/health` reports the new model; rerun the Part-1 remote probe.

---

## Part 4 — `conf` threshold configuration

### Task 4.1: RED — `ONETEAM_YOLO_CONF` reaches both transports

**Files:**
- Modify: `src/services/vision/vision.test.ts` (remote stub: assert payload carries `conf`)
- Modify: `vision-worker/test_server.py` (assert payload `conf` forwarded — already partially covered by the data-URL test; extend to assert the DEFAULT when env is set)
- Modify: `src/services/aiVision.ts`, `vision-worker/server.py`

**Step 1 (RED):**
- TS: set `process.env.ONETEAM_YOLO_CONF = '0.55'`, run remote `analyze`, assert parsed `lastRequest.image` exists AND `lastRequest.conf === 0.55`. Today payload has no `conf` → RED.
- Python: start stub server with `ONETEAM_YOLO_CONF=0.55`, POST `/detect` **without** `conf` key, assert `received["conf"] == 0.55`. Today default is hard `0.25` → RED.

**Step 2 (GREEN):**

```ts
// aiVision.ts — remote body
const conf = Number(process.env.ONETEAM_YOLO_CONF);
body: JSON.stringify({
  image: ...,
  ...(Number.isFinite(conf) && conf > 0 ? { conf } : {}),
})
// spawnSync path: append '--conf', String(conf) when the env var is set (arg default already 0.25)
```

```python
# vision-worker/server.py
DEFAULT_CONF = float(os.environ.get('ONETEAM_YOLO_CONF', '0.25'))
# payload line becomes: conf=float(payload.get('conf', DEFAULT_CONF)),
```

**Step 3:** RED both → GREEN both → `npm run test:vision` (41+) + `.venv/bin/python vision-worker/test_server.py` (11+).

**Step 4: Commit** — `feat(vision): confidence threshold configurable via ONETEAM_YOLO_CONF`

**Step 5 (after Part 3 deploy rules):** set the Railway service env var only after a measured reason exists — do not change prod behavior just because the knob exists.

---

## Part 5 — `test:stores` flake (investigate, then guard)

**Known facts (from 2026-10-06):** 1 failure in ~3 full runs: `'and it is gone from the list'` failed while `'AND IT IS GONE FROM POSTGRESQL'` passed. `DELETE` route is awaited (`portal.controller.ts:75` → `portal.service.ts:630` → `await db.deleteStore`); `getStores()` reads **in-memory** `db.stores` (`portal.service.ts:343`); suites run **serially** (`run-live-suites.mjs`).

### Task 5.1: Bounded reproduction with listener evidence

**Objective:** Reproduce under full-suite conditions OR bound the miss rate.

**Step 1:** loop up to 3 full harness runs, capturing the API listener PID each time:

```bash
cd /Users/macbookair/GitHub/oneTeam && unset NODE_ENV
for i in 1 2 3; do
  lsof -nP -iTCP:3001 -sTCP:LISTEN > /tmp/stores-flake-$i.listener
  bash scripts/quality/local-live-tests.sh > /tmp/stores-flake-$i.log 2>&1
  grep -a 'checks passed' /tmp/stores-flake-$i.log
done
```

**Step 2:** on any failure → go to 5.2. On 3 green runs → skip to 5.4.

### Task 5.2: Instrument the exact path (systematic-debugging)

Re-run `SUITES=test:stores` in a tight loop (20×) with temporary logging (must not be committed):

- `packages/database/src/index.ts deleteStore`: log `storeId`, `this.stores.length` before/after filter, and `removed = lengthBefore - lengthAfter`.
- `portal.service getStores()`: log `db.stores.map(s => s.id).includes(storeId)` right in the test's failing request window (temporarily log in controller).
- Assert-on-boot invariant: after DB hydration, `new Set(ids).size === ids.length` (duplicate-id hypothesis).

**Hypotheses to kill, in order:** (1) duplicate id in `db.stores` — filter removes one copy, another survives; (2) stale API process answering on 3001 (memory says this recurs on this machine — compare `lsof` PID vs harness-spawned PID); (3) two DB instances/modules (hydration vs runtime singleton).

### Task 5.3: RED test + fix (only if 5.2 found a cause)

The fix gets a failing test first — e.g. duplicate-id hypothesis:

```ts
// apps/api/test/store-crud.spec.ts — or a unit test on the DB class
check('store ids are unique in memory', new Set(db.stores.map(s => s.id)).size === db.stores.length);
```

RED (if the invariant is actually violated) → fix at the hydration/create site → GREEN.

### Task 5.4: Cheap standing guards (even without a repro)

1. **Unique-id invariant** as a check inside an existing live suite (catches hypothesis 1 forever).
2. **Harness listener PID assert**: `local-live-tests.sh` already checks port 3001 — extend it to record `lsof` PID before start and fail if the post-start listener PID ≠ pre-start (stale-API detection).

### Task 5.5: Commit

```bash
git commit -am "test(api): guard store list/delete consistency (flake follow-up)"
```

---

## Final gate (after Parts 1–5)

```bash
unset NODE_ENV
node scripts/quality/local-gate.mjs          # expect 12/12
bash scripts/quality/local-live-tests.sh     # expect 562+ checks, 0 failed
git diff --stat                              # review
grep -rnE 'password=|secret=|token=|sk-or-' <changed files>   # expect clean
git push origin main                         # Railway auto-deploys vision-worker if its files changed
railway deployment list                      # new commit → SUCCESS
curl -s https://vision-worker-production-d9b4.up.railway.app/health
```
