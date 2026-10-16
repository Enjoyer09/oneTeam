# TorchVision detector dataset

The local training prototype is `scripts/train_torchvision_detector.py`. It trains a Faster R-CNN MobileNetV3 FPN detector from random initialization on COCO JSON annotations and does not download pretrained weights. That avoids importing an unclear pretrained-weight license into the model.

For a generic shelf-detection experiment, Humans in the Loop publishes a 45-image [Supermarket Shelves dataset](https://humansintheloop.org/resources/datasets/supermarket-shelves-dataset/) under CC0 1.0. It has 11,743 boxes but only the generic `Product` and `Price` classes. The page currently requires a form to access the archive. If obtained, convert its annotations into the COCO layout below, use category names `product` and `price`, and keep this experiment separate from SKU evaluation. It can test generic product localization in dense shelves; it cannot teach or validate Sprite/Coca-Cola recognition. Do not bypass the publisher's form or infer SKU labels from these images.

The received archive stays local under `datasets/hitl-supermarket/` and is gitignored. To prepare it, run `.venv/bin/python scripts/prepare_hitl_shelf_dataset.py --archive 'datasets/hitl-supermarket/Supermarket shelves.zip' --output datasets/hitl-supermarket/prepared --exclude-image 009.jpg --exclude-reason '45 source boxes exceed image bounds; image excluded instead of guessing a coordinate transform'`. The converter removes exact duplicate image files, drops zero-area boxes with an explicit count, checks all remaining boxes, and creates disjoint train/validation/test COCO splits. Then train a small generic experiment with `.venv/bin/python scripts/train_torchvision_detector.py --dataset datasets/hitl-supermarket/prepared --dataset-source 'Humans in the Loop Supermarket Shelves' --dataset-license CC0-1.0 --output datasets/hitl-supermarket/model --epochs 5`; evaluate the untouched test split with `scripts/evaluate_torchvision_holdout.py`. Do not use this experiment for product/SKU decisions.

Expected layout:

```text
datasets/<dataset>/
  images/train/
  images/val/
  annotations/instances_train.json
  annotations/instances_val.json
```

Use only photos and labels that OneTeam has permission to use. Record the real source and license when invoking training; the script writes them into the checkpoint manifest. Split train and validation by store and capture session, and keep identical image files out of both splits. Keep a final test set from separate stores or capture sessions untouched until model selection is complete.

Annotation policy:

- Label `coca_cola_classic`, `coca_cola_zero`, `sprite`, or `fanta` only when the package branding is visually readable. Do not infer a brand from color, shelf position, or neighboring products.
- Label competing or out-of-scope products as `other_product`. These detections are intentionally excluded from the product results shown by the inference adapter, while helping training distinguish target products from confusing objects.
- Label an unreadable, heavily occluded, or ambiguous product as `unknown` with a tight box; do not guess its brand. This prevents it from being silently treated as background. Images with no relevant objects may have an empty annotation list and teach the detector background examples.
- Draw a tight box around each individual package. Do not box a whole shelf, grouped row, price tag, or reflection as a product.
- Review labels with a second person where possible, especially hard negatives such as red cans, green bottles, logos, and partial packages.

Review every class-wise validation result and false positive before enabling a checkpoint. A model trained from scratch on an empty or tiny dataset is not production-ready. Public supermarket shelf datasets may help test generic shelf detection, but their generic product labels do not provide verified Coca-Cola or Sprite SKU labels; do not relabel by visual guesswork.

Run training with: `.venv/bin/python scripts/train_torchvision_detector.py --dataset datasets/<dataset> --dataset-source <source> --dataset-license <license> --output artifacts/<model>`. The output checkpoint and JSON manifest must be deployed together. Training writes `deployment_approval.approved=false`; do not deploy it as-is. A reviewer may set approval only after reviewing the rights, holdout metrics and false-positive report, and must record reviewer, date and report reference. The worker rejects unapproved checkpoints. Keep datasets and model artifacts out of Git.
