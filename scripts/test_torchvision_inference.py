#!/usr/bin/env python3
"""Offline contract tests for the experimental TorchVision adapter."""

import os
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import torchvision_inference as detector  # noqa: E402


class FakeWeights:
    meta = {"categories": ["__background__", "bottle", "cup"]}

    @staticmethod
    def transforms():
        return lambda image: torch.zeros((3, image.height, image.width))


class FakeModel:
    def __call__(self, _images):
        return [
            {
                "boxes": torch.tensor([[1, 2, 9, 18], [2, 3, 8, 9], [1, 1, 4, 4]], dtype=torch.float32),
                "scores": torch.tensor([0.91, 0.20, 0.99]),
                "labels": torch.tensor([1, 1, 2]),
            }
        ]


class TorchVisionInferenceTests(unittest.TestCase):
    def test_custom_checkpoint_requires_matching_provenance_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "model.pth"
            checkpoint.write_bytes(b"synthetic checkpoint")
            manifest_path = Path(str(checkpoint) + ".json")
            manifest = {
                "architecture": detector.MODEL_NAME,
                "classes": ["__background__", "sprite"],
                "sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                "dataset": {"source": "test-dataset", "license": "CC0"},
                "deployment_approval": {
                    "approved": False,
                    "reviewer": None,
                    "approved_at": None,
                    "holdout_report": None,
                },
            }
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "not been approved"):
                detector._manifest_for(str(checkpoint))

            manifest["deployment_approval"] = {
                "approved": True,
                "reviewer": "test-reviewer",
                "approved_at": "2026-10-15",
                "holdout_report": "holdout-eval-001",
            }
            manifest_path.write_text(json.dumps(manifest))
            loaded, path = detector._manifest_for(str(checkpoint))
            self.assertEqual(loaded["classes"], manifest["classes"])
            self.assertEqual(path, checkpoint.resolve())

            checkpoint.write_bytes(b"changed checkpoint")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                detector._manifest_for(str(checkpoint))

    def test_rejects_remote_url_without_network_access(self):
        self.assertIsNone(detector.decode_image("https://example.com/photo.jpg"))

    def test_rejects_missing_and_oversized_image(self):
        self.assertIsNone(detector.decode_image("/does/not/exist.jpg"))
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(b"x" * (detector.MAX_IMAGE_BYTES + 1))
            stream.flush()
            self.assertIsNone(detector.decode_image(stream.name))

    def test_rejects_images_above_pixel_limit(self):
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(b"small-file")
            stream.flush()
            too_large = SimpleNamespace(width=10_000, height=10_000)
            with patch.object(detector.Image, "open", return_value=too_large):
                self.assertIsNone(detector.decode_image(stream.name))

    def test_detection_box_is_clamped_and_normalized(self):
        result = detector._make_detection([-2, 2, 20, 18], 0.87654, 10, 20, 1)
        self.assertEqual(result["sku"], "unverified_bottle")
        self.assertEqual(result["objectClass"], "bottle")
        self.assertEqual(result["box"], {"x": 0.0, "y": 10.0, "width": 100.0, "height": 80.0})

    def test_zero_area_detection_is_rejected(self):
        with self.assertRaises(ValueError):
            detector._make_detection([2, 2, 2, 9], 0.9, 10, 10, 1)

    def test_inference_filters_non_bottles_and_low_confidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "pixel.png")
            Image.new("RGB", (10, 20), color="white").save(path)
            with patch.object(detector, "load_model", return_value=(FakeModel(), FakeWeights.meta["categories"], FakeWeights())):
                result = detector.run_inference(path, 0.25)

        self.assertTrue(result["success"])
        self.assertEqual(result["engine"], "torchvision-detection")
        self.assertEqual(result["detected_count"], 1)
        self.assertEqual(result["detections"][0]["confidence"], 0.91)
        self.assertFalse(result["synthetic_fallback"])

    def test_invalid_confidence_fails_closed(self):
        self.assertFalse(detector.run_inference("missing.jpg", 0)["success"])
        self.assertFalse(detector.run_inference("missing.jpg", 1.1)["success"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
