/**
 * oneTeam — Simulation & YOLO vision providers
 * ============================================================================
 *
 * The two engines that already exist in `aiVision.ts`, dressed as `VisionProvider`s
 * so the hybrid and the registry can treat them uniformly. Neither adds analysis
 * logic — they translate `aiVisionService`'s existing output into the seam's
 * `VisionAnalysis` shape and, for YOLO, decide how much to trust it.
 */
import { clock } from '@oneteam/types';
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

  // eslint-disable-next-line @typescript-eslint/require-await -- implements VisionProvider.analyze, which returns a Promise.
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
 * Stock COCO weights can detect a generic bottle, not its beverage brand or
 * planogram compliance. Object confidence must never become verdict confidence.
 * Even a successful detection therefore needs the LLM or a human reviewer.
 */
export class YoloVisionProvider implements VisionProvider {
  readonly name = 'yolo';

  /**
   * @param workerUrl Base URL of a long-lived YOLO worker, when there is one.
   *   Set, the call is one HTTP round-trip to a process that already loaded the
   *   model; unset, the local `spawnSync` worker is used, which is right for a
   *   developer's machine and wrong for anything that has to answer Telegram.
   */
  constructor(private readonly workerUrl?: string) {}

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    // The bot holds the decoded bytes already — it downloaded them from Telegram
    // before uploading. Prefer them: a data: URL is not addressable by the
    // worker, and an R2 URL would cost a second cross-service fetch when the
    // image is already in memory here.
    const imageSource = input.imageBuffer ?? input.photoUrl;
    const outcome = this.workerUrl
      ? await aiVisionService.runUltralyticsInferenceRemote(imageSource, {
          workerUrl: this.workerUrl,
        })
      : aiVisionService.runUltralyticsInferenceDetailed(imageSource);
    // Discard old worker payloads that painted arbitrary COCO objects as SKUs.
    // A rolling deploy may briefly run this bot against the previous worker.
    const detections: DetectionItem[] =
      outcome.ok && !outcome.synthetic
        ? outcome.detections.filter(
            (d) => d.objectClass === 'bottle' && d.sku === 'unverified_bottle',
          )
        : [];
    const reason = outcome.ok
      ? outcome.synthetic
        ? 'synthetic-fallback'
        : 'brand-unverified'
      : outcome.reason;

    return {
      complianceScore: 0,
      confidence: 0,
      needsHumanReview: true,
      detectedCounts: {},
      skuBreakdown: [],
      detections,
      summary: `YOLO (${reason}): ${detections.length} mümkün butulka tapıldı; marka və planogram uyğunluğu müəyyən edilmədi. İnsan yoxlaması tələb olunur.`,
      engine: 'ultralytics-yolo',
      provider: this.name,
      analyzedAt: clock.now().toISOString(),
    };
  }
}
