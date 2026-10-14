/**
 * oneTeam — Hybrid vision orchestrator
 * ============================================================================
 *
 * Stock YOLO detects generic bottles but cannot verify brands or planograms.
 * The vision-LLM attempts a planogram judgement, but may be confidently wrong.
 *
 * The hybrid uses this escalation path:
 *
 *   1. Run YOLO. The current COCO provider is never verdict-confident.
 *   2. Ask the LLM about the shelf and planogram. Retain generic YOLO boxes.
 *   3. Require a confirmed beverage shelf and at least three YOLO bottle boxes
 *      before an LLM verdict can bypass human review. This is a temporary
 *      safeguard until a SKU-trained model has been evaluated.
 *
 * `combineHybrid` is a pure function so the escalation logic is tested without a
 * worker or a network. The provider does only the I/O around it.
 */
import { clock } from '@oneteam/types';
import type { VisionAnalysis, VisionInput, VisionProvider } from './types';

/** How confident YOLO must be, on its own, to skip the LLM. */
export const DEFAULT_YOLO_CONFIDENCE_FLOOR = 0.55;

export interface HybridThresholds {
  yoloConfidenceFloor: number;
}

/** Why the hybrid reached its verdict — carried into the summary and audit. */
export type HybridPath =
  'yolo-confident' | 'llm-confident' | 'llm-unsure-human-review' | 'no-llm-human-review';

/**
 * Merge the layers into one verdict. Pure: no I/O, no clock.
 *
 * `llm` is null when the LLM was never consulted (YOLO was confident) or is not
 * configured. The YOLO analysis always supplies the on-shelf `detections`/boxes,
 * because the LLM produces none.
 */
export function combineHybrid(
  yolo: VisionAnalysis,
  llm: VisionAnalysis | null,
  path: HybridPath,
  analyzedAt: string,
): VisionAnalysis {
  const authoritative = path === 'llm-confident' && llm ? llm : yolo;
  // A vision model alone may confidently misread a room as a beverage shelf.
  // Until a SKU-trained detector exists, require at least three generic bottle
  // boxes before an LLM verdict can auto-approve. Fewer is a human-review hold.
  const sceneUnverified = path === 'llm-confident' && yolo.detections.length < 3;
  const needsHumanReview =
    sceneUnverified || path === 'llm-unsure-human-review' || path === 'no-llm-human-review';

  const summary =
    path === 'yolo-confident'
      ? `Hibrid: YOLO əmin (${yolo.confidence}). ${yolo.summary}`
      : path === 'llm-confident'
        ? `Hibrid: YOLO qərarsız → vision-LLM əmin (${llm?.confidence}).${sceneUnverified ? ' Foto üzrə ən azı 3 butulka təsdiqlənmədiyi üçün insan yoxlaması tələb olunur.' : ''} ${llm?.summary}`
        : path === 'llm-unsure-human-review'
          ? `Hibrid: hər iki qat qərarsız (YOLO ${yolo.confidence}, LLM ${llm?.confidence}) → insan yoxlaması. ${llm?.summary ?? yolo.summary}`
          : `Hibrid: YOLO qərarsız və vision-LLM konfiqurasiya edilməyib → insan yoxlaması. ${yolo.summary}`;

  return {
    complianceScore: authoritative.complianceScore,
    confidence: Math.max(yolo.confidence, llm?.confidence ?? 0),
    needsHumanReview,
    detectedCounts: authoritative.detectedCounts,
    skuBreakdown: authoritative.skuBreakdown,
    // YOLO owns the boxes; fall back to whatever the authoritative layer has if
    // YOLO produced none.
    detections: yolo.detections.length > 0 ? yolo.detections : authoritative.detections,
    summary,
    engine: 'hybrid',
    provider: 'hybrid',
    model: llm?.model,
    analyzedAt,
  };
}

export class HybridVisionProvider implements VisionProvider {
  readonly name = 'hybrid';

  constructor(
    private readonly yolo: VisionProvider,
    private readonly llm: VisionProvider | null,
    private readonly thresholds: HybridThresholds = {
      yoloConfidenceFloor: DEFAULT_YOLO_CONFIDENCE_FLOOR,
    },
  ) {}

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    const analyzedAt = clock.now().toISOString();
    const yolo = await this.yolo.analyze(input);

    const yoloConfident =
      !yolo.needsHumanReview && yolo.confidence >= this.thresholds.yoloConfidenceFloor;
    if (yoloConfident) {
      return combineHybrid(yolo, null, 'yolo-confident', analyzedAt);
    }

    if (!this.llm) {
      return combineHybrid(yolo, null, 'no-llm-human-review', analyzedAt);
    }

    const llm = await this.llm.analyze(input);
    const path: HybridPath = llm.needsHumanReview ? 'llm-unsure-human-review' : 'llm-confident';
    return combineHybrid(yolo, llm, path, analyzedAt);
  }
}
