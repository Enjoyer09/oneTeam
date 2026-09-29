/**
 * oneTeam — Hybrid vision orchestrator
 * ============================================================================
 *
 * The reason the seam exists. A deterministic detector (YOLO) is cheap, fast and
 * offline, but it counts bottles — it does not judge whether the shelf *reads*
 * as the planogram demands (right brand block, no competitor product in the
 * cooler, facings actually forward). A vision-LLM judges exactly that, but it
 * costs money, adds latency, and can be wrong with confidence.
 *
 * So the hybrid spends the expensive engine only when the cheap one is unsure:
 *
 *   1. Run YOLO. If it is confident (real boxes, mean confidence over the floor)
 *      AND its rule verdict is decisive, trust it — no LLM call is made.
 *   2. Otherwise escalate to the vision-LLM for a planogram-compliance judgement.
 *      If the LLM is confident, its verdict wins (YOLO's boxes are kept for the
 *      card).
 *   3. If neither layer will stand behind an answer — YOLO unsure and the LLM
 *      absent or also unsure — the result is `needsHumanReview`. A supervisor
 *      looks, which is the safe default this whole platform is built around.
 *
 * `combineHybrid` is a pure function so the escalation logic is tested without a
 * worker or a network. The provider does only the I/O around it.
 */
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
  const needsHumanReview = path === 'llm-unsure-human-review' || path === 'no-llm-human-review';

  const summary =
    path === 'yolo-confident'
      ? `Hibrid: YOLO əmin (${yolo.confidence}). ${yolo.summary}`
      : path === 'llm-confident'
        ? `Hibrid: YOLO qərarsız → vision-LLM əmin (${llm?.confidence}). ${llm?.summary}`
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
    const analyzedAt = new Date().toISOString();
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
