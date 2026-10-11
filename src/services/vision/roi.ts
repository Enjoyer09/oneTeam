/**
 * oneTeam — YOLO pre-filter: region of interest (plan 4.3)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The plan asks the detector to crop to the shelf before the photo is sent to
 * a vision model: "only the ROI is sent, cutting token cost by ~70%".
 *
 * WHY THE DETECTOR DECIDES WHAT TO KEEP
 * --------------------------------------
 * A vision model prices by the pixels it reads. A phone photo of a shelf is
 * mostly ceiling, floor, the merchandiser's elbow and a price sticker; sending
 * all of it buys nothing. Cropping to the bottles is free — the detector has
 * already run locally, it costs nothing per call, and it needs no key.
 *
 * So the pre-filter is: run the cheap deterministic detector, keep only the
 * region containing the things it found, and send that. The model then spends
 * its budget on the shelf rather than the wall behind it.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------
 * A crop that removes product is worse than no crop at all. A shelf audit that
 * silently loses the bottom row reports "fully compliant" about a shelf it did
 * not look at — a false pass, the most damaging thing this system can produce.
 *
 * Therefore a crop is only proposed when it can be shown not to exclude
 * anything the detector found:
 *
 *   - `padRatio` expands the union box, so a detector box that is slightly off
 *     does not clip its own neighbours;
 *   - the union is expanded by `minRetainedRatio` of itself as CONTEXT, so
 *     "where the block sits, what is beside it" survives the crop;
 *   - a crop is REFUSED when it would fall below `minRetainedRatio` of the
 *     frame, because at that point the saving does not justify the risk;
 *   - and when the detector found nothing, there is no union, so no crop is
 *     proposed at all: an empty detection is not evidence that the shelf is
 *     empty, and cropping "to nothing" would send the model an empty image.
 *
 * Hence a refusal reason rather than a box. `computeRoi` never returns
 * coordinates it cannot justify; it returns `{ kind: 'none', reason }` and the
 * caller sends the full photo.
 */
import type { BoundingBox } from '../aiVision';

/** What the crop decision is. */
export type RoiDecision =
  | {
      kind: 'roi';
      /** The kept region, as 0-1 fractions of the frame. */
      box: BoundingBox;
      /** Fraction of the original pixels that remain. 0-1. */
      retainedRatio: number;
      /** Fraction saved against the original. `1 - retainedRatio`. */
      savedRatio: number;
      /** Why this crop is considered safe, for the audit trail. */
      justification: string;
    }
  | {
      kind: 'none';
      /** Why the full photo must be sent. Never empty. */
      reason: RoiRefusal;
    };

export type RoiRefusal =
  | 'no-detections'
  | 'detections-too-scattered'
  | 'crop-would-not-shrink-enough'
  | 'crop-would-cut-product'
  | 'invalid-input';

export interface RoiOptions {
  /**
   * Padding around the union box, as a fraction of that box's own size.
   * Default 0.12. Detector boxes are approximate — a bottle half occluded by
   * the one in front is systematically clipped — so a crop taken literally to
   * the union edge shaves the outermost facings, which are exactly what the
   * audit is about.
   */
  padRatio?: number;
  /**
   * Minimum share of the frame that must survive for a crop to be worth it.
   * Default 0.30. Below this the saving is small and the risk is not.
   */
  minRetainedRatio?: number;
  /**
   * Minimum fraction that must be removed for the crop to be worth sending.
   * Default 0.25. Below this the round trip and the risk buy almost nothing, so
   * the plan's "~70% saved" is not claimed where it was not earned.
   */
  minSavedRatio?: number;
  /**
   * How far apart boxes may be, as a fraction of the frame, before they are
   * treated as unrelated and no crop is proposed. Default 0.9: boxes at
   * opposite ends of a wide aisle shot are not one shelf, and the union would
   * keep nearly the whole frame anyway.
   */
  maxSpreadRatio?: number;
}

const DEFAULTS: Required<RoiOptions> = {
  padRatio: 0.12,
  minRetainedRatio: 0.3,
  minSavedRatio: 0.25,
  maxSpreadRatio: 0.9,
};

