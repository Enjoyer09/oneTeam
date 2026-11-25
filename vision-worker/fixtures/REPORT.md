# Generic detector fixture report (updated 2026-10-14)

The earlier 2026-10-06 report called the pipeline trustworthy because local and remote transports agreed. That conclusion was wrong: transport agreement says nothing about product identity. `yolo11n.pt` uses COCO classes. It recognizes generic objects, not oneTeam Retail, Lemon Soda, Orange Soda, shelf facings, or empty stock positions. The removed color/position mapper assigned those names after detection, and its no-detection path invented boxes.

| Input                                                                    | Raw `yolo11n.pt` observation at `conf=0.25`     | Current product result                   |
| ------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------- |
| User's 2026-10-14 screenshot of a room (906×1020, including UI overlays) | `refrigerator` 0.365, `book` 0.252; no `bottle` | 0 generic bottle boxes, no SKU claim     |
| `shelf-01.jpg` (sauce bottles)                                           | Generic bottles                                 | 11 unverified bottle boxes, no SKU claim |
| `shelf-02.jpg` (canned food)                                             | One object classified as a bottle               | 1 unverified bottle box, no SKU claim    |

These fixture outputs are not accuracy metrics: there are too few images, no annotated ground truth, and the user's screenshot is not the original audit photo. The single false bottle on canned food shows why COCO confidence is not SKU confidence. The worker now returns an empty detection list for no bottle and an error for unreadable input; neither case creates a shelf or branded products.

The bot's production `hybrid` provider uses a vision LLM for a planogram judgement. The prompt now requires an explicit beverage-shelf check and includes task requirements. Any uncertain/off-shelf judgement, or any image with fewer than three independent generic bottle boxes, is sent for human review instead of persisting an AI score. This is a conservative temporary gate, not a validated classifier. It may hold valid can-only or sparsely stocked shelves. The panel hides older YOLO-derived branded boxes and warns reviewers that prior AI scores are unverified; historical rows are not deleted or regraded.

Before SKU-level automation can be considered reliable: collect consented, labeled in-store photos across stores, phones, light, glare, occlusion, package variants and negatives such as rooms/food/cans; annotate product-level boxes and an unknown class; split by store and capture session; train or adapt a SKU detector; evaluate per-SKU precision/recall, false-positive rate on negatives, calibration and out-of-distribution abstention against a held-out set; then run shadow mode and compare human decisions before setting an auto-approval threshold. A bottle-only COCO model cannot meet this bar.
