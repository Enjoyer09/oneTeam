#!/usr/bin/env python3
"""Dataset integrity tests for the TorchVision training input."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_torchvision_detector import COCODetectionDataset  # noqa: E402


class COCODatasetValidationTests(unittest.TestCase):
    def write_dataset(self, annotation: dict) -> tuple[tempfile.TemporaryDirectory, Path, Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        images = root / "images"
        images.mkdir()
        Image.new("RGB", (10, 8), color="white").save(images / "sample.png")
        annotation_path = root / "instances.json"
        annotation_path.write_text(json.dumps(annotation), encoding="utf-8")
        return temporary, images, annotation_path

    def base_annotation(self, bbox=(1, 1, 4, 3)) -> dict:
        return {
            "images": [{"id": 1, "file_name": "sample.png", "width": 10, "height": 8}],
            "categories": [{"id": 1, "name": "unknown"}],
            "annotations": [{"id": 1, "image_id": 1, "category_id": 1, "bbox": list(bbox)}],
        }

    def test_loads_unknown_class_and_valid_box(self):
        temporary, images, annotation_path = self.write_dataset(self.base_annotation())
        self.addCleanup(temporary.cleanup)

        dataset = COCODetectionDataset(images, annotation_path)
        _, target = dataset[0]

        self.assertEqual(dataset.classes, ["__background__", "unknown"])
        self.assertEqual(target["boxes"].tolist(), [[1.0, 1.0, 5.0, 4.0]])

    def test_rejects_bbox_outside_image_instead_of_clipping(self):
        temporary, images, annotation_path = self.write_dataset(self.base_annotation((8, 1, 4, 3)))
        self.addCleanup(temporary.cleanup)

        dataset = COCODetectionDataset(images, annotation_path)
        with self.assertRaisesRegex(ValueError, "out-of-image bbox"):
            dataset[0]

    def test_rejects_duplicate_image_ids(self):
        data = self.base_annotation()
        data["images"].append({"id": 1, "file_name": "sample.png", "width": 10, "height": 8})
        temporary, images, annotation_path = self.write_dataset(data)
        self.addCleanup(temporary.cleanup)

        with self.assertRaisesRegex(ValueError, "image IDs must be unique"):
            COCODetectionDataset(images, annotation_path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