/** Clamp a frame fraction into 0-1. */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * The union of the boxes, padded, and whether it is safe to crop to.
 *
 * Pure and total: no I/O, no clock, never throws. Every input produces a
 * decision with a reason, which is what makes this testable without a model, a
 * network, or an image.
 */
export function computeRoi(
  boxes: ReadonlyArray<BoundingBox>,
  options: RoiOptions = {},
): RoiDecision {
  const o = { ...DEFAULTS, ...options };

  const valid = boxes.filter(
    (b) =>
      b &&
      [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      b.width > 0 &&
      b.height > 0,
  );

  // A zero-sized detection is a broken detector, not an empty shelf. Neither
  // reading justifies a crop, so nothing is proposed and the reason tells them
  // apart rather than collapsing both into "nothing found".
  if (valid.length === 0) {
    return { kind: 'none', reason: boxes.length > 0 ? 'invalid-input' : 'no-detections' };
  }

  let minX = valid[0].x;
  let minY = valid[0].y;
  let maxX = valid[0].x + valid[0].width;
  let maxY = valid[0].y + valid[0].height;

  for (const b of valid.slice(1)) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }

  const unionW = maxX - minX;
  const unionH = maxY - minY;

  // Boxes spread across most of the frame are not one shelf. The union would
  // keep nearly everything, so the refusal is honest twice over: it saves
  // nothing, and the detector may be reading two different scenes.
  if (Math.max(unionW, unionH) > o.maxSpreadRatio) {
    return { kind: 'none', reason: 'detections-too-scattered' };
  }

  // Pad outward, then add context, then clamp to the frame. Order matters:
  // padding before clamping lets a box near an edge keep its padding on the
  // sides that have room, instead of being squeezed back by the clamp.
  const padX = unionW * o.padRatio;
  const padY = unionH * o.padRatio;
  const contextX = unionW * o.minRetainedRatio;
  const contextY = unionH * o.minRetainedRatio;

  const left = clamp01(minX - padX - contextX);
  const top = clamp01(minY - padY - contextY);
  const right = clamp01(maxX + padX + contextX);
  const bottom = clamp01(maxY + padY + contextY);

  // Clamping can collapse a degenerate box; an empty crop would send the model
  // nothing at all, which is worse than sending the whole photo.
  if (right - left <= 0 || bottom - top <= 0) {
    return { kind: 'none', reason: 'invalid-input' };
  }

  const box: BoundingBox = { x: left, y: top, width: right - left, height: bottom - top };
  const retainedRatio = box.width * box.height;
  const savedRatio = 1 - retainedRatio;

  // Unreachable with the context expansion above, kept because the thresholds
  // are independently configurable: a caller who sets a large padRatio with a
  // small minRetainedRatio must not be able to produce a sliver by accident.
  if (retainedRatio < o.minRetainedRatio) {
    return { kind: 'none', reason: 'crop-would-cut-product' };
  }

  if (savedRatio < o.minSavedRatio) {
    return { kind: 'none', reason: 'crop-would-not-shrink-enough' };
  }

  return {
    kind: 'roi',
    box,
    retainedRatio: Number(retainedRatio.toFixed(3)),
    savedRatio: Number(savedRatio.toFixed(3)),
    justification:
      `${valid.length} deteksiya birləşdirildi — çərçivənin ` +
      `${Math.round(retainedRatio * 100)}%-i saxlanılır ` +
      `(${Math.round(savedRatio * 100)}% qənaət).`,
  };
}

/**
 * The sentence handed to the vision model when a crop was applied.
 *
 * The model must know the image is a CROP, not a whole shelf photo. Without
 * this it describes a partial view as the entire shelf and reports "not
 * visible" for SKUs that are merely outside the crop — a fabricated gap.
 */
export function roiNoteFor(decision: RoiDecision): string | undefined {
  if (decision.kind !== 'roi') return undefined;
  return (
    `QEYD: Bu şəkil bütün rəfin DEYİL — yalnız detektorun tapdığı hissənin kəsiyidir ` +
    `(${Math.round(decision.retainedRatio * 100)}% çərçivə). Kəsiyin xaricində heç nə yoxdur. ` +
    `Xaricdəki SKU-ları "görünmür" deyə qiymətləndirmə; yalnız görünən hissəni ver.`
  );
}
