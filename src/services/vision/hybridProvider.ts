/**
 * oneTeam — Hybrid vision orchestrator
 * ============================================================================
 *
 * The generic detector cannot verify brands or planograms until trained on
 * reviewed product data.
 * The vision-LLM attempts a planogram judgement, but may be confidently wrong.
 *
 * The hybrid uses this escalation path:
 *
 *   1. Run TorchVision. The current detector is never verdict-confident.
 *   2. Ask the LLM about the shelf and planogram. Retain generic detector boxes.
 *   3. Keep every result in human review until a SKU model is validated and
 *      explicitly approved for automatic decisions.
 *
 * `combineHybrid` is a pure function so the escalation logic is tested without a
 * worker or a network. The provider does only the I/O around it.
 */
import { clock } from '@oneteam/types';
import type { VisionAnalysis, VisionInput, VisionProvider } from './types';

/** Confidence floor reserved for a future approved detector. */
export const DEFAULT_DETECTOR_CONFIDENCE_FLOOR = 0.55;

export interface HybridThresholds {
  detectorConfidenceFloor: number;
}

/** Why the hybrid reached its verdict — carried into the summary and audit. */
export type HybridPath =
  'detector-confident' | 'llm-confident' | 'llm-unsure-human-review' | 'no-llm-human-review';

/**
 * Merge the layers into one verdict. Pure: no I/O, no clock.
 *
 * `llm` is null when the LLM was never consulted (detector was confident) or is not
 * configured. The detector analysis always supplies the on-shelf `detections`/boxes,
 * because the LLM produces none.
 */
export function combineHybrid(
  detector: VisionAnalysis,
  llm: VisionAnalysis | null,
  path: HybridPath,
  analyzedAt: string,
): VisionAnalysis {
  const authoritative = path === 'llm-confident' && llm ? llm : detector;
  // Neither the generic COCO detector nor an unvalidated LLM can approve a
  // shelf. Keep the result reviewable until a separately qualified model exists.
  const sceneUnverified = path === 'llm-confident';
  const needsHumanReview = path !== 'detector-confident' || detector.needsHumanReview;

  const summary =
    path === 'detector-confident'
      ? `Hibrid: detektor əmin (${detector.confidence}). ${detector.summary}`
      : path === 'llm-confident'
        ? `Hibrid: detektor → vision-LLM əmin (${llm?.confidence}).${sceneUnverified ? ' Model istehsal qərarı üçün təsdiqlənmədiyi üçün insan yoxlaması tələb olunur.' : ''} ${llm?.summary}`
        : path === 'llm-unsure-human-review'
          ? `Hibrid: hər iki qat qərarsız (detektor ${detector.confidence}, LLM ${llm?.confidence}) → insan yoxlaması. ${llm?.summary ?? detector.summary}`
          : `Hibrid: detektor qərarsız və vision-LLM konfiqurasiya edilməyib → insan yoxlaması. ${detector.summary}`;

  return {
    complianceScore: authoritative.complianceScore,
    confidence: Math.max(detector.confidence, llm?.confidence ?? 0),
    needsHumanReview,
    detectedCounts: authoritative.detectedCounts,
    skuBreakdown: authoritative.skuBreakdown,
    // The detector owns the boxes; fall back to whatever the authoritative layer has if
    // the detector produced none.
    detections: detector.detections.length > 0 ? detector.detections : authoritative.detections,
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
    private readonly detector: VisionProvider,
    private readonly llm: VisionProvider | null,
    private readonly thresholds: HybridThresholds = {
      detectorConfidenceFloor: DEFAULT_DETECTOR_CONFIDENCE_FLOOR,
    },
  ) {}

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    const analyzedAt = clock.now().toISOString();
    const detector = await this.detector.analyze(input);

    const detectorConfident =
      !detector.needsHumanReview && detector.confidence >= this.thresholds.detectorConfidenceFloor;
    if (detectorConfident) {
      return combineHybrid(detector, null, 'detector-confident', analyzedAt);
    }

    if (!this.llm) {
      return combineHybrid(detector, null, 'no-llm-human-review', analyzedAt);
    }

    const llm = await this.llm.analyze(input);
    const path: HybridPath = llm.needsHumanReview ? 'llm-unsure-human-review' : 'llm-confident';
    return combineHybrid(detector, llm, path, analyzedAt);
  }
}
