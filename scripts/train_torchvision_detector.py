#!/usr/bin/env python3
"""Train a TorchVision Faster R-CNN detector from scratch on COCO annotations.

No pretrained checkpoint is downloaded or used. Dataset source and license are
required and copied into the output manifest so deployments can audit weight
provenance. Training is CPU-only by default and can be slow without a GPU.

Expected layout:
  dataset/images/train/*.jpg
  dataset/images/val/*.jpg
  dataset/annotations/instances_train.json
  dataset/annotations/instances_val.json

Usage:
  .venv/bin/python scripts/train_torchvision_detector.py \
    --dataset datasets/shelf --dataset-source oneteam-consented-photos \
    --dataset-license own-consented --output artifacts/shelf-detector
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision.models.detection import fasterrcnn_mobilenet_v3_large_fpn

ARCHITECTURE = "fasterrcnn_mobilenet_v3_large_fpn"
SUPPORTED_CLASSES = {
    "bottle",
    "coca_cola_classic",
    "coca_cola_zero",
    "fanta",
    "other_product",
    "price",
    "product",
    "sprite",
    "unknown",
}


class COCODetectionDataset(Dataset):
    def __init__(self, image_root: Path, annotation_file: Path, expected_classes: list[str] | None = None):
        self.image_root = image_root.resolve()
        data = json.loads(annotation_file.read_text(encoding="utf-8"))
        categories = sorted(data.get("categories", []), key=lambda item: item["id"])
        names = [str(category["name"]) for category in categories]
        category_ids = [category["id"] for category in categories]
        if (
            not categories
            or len(set(names)) != len(names)
            or len(set(category_ids)) != len(category_ids)
            or any(not isinstance(category_id, int) or category_id < 1 for category_id in category_ids)
        ):
            raise ValueError(f"{annotation_file}: categories must have unique names and positive integer IDs")
        unsupported = sorted(set(names) - SUPPORTED_CLASSES)
        if unsupported:
            raise ValueError(f"Unsupported classes in {annotation_file}: {', '.join(unsupported)}")
        self.classes = ["__background__", *names]
        if expected_classes is not None and self.classes != expected_classes:
            raise ValueError(f"Train and validation class lists differ: {self.classes} vs {expected_classes}")
        self.category_to_label = {category["id"]: i + 1 for i, category in enumerate(categories)}

        self.images = sorted(data.get("images", []), key=lambda item: item["id"])
        if not self.images:
            raise ValueError(f"{annotation_file}: no images")
        image_ids = [item.get("id") for item in self.images]
        if any(not isinstance(image_id, int) or image_id < 0 for image_id in image_ids) or len(set(image_ids)) != len(image_ids):
            raise ValueError(f"{annotation_file}: image IDs must be unique non-negative integers")
        self.annotations: dict[int, list[dict]] = {int(item["id"]): [] for item in self.images}
        annotation_ids = set()
        for annotation in data.get("annotations", []):
            annotation_id = annotation.get("id")
            if not isinstance(annotation_id, int) or annotation_id < 0 or annotation_id in annotation_ids:
                raise ValueError(f"{annotation_file}: annotation IDs must be unique non-negative integers")
            annotation_ids.add(annotation_id)
            image_id = int(annotation["image_id"])
            if image_id not in self.annotations:
                raise ValueError(f"{annotation_file}: annotation refers to unknown image {image_id}")
            if annotation.get("category_id") not in self.category_to_label:
                raise ValueError(f"{annotation_file}: annotation uses unknown category")
            self.annotations[image_id].append(annotation)

        self.file_hashes: set[str] = set()
        for entry in self.images:
            path = (self.image_root / entry["file_name"]).resolve()
            if not path.is_relative_to(self.image_root) or not path.is_file():
                raise ValueError(f"Image is missing or escapes image root: {entry['file_name']}")
            self.file_hashes.add(hashlib.sha256(path.read_bytes()).hexdigest())

    def __len__(self):
        return len(self.images)

    def __getitem__(self, index):
        item = self.images[index]
        path = (self.image_root / item["file_name"]).resolve()
        image = Image.open(path).convert("RGB")
        width, height = image.size
        boxes, labels, areas, crowds = [], [], [], []
        for annotation in self.annotations[int(item["id"])]:
            x, y, box_width, box_height = map(float, annotation["bbox"])
            if (
                not all(np.isfinite(value) for value in (x, y, box_width, box_height))
                or x < 0
                or y < 0
                or box_width <= 0
                or box_height <= 0
                or x + box_width > width
                or y + box_height > height
            ):
                raise ValueError(f"Invalid or out-of-image bbox in annotation {annotation['id']} ({item['file_name']})")
            x1, y1 = x, y
            x2, y2 = x + box_width, y + box_height
            boxes.append([x1, y1, x2, y2])
            labels.append(self.category_to_label[annotation["category_id"]])
            areas.append((x2 - x1) * (y2 - y1))
            crowds.append(int(annotation.get("iscrowd", 0)))

        image_tensor = torch.from_numpy(np.asarray(image).copy().transpose(2, 0, 1)).float() / 255.0
        target = {
            "boxes": torch.tensor(boxes, dtype=torch.float32).reshape(-1, 4),
            "labels": torch.tensor(labels, dtype=torch.int64),
            "image_id": torch.tensor([int(item["id"])], dtype=torch.int64),
            "area": torch.tensor(areas, dtype=torch.float32),
            "iscrowd": torch.tensor(crowds, dtype=torch.int64),
        }
        return image_tensor, target


def collate(batch):
    return tuple(zip(*batch))


def box_iou(one: list[float], two: list[float]) -> float:
    x1, y1 = max(one[0], two[0]), max(one[1], two[1])
    x2, y2 = min(one[2], two[2]), min(one[3], two[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_one = max(0.0, one[2] - one[0]) * max(0.0, one[3] - one[1])
    area_two = max(0.0, two[2] - two[0]) * max(0.0, two[3] - two[1])
    return intersection / max(area_one + area_two - intersection, 1e-9)


def validate(model, dataset, classes: list[str], confidence: float = 0.5, iou_threshold: float = 0.5):
    """Report class-wise precision/recall at one fixed threshold, not mAP."""
    model.eval()
    stats = {class_name: {"tp": 0, "fp": 0, "fn": 0} for class_name in classes[1:]}
    with torch.inference_mode():
        for image, target in DataLoader(dataset, batch_size=1, shuffle=False, collate_fn=collate):
            prediction = model([image[0]])[0]
            pred_boxes = prediction["boxes"].tolist()
            pred_labels = prediction["labels"].tolist()
            pred_scores = prediction["scores"].tolist()
            true_boxes = target[0]["boxes"].tolist()
            true_labels = target[0]["labels"].tolist()
            matched: set[int] = set()

            order = sorted(range(len(pred_scores)), key=lambda i: pred_scores[i], reverse=True)
            for index in order:
                if pred_scores[index] < confidence or pred_labels[index] <= 0 or pred_labels[index] >= len(classes):
                    continue
                name = classes[pred_labels[index]]
                candidates = [
                    (box_iou(pred_boxes[index], box), gt_index)
                    for gt_index, box in enumerate(true_boxes)
                    if true_labels[gt_index] == pred_labels[index] and gt_index not in matched
                ]
                best = max(candidates, default=(0.0, -1))
                if best[0] >= iou_threshold:
                    stats[name]["tp"] += 1
                    matched.add(best[1])
                else:
                    stats[name]["fp"] += 1
            for gt_index, label in enumerate(true_labels):
                if gt_index not in matched:
                    stats[classes[label]]["fn"] += 1

    output = {}
    for name, counts in stats.items():
        precision = counts["tp"] / max(counts["tp"] + counts["fp"], 1)
        recall = counts["tp"] / max(counts["tp"] + counts["fn"], 1)
        output[name] = {**counts, "precision@0.5": round(precision, 4), "recall@0.5": round(recall, 4)}
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--dataset-source", required=True)
    parser.add_argument("--dataset-license", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--learning-rate", type=float, default=0.005)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1 or args.learning_rate <= 0:
        parser.error("epochs and batch-size must be positive; learning-rate must be greater than zero")

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    dataset_root = args.dataset.resolve()
    train_data = COCODetectionDataset(
        dataset_root / "images/train", dataset_root / "annotations/instances_train.json"
    )
    val_data = COCODetectionDataset(
        dataset_root / "images/val",
        dataset_root / "annotations/instances_val.json",
        expected_classes=train_data.classes,
    )
    overlap = train_data.file_hashes & val_data.file_hashes
    if overlap:
        raise ValueError(f"Train/validation contain {len(overlap)} identical image file(s)")

    model = fasterrcnn_mobilenet_v3_large_fpn(
        weights=None,
        weights_backbone=None,
        num_classes=len(train_data.classes),
        min_size=320,
        max_size=640,
    ).to(torch.device("cpu"))
    optimizer = torch.optim.SGD(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=args.learning_rate,
        momentum=0.9,
        weight_decay=0.0005,
    )
    loader = DataLoader(train_data, batch_size=args.batch_size, shuffle=True, collate_fn=collate)

    for epoch in range(args.epochs):
        model.train()
        total_loss = 0.0
        for images, targets in loader:
            losses = model(list(images), list(targets))
            loss = sum(losses.values())
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += float(loss.detach())
        print(json.dumps({"epoch": epoch + 1, "epochs": args.epochs, "mean_loss": round(total_loss / len(loader), 5)}))

    metrics = validate(model, val_data, train_data.classes)
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint_path = args.output / "model.pth"
    torch.save(model.state_dict(), checkpoint_path)
    digest = hashlib.sha256(checkpoint_path.read_bytes()).hexdigest()
    manifest = {
        "architecture": ARCHITECTURE,
        "classes": train_data.classes,
        "class_map_version": hashlib.sha256(
            json.dumps(train_data.classes, separators=(",", ":")).encode()
        ).hexdigest(),
        "sha256": digest,
        "initialization": "random-no-pretrained-weights",
        "dataset": {
            "source": args.dataset_source,
            "license": args.dataset_license,
            "train_images": len(train_data),
            "validation_images": len(val_data),
            "train_annotations_sha256": hashlib.sha256(
                (dataset_root / "annotations/instances_train.json").read_bytes()
            ).hexdigest(),
            "validation_annotations_sha256": hashlib.sha256(
                (dataset_root / "annotations/instances_val.json").read_bytes()
            ).hexdigest(),
        },
        "deployment_approval": {
            "approved": False,
            "reviewer": None,
            "approved_at": None,
            "holdout_report": None,
        },
        "training": {
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "seed": args.seed,
            "validation_iou_threshold": 0.5,
            "validation_confidence_threshold": 0.5,
            "validation_metrics": metrics,
        },
    }
    (args.output / "model.pth.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"checkpoint": str(checkpoint_path), "sha256": digest, "validation": metrics}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
