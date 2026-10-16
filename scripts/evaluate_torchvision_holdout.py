#!/usr/bin/env python3
"""Evaluate a TorchVision checkpoint once on a disjoint, untouched COCO test split."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import torch
from torchvision.models.detection import fasterrcnn_mobilenet_v3_large_fpn

from train_torchvision_detector import ARCHITECTURE, COCODetectionDataset, validate


def evaluate(
    dataset_root: Path,
    checkpoint: Path,
    manifest_path: Path,
    report_path: Path,
    confidence: float = 0.5,
    iou_threshold: float = 0.5,
) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("architecture") != ARCHITECTURE:
        raise ValueError("Unsupported checkpoint architecture")
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError("Checkpoint SHA-256 does not match its manifest")
    classes = manifest.get("classes")
    if not isinstance(classes, list) or len(classes) < 2 or classes[0] != "__background__":
        raise ValueError("Manifest class map is invalid")

    dataset_info_path = dataset_root / "dataset_info.json"
    if not dataset_info_path.is_file():
        raise ValueError("dataset_info.json is required to prove the train/val/test split")
    dataset_info = json.loads(dataset_info_path.read_text(encoding="utf-8"))
    split_images = dataset_info.get("splits", {})
    train_val_hashes = set(split_images.get("train", {}).get("image_sha256", {}).values())
    train_val_hashes.update(split_images.get("val", {}).get("image_sha256", {}).values())
    test_hashes = set(split_images.get("test", {}).get("image_sha256", {}).values())
    if not test_hashes or train_val_hashes & test_hashes:
        raise ValueError("Test split is empty or shares images with train/validation")

    test_data = COCODetectionDataset(
        dataset_root / "images/test",
        dataset_root / "annotations/instances_test.json",
        expected_classes=classes,
    )
    if test_data.file_hashes != test_hashes:
        raise ValueError("Test image files do not match the prepared dataset manifest")
    trained_hashes = set(manifest.get("dataset", {}).get("train_image_sha256", []))
    validation_hashes = set(manifest.get("dataset", {}).get("validation_image_sha256", []))
    if not trained_hashes or not validation_hashes:
        raise ValueError("Model manifest does not record train and validation image hashes")
    if test_hashes & (trained_hashes | validation_hashes):
        raise ValueError("Test split overlaps the images recorded in the checkpoint manifest")

    model = fasterrcnn_mobilenet_v3_large_fpn(
        weights=None,
        weights_backbone=None,
        num_classes=len(classes),
        min_size=320,
        max_size=640,
        box_detections_per_img=int(manifest.get("training", {}).get("max_detections_per_image", 100)),
    )
    checkpoint_data = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(checkpoint_data.get("model_state_dict", checkpoint_data), strict=True)
    metrics = validate(model, test_data, classes, confidence=confidence, iou_threshold=iou_threshold)
    report = {
        "checkpoint_sha256": digest,
        "dataset_source": dataset_info.get("source"),
        "dataset_license": dataset_info.get("license"),
        "test_images": len(test_data),
        "test_annotations_sha256": hashlib.sha256(
            (dataset_root / "annotations/instances_test.json").read_bytes()
        ).hexdigest(),
        "metric": f"class-wise precision/recall at confidence {confidence} and IoU {iou_threshold}; not COCO mAP",
        "confidence_threshold": confidence,
        "iou_threshold": iou_threshold,
        "classes": metrics,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--confidence", type=float, default=0.5)
    parser.add_argument("--iou", type=float, default=0.5)
    args = parser.parse_args()
    if not 0 < args.confidence <= 1 or not 0 < args.iou <= 1:
        parser.error("confidence and iou must be in (0, 1]")
    report = evaluate(
        args.dataset.resolve(),
        args.checkpoint.resolve(),
        args.manifest.resolve(),
        args.report.resolve(),
        confidence=args.confidence,
        iou_threshold=args.iou,
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
