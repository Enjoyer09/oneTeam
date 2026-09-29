/**
 * oneTeam — Vision-LLM provider
 * ============================================================================
 *
 * A shelf-compliance judgement from a vision model (OpenRouter, Anthropic, or a
 * paid retail model), turned into a `VisionAnalysis`. The transport is injected
 * as a `VisionLLMClient` — this provider never touches `fetch`, a URL or a key,
 * so tests pass a fake and production passes the env-configured client (see
 * `./index.ts`).
 *
 * A vision-LLM does not draw bounding boxes, so `detections` is empty; the
 * `skuBreakdown` is derived from the counts it reports against the planogram,
 * for the same display the deterministic engines produce.
 *
 * WHY A THROWN CLIENT BECOMES `needsHumanReview` RATHER THAN A LOW SCORE
 * ---------------------------------------------------------------------
 * `judge` throws on transport/HTTP failure (see `VisionLLMClient`). A model that
 * could not be reached has said nothing about the shelf, and inventing a 0 would
 * auto-reject a submission the model never saw. So a throw yields a 0-confidence
 * `needsHumanReview` result and lets a supervisor look, rather than a verdict.
 */
import {
  aiVisionService,
  SKU_METADATA,
  type CocaColaSKU,
  type PlanogramRequirement,
  type SKUComplianceItem,
} from '../aiVision';
import type { VisionAnalysis, VisionInput, VisionLLMClient, VisionProvider } from './types';

function requirementsFor(input: VisionInput): PlanogramRequirement[] {
  return aiVisionService.extractPlanogramRequirements(
    input.taskTitle,
    input.taskDescription,
    input.requirements,
  );
}

/**
 * Build the per-SKU breakdown from reported counts, without re-scoring.
 *
 * The LLM's own `complianceScore` is kept as the verdict; this only produces the
 * required/detected/met rows for display, mirroring `evaluateCompliance`'s shape
 * so a card rendered from an LLM result looks like one rendered from YOLO.
 */
function breakdownFromCounts(
  counts: Partial<Record<CocaColaSKU, number>>,
  requirements: PlanogramRequirement[],
): SKUComplianceItem[] {
  return requirements.map((req) => {
    const detected = counts[req.sku] ?? 0;
    return {
      sku: req.sku,
      label: req.label,
      required: req.minFacings,
      detected,
      isMet: detected >= req.minFacings,
      matchPercentage: Math.min(100, Math.round((detected / req.minFacings) * 100)),
    };
  });
}

export class VisionLLMProvider implements VisionProvider {
  readonly name: string;

  constructor(private readonly client: VisionLLMClient) {
    this.name = client.label;
  }

  async analyze(input: VisionInput): Promise<VisionAnalysis> {
    const requirements = requirementsFor(input);
    const analyzedAt = new Date().toISOString();

    let judgement;
    try {
      judgement = await this.client.judge(input);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        complianceScore: 0,
        confidence: 0,
        needsHumanReview: true,
        detectedCounts: {},
        skuBreakdown: breakdownFromCounts({}, requirements),
        detections: [],
        summary: `Vision-LLM (${this.client.model}) cavab vermədi: insan yoxlaması tələb olunur. (${detail})`,
        engine: 'vision-llm',
        provider: this.name,
        model: this.client.model,
        analyzedAt,
      };
    }

    const complianceScore = Math.max(0, Math.min(100, Math.round(judgement.complianceScore)));
    const confidence = Math.max(0, Math.min(1, judgement.confidence));

    return {
      complianceScore,
      confidence,
      // A model that is unsure of its own read escalates even when the score is
      // high — an uncertain 80% is exactly the case the hybrid exists to catch.
      needsHumanReview: confidence < 0.5,
      detectedCounts: judgement.detectedCounts,
      skuBreakdown: breakdownFromCounts(judgement.detectedCounts, requirements),
      detections: [],
      summary:
        judgement.summary ||
        (judgement.missingItems.length > 0
          ? `Çatışmayanlar: ${judgement.missingItems.join('; ')}`
          : `Planogram uyğunluğu: ${complianceScore}%`),
      engine: 'vision-llm',
      provider: this.name,
      model: this.client.model,
      analyzedAt,
    };
  }
}

/** Re-exported so callers building prompts have the labels/mins in one place. */
export { SKU_METADATA };
