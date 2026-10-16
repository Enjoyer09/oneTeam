#!/usr/bin/env python3
"""Validate and split the CC0 Humans in the Loop shelf dataset into COCO JSON."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import random
import shutil
from collections import Counter
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

from PIL import Image

SOURCE = "https://humansintheloop.org/resources/datasets/supermarket-shelves-dataset/"
EXPECTED_ROOT = "Supermarket shelves/Supermarket shelves/"
CLASS_IDS = {"Product": 1, "Price": 2}


def _safe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts


def prepare(
    archive: Path,
    output: Path,
    seed: int = 42,
    force: bool = False,
    excluded_images: set[str] | None = None,
    exclusion_reason: str = "excluded by explicit operator choice",
) -> dict:
    if output.exists():
        if not force:
            raise FileExistsError(f"Output already exists: {output}. Pass --force to replace it.")

    try:
        source_zip = ZipFile(archive)
    except (OSError, BadZipFile) as error:
        raise ValueError(f"Could not read dataset archive: {error}") from error

    with source_zip as zf:
        files = [item for item in zf.infolist() if not item.is_dir() and not item.filename.startswith("__MACOSX/")]
        unsafe = [item.filename for item in files if not _safe_member(item.filename)]
        if unsafe:
            raise ValueError(f"Archive contains unsafe paths: {unsafe[:3]}")

        names = {item.filename for item in files}
        meta_name = "Supermarket shelves/meta.json"
        if meta_name not in names:
            raise ValueError("Archive is missing Supermarket shelves/meta.json")
        metadata = json.loads(zf.read(meta_name))
        class_titles = {item.get("id"): item.get("title") for item in metadata.get("classes", [])}
        if set(class_titles.values()) != set(CLASS_IDS):
            raise ValueError(f"Expected exactly Product and Price classes, got {class_titles}")

        image_prefix = EXPECTED_ROOT + "images/"
        annotation_prefix = EXPECTED_ROOT + "annotations/"
        image_by_name = {
            PurePosixPath(item.filename).name: item.filename
            for item in files
            if item.filename.startswith(image_prefix) and PurePosixPath(item.filename).suffix.lower() in {".jpg", ".jpeg", ".png"}
        }
        annotation_by_name = {
            PurePosixPath(item.filename).name.removesuffix(".json"): item.filename
            for item in files
            if item.filename.startswith(annotation_prefix) and item.filename.endswith(".json")
        }
        if not image_by_name or set(image_by_name) != set(annotation_by_name):
            raise ValueError(
                f"Image/annotation mismatch: {len(image_by_name)} images and {len(annotation_by_name)} annotations"
            )

        records = []
        excluded_images = excluded_images or set()
        if not excluded_images.issubset(image_by_name):
            raise ValueError(f"Requested exclusions are not in archive: {sorted(excluded_images - set(image_by_name))}")
        seen_hashes: dict[str, str] = {}
        duplicates = []
        excluded = [{"filename": filename, "reason": exclusion_reason} for filename in sorted(excluded_images)]
        degenerate_annotations = 0
        for filename in sorted(image_by_name):
            if filename in excluded_images:
                continue
            image_bytes = zf.read(image_by_name[filename])
            digest = hashlib.sha256(image_bytes).hexdigest()
            if digest in seen_hashes:
                duplicates.append({"duplicate": filename, "same_as": seen_hashes[digest], "sha256": digest})
                continue
            seen_hashes[digest] = filename

            annotation = json.loads(zf.read(annotation_by_name[filename]))
            with Image.open(io.BytesIO(image_bytes)) as image:
                width, height = image.size
                image.verify()
            if annotation.get("size") != {"height": height, "width": width}:
                raise ValueError(f"Image dimensions disagree with annotation for {filename}")

            parsed_annotations = []
            for object_index, obj in enumerate(annotation.get("objects", []), start=1):
                class_title = obj.get("classTitle")
                class_id = obj.get("classId")
                if class_title not in CLASS_IDS or class_titles.get(class_id) != class_title:
                    raise ValueError(f"Unknown or inconsistent class in {filename}: {class_title!r}")
                if obj.get("geometryType") != "rectangle":
                    raise ValueError(f"Non-rectangle annotation in {filename}")
                points = obj.get("points", {}).get("exterior", [])
                if len(points) != 2 or any(len(point) != 2 for point in points):
                    raise ValueError(f"Malformed rectangle in {filename}, object {object_index}")
                (x1, y1), (x2, y2) = points
                if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (x1, y1, x2, y2)):
                    raise ValueError(f"Non-numeric rectangle in {filename}, object {object_index}")
                if x1 == x2 or y1 == y2:
                    degenerate_annotations += 1
                    continue
                if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                    raise ValueError(f"Out-of-image rectangle in {filename}, object {object_index}: {points}")
                parsed_annotations.append(
                    {
                        "category_id": CLASS_IDS[class_title],
                        "bbox": [x1, y1, x2 - x1, y2 - y1],
                        "area": (x2 - x1) * (y2 - y1),
                        "iscrowd": 0,
                    }
                )
            records.append(
                {
                    "filename": filename,
                    "bytes": image_bytes,
                    "width": width,
                    "height": height,
                    "annotations": parsed_annotations,
                    "sha256": digest,
                }
            )

    rng = random.Random(seed)
    rng.shuffle(records)
    count = len(records)
    test_count = max(1, round(count * 0.15))
    val_count = max(1, round(count * 0.15))
    if test_count + val_count >= count:
        raise ValueError("Not enough unique images for non-empty train, validation, and test splits")
    splits = {
        "train": records[: count - val_count - test_count],
        "val": records[count - val_count - test_count : count - test_count],
        "test": records[count - test_count :],
    }

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    summary = {
        "source": SOURCE,
        "license": "CC0-1.0",
        "seed": seed,
        "deduplicated_images": duplicates,
        "excluded_images": excluded,
        "dropped_degenerate_annotations": degenerate_annotations,
        "splits": {},
    }
    for split, split_records in splits.items():
        image_dir = output / "images" / split
        annotation_dir = output / "annotations"
        image_dir.mkdir(parents=True)
        annotation_dir.mkdir(parents=True, exist_ok=True)
        coco = {
            "info": {"description": "Humans in the Loop Supermarket Shelves, CC0-1.0", "url": SOURCE},
            "licenses": [{"id": 1, "name": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/"}],
            "images": [],
            "annotations": [],
            "categories": [{"id": 1, "name": "product"}, {"id": 2, "name": "price"}],
        }
        class_counts: Counter[str] = Counter()
        annotation_id = 1
        for image_id, record in enumerate(split_records, start=1):
            (image_dir / record["filename"]).write_bytes(record["bytes"])
            coco["images"].append(
                {"id": image_id, "file_name": record["filename"], "width": record["width"], "height": record["height"]}
            )
            for annotation in record["annotations"]:
                coco["annotations"].append({"id": annotation_id, "image_id": image_id, **annotation})
                annotation_id += 1
                class_counts["product" if annotation["category_id"] == 1 else "price"] += 1
        annotation_name = "instances_test.json" if split == "test" else f"instances_{split}.json"
        (annotation_dir / annotation_name).write_text(json.dumps(coco, separators=(",", ":")) + "\n", encoding="utf-8")
        summary["splits"][split] = {
            "images": len(split_records),
            "annotations": len(coco["annotations"]),
            "classes": dict(class_counts),
            "image_sha256": {record["filename"]: record["sha256"] for record in split_records},
        }
    (output / "dataset_info.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--exclude-image", action="append", default=[], help="Explicitly exclude a source image (repeatable)")
    parser.add_argument("--exclude-reason", default="excluded by explicit operator choice")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    summary = prepare(
        args.archive,
        args.output,
        args.seed,
        args.force,
        set(args.exclude_image),
        args.exclude_reason,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
