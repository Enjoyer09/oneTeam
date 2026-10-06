# Shelf datasets — acquisition status (2026-10-06)

The fine-tune pipeline (`scripts/train_yolo.py`) is proven end-to-end
(synthetic 4-image smoke → `runs/detect/shelf/weights/best.pt`, 1 epoch, 7 s).
It needs a **real labelled shelf dataset** to produce a model that beats the
COCO baseline (see `../vision-worker/fixtures/REPORT.md`: COCO detects bottles
but nothing on canned goods).

Nothing meeting all three constraints (permissive license, ≤200 MB, product
bounding boxes) was found in one package. Searched: HuggingFace, Wikimedia,
Kaggle (no credentials on this machine).

| Dataset | License | Size | Verdict |
|---|---|---|---|
| `valiantlynxz/norwegian-grocery` (HF) | **CC-BY-NC-4.0** | 965 MB (248 shelf imgs, 356 classes, YOLO config included) | Best data quality, but NC blocks shipping a model trained on it in a commercial product. OK for local experiments only. |
| `shelfwise-by-form/SKUs_on_shelves_PL` (HF) | CC-BY-4.0 | **11.4 GB** | Permissive but far over budget. |
| Kaggle `humansintheloop/supermarket-shelves-dataset` | "academic + commercial" (custom) | 45 images, 2 classes (Product, Price) | Right license, tiny, but download needs Kaggle credentials (absent here). |
| `Basket-AEye/ai_shelf10` (HF) | **none declared** | 389 MB | Unclear rights — do not use. |

## Decision needed (owner)

1. **Own photos (recommended):** shoot 50–200 shelf photos, label with
   Roboflow/labelimg in YOLO format → highest-value data, clean rights.
2. **Experiment now:** accept NC locally for a non-shipping proof
   (`huggingface-cli download valiantlynxz/norwegian-grocery --repo-type dataset`,
   then convert COCO → YOLO layout).
3. **Kaggle route:** supply `~/.kaggle/kaggle.json`, then the 45-image
   commercial-friendly set is a fast smoke dataset.

## Expected layout (what `--check` validates)

```
datasets/shelf/
  data.yaml              train/val paths + names
  images/{train,val}/*.jpg
  labels/{train,val}/*.txt   class cx cy w h (normalized)
```

`datasets/` is gitignored — datasets never enter the repo.
