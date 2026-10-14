#!/usr/bin/env python3
"""Detect generic bottles. Stock COCO weights cannot identify a beverage SKU."""

import argparse
import base64
import json
import os
import sys
import urllib.request

import numpy as np

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
config_dir = os.path.join(base_dir, ".yolo_config")
os.makedirs(config_dir, exist_ok=True)
os.environ["YOLO_CONFIG_DIR"] = config_dir
os.environ["ULTRALYTICS_CONFIG_DIR"] = config_dir
os.environ["YOLO_VERBOSE"] = "False"

try:
    import cv2
    from ultralytics import YOLO
except ImportError as error:
    print(json.dumps({"success": False, "error": f"Import error: {error}"}))
    sys.exit(1)


def load_image(source):
    try:
        if source.startswith("data:image/"):
            encoded = source.split(",", 1)[1]
            data = base64.b64decode(encoded, validate=True)
        elif os.path.isfile(source):
            return cv2.imread(source)
        elif source.startswith("https://"):
            request = urllib.request.Request(source, headers={"User-Agent": "oneTeam-vision/1"})
            with urllib.request.urlopen(request, timeout=10) as response:
                data = response.read(8 * 1024 * 1024 + 1)
        else:
            return None
        if len(data) > 8 * 1024 * 1024:
            return None
        return cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    except (IndexError, ValueError, OSError):
        return None


def run_inference(image_path, model_path="yolo11n.pt", conf_thresh=0.25):
    """Return only COCO bottle boxes, explicitly unverified as to brand/SKU."""
    img = load_image(image_path)
    if img is None:
        return {"success": False, "error": "Image could not be decoded."}

    model = YOLO(model_path)
    img_h, img_w = img.shape[:2]
    result = model.predict(source=img, conf=conf_thresh, verbose=False)[0]
    detections = []

    for box in result.boxes:
        class_id = int(box.cls[0].item())
        # COCO class 39 is bottle. A fire extinguisher, plant, box, book or
        # refrigerator must never acquire a Coke/Sprite label by color/position.
        if model.names[class_id] != "bottle":
            continue

        x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
        x1, y1 = max(0.0, x1), max(0.0, y1)
        x2, y2 = min(float(img_w), x2), min(float(img_h), y2)
        if x2 <= x1 or y2 <= y1:
            continue

        detections.append({
            "id": f"det-{len(detections) + 1}",
            "sku": "unverified_bottle",
            "label": "Butulka — marka təsdiqlənməyib",
            # This is object-detection confidence, not SKU confidence.
            "confidence": round(float(box.conf[0].item()), 3),
            "objectClass": "bottle",
            "box": {
                "x": round(x1 / img_w * 100, 1),
                "y": round(y1 / img_h * 100, 1),
                "width": round((x2 - x1) / img_w * 100, 1),
                "height": round((y2 - y1) / img_h * 100, 1),
            },
            "color": "#64748B",
            "shelfRow": 0,
            "facingIndex": len(detections) + 1,
        })

    return {
        "success": True,
        "engine": "ultralytics-yolo",
        "model": os.path.basename(model_path),
        "image_dimensions": {"width": img_w, "height": img_h},
        "detected_count": len(detections),
        "synthetic_fallback": False,
        "detections": detections,
    }


def main():
    parser = argparse.ArgumentParser(description="Generic bottle detection")
    parser.add_argument("--image", required=True)
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--conf", type=float, default=0.25)
    args = parser.parse_args()
    try:
        print(json.dumps(run_inference(args.image, args.model, args.conf)))
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
