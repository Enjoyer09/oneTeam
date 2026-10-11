"""Fine-tune a YOLO detection model on a labelled shelf dataset.

Dataset layout (Ultralytics standard):
  data.yaml            train/val paths + names
  images/{train,val}   *.jpg
  labels/{train,val}   YOLO format: class cx cy w h (normalized)

Usage:
  .venv/bin/python scripts/train_yolo.py --check --data path/to/data.yaml
  .venv/bin/python scripts/train_yolo.py --data path/to/data.yaml --epochs 50
"""
import argparse
import os
import sys

import yaml


def check_dataset(data_yaml: str) -> list:
    """Return problems with the dataset; empty list means usable."""
    if not os.path.isfile(data_yaml):
        return [f'data.yaml not found: {data_yaml}']
    with open(data_yaml) as fh:
        spec = yaml.safe_load(fh) or {}
    root = os.path.dirname(os.path.abspath(data_yaml))
    problems = []
    for split in ('train', 'val'):
        path = spec.get(split)
        if not path:
            problems.append(f'missing "{split}" key in data.yaml')
            continue
        resolved = path if os.path.isabs(path) else os.path.join(root, path)
        if not os.path.isdir(resolved):
            problems.append(f'"{split}" directory not found: {resolved}')
        elif not any(f.lower().endswith(('.jpg', '.jpeg', '.png')) for f in os.listdir(resolved)):
            problems.append(f'"{split}" directory has no images: {resolved}')
    if not spec.get('names'):
        problems.append('missing "names" (class list) in data.yaml')
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--data', required=True, help='path to data.yaml')
    ap.add_argument('--check', action='store_true', help='validate dataset and exit')
    ap.add_argument('--model', default='yolov8n.pt')
    ap.add_argument('--epochs', type=int, default=50)
    ap.add_argument('--imgsz', type=int, default=640)
    args = ap.parse_args()

    problems = check_dataset(args.data)
    if problems:
        for p in problems:
            print(f'ERROR: {p}', file=sys.stderr)
        return 1
    if args.check:
        print(f'OK: {args.data} is a valid YOLO dataset')
        return 0

    from ultralytics import YOLO

    model = YOLO(args.model)
    # Absolute project dir: ultralytics' global settings.json can carry a
    # leftover runs_dir from another machine/project, which would otherwise
    # decide where results land.
    results = model.train(data=args.data, epochs=args.epochs, imgsz=args.imgsz,
                          project=os.path.abspath(os.path.join('runs', 'detect')),
                          name='shelf', exist_ok=True)
    best = os.path.join(str(results.save_dir), 'weights', 'best.pt')
    print(f'TRAINED: {best}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
