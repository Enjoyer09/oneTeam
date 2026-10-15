# TorchVision detector dataset

The local training prototype is `scripts/train_torchvision_detector.py`. It trains a Faster R-CNN MobileNetV3 FPN detector from random initialization on COCO JSON annotations and does not download pretrained weights. That avoids importing an unclear pretrained-weight license into the model.

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
- Leave an unreadable, heavily occluded, or ambiguous object unlabeled; do not guess its brand. Images with no target products may have an empty annotation list and teach the detector background examples.
- Draw a tight box around each individual package. Do not box a whole shelf, grouped row, price tag, or reflection as a product.
- Review labels with a second person where possible, especially hard negatives such as red cans, green bottles, logos, and partial packages.

Review every class-wise validation result and false positive before enabling a checkpoint. A model trained from scratch on an empty or tiny dataset is not production-ready. Public supermarket shelf datasets may help test generic shelf detection, but their generic product labels do not provide verified Coca-Cola or Sprite SKU labels; do not relabel by visual guesswork.

Run training with: `.venv/bin/python scripts/train_torchvision_detector.py --dataset datasets/<dataset> --dataset-source <source> --dataset-license <license> --output artifacts/<model>`. The output checkpoint and JSON manifest must be deployed together. Training writes `deployment_approval.approved=false`; do not deploy it as-is. A reviewer may set approval only after reviewing the rights, holdout metrics and false-positive report, and must record reviewer, date and report reference. The worker rejects unapproved checkpoints. Keep datasets and model artifacts out of Git.
