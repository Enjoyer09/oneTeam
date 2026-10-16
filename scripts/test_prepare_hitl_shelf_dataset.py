#!/usr/bin/env python3
"""Tests for safe conversion of the Humans in the Loop shelf archive."""

import json
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_hitl_shelf_dataset import EXPECTED_ROOT, prepare  # noqa: E402


class PrepareHITLDatasetTests(unittest.TestCase):
    def make_image(self, color: tuple[int, int, int]) -> bytes:
        stream = BytesIO()
        Image.new("RGB", (20, 12), color=color).save(stream, format="JPEG")
        return stream.getvalue()

    def create_archive(self, path: Path, out_of_bounds: bool = False) -> None:
        classes = [
            {"id": 10213293, "title": "Price"},
            {"id": 10213294, "title": "Product"},
        ]
        images = {
            "001.jpg": self.make_image((200, 0, 0)),
            "002.jpg": self.make_image((0, 200, 0)),
            "003.jpg": self.make_image((0, 0, 200)),
            "004.jpg": self.make_image((200, 0, 0)),
        }
        with ZipFile(path, "w") as archive:
            archive.writestr("Supermarket shelves/meta.json", json.dumps({"classes": classes}))
            for name, image in images.items():
                archive.writestr(EXPECTED_ROOT + "images/" + name, image)
                (x2, y2) = (22, 10) if out_of_bounds and name == "002.jpg" else (18, 10)
                data = {
                    "size": {"height": 12, "width": 20},
                    "objects": [
                        {
                            "id": 1,
                            "classId": 10213294,
                            "classTitle": "Product",
                            "geometryType": "rectangle",
                            "points": {"exterior": [[1, 1], [x2, y2]]},
                        },
                        {
                            "id": 2,
                            "classId": 10213293,
                            "classTitle": "Price",
                            "geometryType": "rectangle",
                            "points": {"exterior": [[3, 3], [3, 3]]},
                        },
                    ],
                }
                archive.writestr(EXPECTED_ROOT + "annotations/" + name + ".json", json.dumps(data))

    def test_deduplicates_and_makes_disjoint_coco_splits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.zip"
            output = root / "prepared"
            self.create_archive(archive)

            summary = prepare(archive, output, seed=42)

            self.assertEqual(len(summary["deduplicated_images"]), 1)
            self.assertEqual(summary["dropped_degenerate_annotations"], 3)
            split_hashes = {
                split: set(data["image_sha256"].values())
                for split, data in summary["splits"].items()
            }
            self.assertFalse(split_hashes["train"] & split_hashes["val"])
            self.assertFalse(split_hashes["train"] & split_hashes["test"])
            self.assertFalse(split_hashes["val"] & split_hashes["test"])
            coco = json.loads((output / "annotations/instances_train.json").read_text())
            self.assertEqual([item["name"] for item in coco["categories"]], ["product", "price"])

    def test_refuses_out_of_bounds_box_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.zip"
            output = root / "prepared"
            self.create_archive(archive, out_of_bounds=True)
            output.mkdir()
            sentinel = output / "preserve.txt"
            sentinel.write_text("existing data")

            with self.assertRaisesRegex(ValueError, "Out-of-image rectangle"):
                prepare(archive, output, force=True)

            self.assertEqual(sentinel.read_text(), "existing data")


if __name__ == "__main__":
    unittest.main(verbosity=2)
