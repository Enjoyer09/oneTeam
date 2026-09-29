/**
 * oneTeam — Simulation & YOLO vision providers
 * ============================================================================
 *
 * The two engines that already exist in `aiVision.ts`, dressed as `VisionProvider`s
 * so the hybrid and the registry can treat them uniformly. Neither adds analysis
 * logic — they translate `aiVisionService`'s existing output into the seam's
 * `VisionAnalysis` shape and, for YOLO, decide how much to trust it.
 */
import { aiVisionService, type DetectionItem, type PlanogramRequirement } from '../aiVision';
import type { VisionAnalysis, VisionInput, VisionProvider } from './types';

/** Requirements come from the input, or are derived from the task text as a fallback. */
function requirementsFor(input: VisionInput): PlanogramRequirement[] {
  return aiVisionService.extractPlanogramRequirements(
    input.taskTitle,
    input.taskDescription,
    input.requirements,
  );
}

/** Mean per-box detector confidence, or 0 when there is nothing to average. */
function meanConfidence(detections: DetectionItem[]): number {
  if (detections.length === 0) return 0;
  const sum = detections.reduce((acc, d) => acc + (d.confidence ?? 0), 0);
  return Number((sum / detections.length).toFixed(2));
}

/**
 * The existing simulation, as a provider.
 *
 * It never looks at the image (see the banner in `aiVision.ts`), so its
 * confidence is fixed low and it always asks for a human. The scenario is passed
 * explicitly rather than inferred from the URL: that keeps it off the YOLO code
 * path in `detectShelfProducts` (which fires whenever no scenario is set), so a
 * provider that calls itself `simulation` can never quietly return real
 * detections. It exists for local development and the hybrid's tests — never as
 * a production analyser.
 */
export class SimulationVisionProvider implements VisionProvider {
  readonly name = 'simulation';

  constructor(
    private readonly scenario:
      'compliant' | 'minor_gap' | 'missing_sku' | 'severe_issues' = 'compliant',
  ) {}

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    const { detections, engine } = aiVisionService.detectShelfProducts({
      photoUrl: input.photoUrl,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription,
      mockScenario: this.scenario,
    });
    const evalResult = aiVisionService.evaluateCompliance(
      detections,
      requirementsFor(input),
      engine,
    );

    return {
      complianceScore: evalResult.complianceScore,
      confidence: 0.2,
      needsHumanReview: true,
      detectedCounts: evalResult.detectedCounts,
      skuBreakdown: evalResult.skuBreakdown,
      detections: evalResult.detections,
      summary: `⚠️ Simulyasiya (şəkilə baxmır): ${evalResult.aiSummary}`,
      engine,
      provider: this.name,
      analyzedAt: evalResult.analyzedAt,
    };
  }
}

/**
 * The local Ultralytics YOLO worker, as a provider.
 *
 * Confidence is the mean per-box detector confidence, and a run that could not
 * produce real boxes — the worker was unavailable, timed out, failed, found
 * nothing, or drew its own synthetic boxes — yields confidence 0 and
 * `needsHumanReview`. This is what lets the hybrid know when YOLO alone is not
 * enough to decide.
 */
export class YoloVisionProvider implements VisionProvider {
  readonly name = 'yolo';

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    const outcome = aiVisionService.runUltralyticsInferenceDetailed(input.photoUrl);
    const trustworthy = outcome.ok && !outcome.synthetic;
    const detections = outcome.ok ? outcome.detections : [];
    const evalResult = aiVisionService.evaluateCompliance(
      detections,
      requirementsFor(input),
      'ultralytics-yolo',
    );

    if (!trustworthy) {
      const reason = outcome.ok ? 'synthetic-fallback' : outcome.reason;
      return {
        complianceScore: evalResult.complianceScore,
        confidence: 0,
        needsHumanReview: true,
        detectedCounts: evalResult.detectedCounts,
        skuBreakdown: evalResult.skuBreakdown,
        detections: evalResult.detections,
        summary: `YOLO nəticəsi etibarsız (${reason}): insan yoxlaması tələb olunur. ${evalResult.aiSummary}`,
        engine: 'ultralytics-yolo',
        provider: this.name,
        analyzedAt: evalResult.analyzedAt,
      };
    }

    return {
      complianceScore: evalResult.complianceScore,
      confidence: meanConfidence(detections),
      needsHumanReview: evalResult.autoStatus === 'needs_manual_review',
      detectedCounts: evalResult.detectedCounts,
      skuBreakdown: evalResult.skuBreakdown,
      detections: evalResult.detections,
      summary: evalResult.aiSummary,
      engine: 'ultralytics-yolo',
      provider: this.name,
      analyzedAt: evalResult.analyzedAt,
    };
  }
}
