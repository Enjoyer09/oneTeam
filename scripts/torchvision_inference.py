#!/usr/bin/env python3
"""TorchVision inference adapter for local prototyping and the disabled-by-default worker.

This prototype deliberately reports generic COCO bottle detections only. It
does not identify beverage brands, SKUs, shelf rows, or planogram compliance.
The pretrained COCO weights are for local comparison; verify their separate
terms before any commercial deployment. The worker can use only a custom checkpoint by default; COCO mode is an explicit local prototype option.

Usage:
  .venv/bin/python scripts/torchvision_inference.py --mode coco --image vision-worker/fixtures/shelf-01.jpg
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import hashlib
import threading
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MODEL_NAME = "fasterrcnn_mobilenet_v3_large_fpn"
WEIGHTS_NAME = "COCO_V1"

_MODELS: dict[tuple[str, str], tuple[Any, list[str], Any | None]] = {}
_MODEL_LOCK = threading.Lock()


def decode_image(source: str) -> Image.Image | None:
    """Decode a local path or inline data:image URL; reject remote URLs."""
    try:
        if source.startswith("data:image/"):
            _, encoded = source.split(",", 1)
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > MAX_IMAGE_BYTES:
                return None
            image = Image.open(io.BytesIO(raw))
            if image.width * image.height > MAX_IMAGE_PIXELS:
                return None
            return image.convert("RGB")

        path = Path(source)
        if not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
            return None
        with path.open("rb") as stream:
            image = Image.open(stream)
            if image.width * image.height > MAX_IMAGE_PIXELS:
                return None
            return image.convert("RGB")
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return None


def _manifest_for(checkpoint: str) -> tuple[dict, Path]:
    checkpoint_path = Path(checkpoint).resolve()
    manifest_path = checkpoint_path.with_suffix(checkpoint_path.suffix + ".json")
    if not checkpoint_path.is_file() or not manifest_path.is_file():
        raise FileNotFoundError("Custom detector checkpoint or adjacent .json manifest is missing.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("architecture") != MODEL_NAME:
        raise ValueError("Unsupported architecture in custom detector manifest.")
    classes = manifest.get("classes")
    supported_classes = {
        "bottle",
        "classic_soda",
        "zero_soda",
        "orange_soda",
        "other_product",
        "price",
        "product",
        "lemon_soda",
        "unknown",
    }
    if (
        not isinstance(classes, list)
        or len(classes) < 2
        or classes[0] != "__background__"
        or len(set(classes)) != len(classes)
        or not set(classes[1:]).issubset(supported_classes)
    ):
        raise ValueError("Manifest classes must start with __background__ and include a foreground class.")
    digest = hashlib.sha256(checkpoint_path.read_bytes()).hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError("Checkpoint SHA-256 does not match its manifest.")
    if not manifest.get("dataset", {}).get("license") or not manifest.get("dataset", {}).get("source"):
        raise ValueError("Manifest must record dataset source and license before loading custom weights.")
    approval = manifest.get("deployment_approval", {})
    if approval.get("approved") is not True:
        raise ValueError("Custom checkpoint has not been approved for production.")
    if not approval.get("reviewer") or not approval.get("approved_at") or not approval.get("holdout_report"):
        raise ValueError("Production approval must record reviewer, date, and holdout report.")
    return manifest, checkpoint_path


def load_model(mode: str = "coco", checkpoint: str | None = None):
    """Load and cache a prototype COCO model or a provenance-checked custom model."""
    with _MODEL_LOCK:
        if mode not in {"coco", "custom"}:
            raise RuntimeError("TorchVision detector is disabled until a reviewed checkpoint is configured.")
        if mode == "custom" and not checkpoint:
            raise RuntimeError("Custom TorchVision mode requires ONETEAM_TORCHVISION_CHECKPOINT.")
        key = (mode, str(Path(checkpoint).resolve()) if checkpoint else "")
        if key not in _MODELS:
            import torch
            from torchvision.models.detection import (
                FasterRCNN_MobileNet_V3_Large_FPN_Weights,
                fasterrcnn_mobilenet_v3_large_fpn,
            )

            if mode == "coco":
                weights = FasterRCNN_MobileNet_V3_Large_FPN_Weights.COCO_V1
                model = fasterrcnn_mobilenet_v3_large_fpn(weights=weights)
                classes = list(weights.meta["categories"])
            else:
                manifest, checkpoint_path = _manifest_for(checkpoint or "")
                classes = manifest["classes"]
                model = fasterrcnn_mobilenet_v3_large_fpn(
                    weights=None,
                    weights_backbone=None,
                    num_classes=len(classes),
                    min_size=320,
                    max_size=640,
                    box_detections_per_img=int(
                        manifest.get("training", {}).get("max_detections_per_image", 100)
                    ),
                )
                checkpoint_data = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
                state_dict = checkpoint_data.get("model_state_dict", checkpoint_data)
                model.load_state_dict(state_dict, strict=True)
                weights = None
            model.eval()
            _MODELS[key] = (model.to(torch.device("cpu")), classes, weights)
        return _MODELS[key]


def model_status(mode: str = "disabled", checkpoint: str | None = None) -> dict:
    """Report model readiness without triggering downloads or loading weights."""
    key = (mode, str(Path(checkpoint).resolve()) if checkpoint else "")
    cached = _MODELS.get(key)
    manifest = None
    checkpoint_error = None
    if mode == "custom" and checkpoint:
        try:
            manifest = _manifest_for(checkpoint)[0]
        except Exception as error:
            checkpoint_error = f"{type(error).__name__}: {error}"
    return {
        "loaded": cached is not None,
        "mode": mode,
        "model": MODEL_NAME if mode != "disabled" else None,
        "torch_version": getattr(__import__("torch"), "__version__", None),
        "torchvision_version": getattr(__import__("torchvision"), "__version__", None),
        "classes": cached[1] if cached else None,
        "checkpoint_sha256": manifest.get("sha256") if manifest else None,
        "class_map_version": (
            hashlib.sha256(json.dumps(manifest["classes"], separators=(",", ":")).encode()).hexdigest()
            if manifest
            else None
        ),
        "dataset_source": manifest.get("dataset", {}).get("source") if manifest else None,
        "dataset_license": manifest.get("dataset", {}).get("license") if manifest else None,
        "production_approved": bool(manifest and manifest.get("deployment_approval", {}).get("approved")),
        "checkpoint_error": checkpoint_error,
    }


def _make_detection(box: list[float], score: float, width: int, height: int, index: int) -> dict:
    x1, y1, x2, y2 = box
    x1, x2 = max(0.0, min(float(width), x1)), max(0.0, min(float(width), x2))
    y1, y2 = max(0.0, min(float(height), y1)), max(0.0, min(float(height), y2))
    if x2 <= x1 or y2 <= y1:
        raise ValueError("Detection box has no visible area.")

    return {
        "id": f"det-{index}",
        "sku": "unverified_bottle",
        "label": "Butulka — marka təsdiqlənməyib",
        "confidence": round(score, 3),
        "objectClass": "bottle",
        "box": {
            "x": round(x1 / width * 100, 1),
            "y": round(y1 / height * 100, 1),
            "width": round((x2 - x1) / width * 100, 1),
            "height": round((y2 - y1) / height * 100, 1),
        },
        "color": "#64748B",
        "shelfRow": 0,
        "facingIndex": index,
    }


def run_inference(
    source: str,
    conf_thresh: float = 0.25,
    mode: str = "coco",
    checkpoint: str | None = None,
) -> dict:
    """Run generic COCO bottle detection and return the existing worker shape."""
    if not 0.0 < conf_thresh <= 1.0:
        return {"success": False, "error": "Confidence must be greater than 0 and at most 1."}

    image = decode_image(source)
    if image is None:
        return {"success": False, "error": "Image could not be decoded or exceeds 8 MB."}

    if mode == "disabled":
        return {"success": False, "error": "TorchVision detector is disabled pending an approved checkpoint."}
    model, categories, weights = load_model(mode, checkpoint)
    import torch

    width, height = image.size
    tensor = weights.transforms()(image) if weights is not None else torch.from_numpy(
        __import__("numpy").asarray(image).copy().transpose(2, 0, 1)
    ).float() / 255.0
    with torch.inference_mode():
        prediction = model([tensor])[0]

    boxes = prediction["boxes"].detach().cpu().tolist()
    scores = prediction["scores"].detach().cpu().tolist()
    labels = prediction["labels"].detach().cpu().tolist()

    detections = []
    for box, score, label_id in zip(boxes, scores, labels):
        if label_id <= 0 or label_id >= len(categories) or score < conf_thresh:
            continue
        class_name = categories[label_id]
        if class_name not in {"bottle", "classic_soda", "zero_soda", "orange_soda", "lemon_soda"}:
            continue
        try:
            detection = _make_detection(box, float(score), width, height, len(detections) + 1)
            if class_name != "bottle":
                detection["sku"] = class_name
                detection["label"] = class_name.replace("_", " ").title()
            detections.append(detection)
        except ValueError:
            continue

    return {
        "success": True,
        "engine": "torchvision-detection",
        "model": f"{MODEL_NAME}:{WEIGHTS_NAME if mode == 'coco' else 'custom'}",
        "image_dimensions": {"width": width, "height": height},
        "detected_count": len(detections),
        "synthetic_fallback": False,
        "detections": detections,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Local image path or data:image URL")
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--mode", choices=("disabled", "coco", "custom"), default="disabled")
    parser.add_argument("--checkpoint", default=None)
    args = parser.parse_args()
    result = run_inference(args.image, args.conf, args.mode, args.checkpoint)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
