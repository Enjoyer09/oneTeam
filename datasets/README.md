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

Use only photos and labels that OneTeam has permission to use. Record the real source and license when invoking training; the script writes them into the checkpoint manifest. Split train and validation by store and capture session, and keep identical image files out of both splits. Review every class-wise validation result and false positive before enabling a checkpoint. A model trained from scratch on an empty or tiny dataset is not production-ready.

Run training with: `.venv/bin/python scripts/train_torchvision_detector.py --dataset datasets/<dataset> --dataset-source <source> --dataset-license <license> --output artifacts/<model>`. The output checkpoint and JSON manifest must be deployed together. Training writes `deployment_approval.approved=false`; do not deploy it as-is. A reviewer may set approval only after reviewing the rights, holdout metrics and false-positive report, and must record reviewer, date and report reference. The worker rejects unapproved checkpoints. Keep datasets and model artifacts out of Git.
