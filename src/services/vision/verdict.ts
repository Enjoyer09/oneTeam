/**
 * oneTeam — shelf-audit verdict schema (plan 4.2)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The shape a vision model must answer with, validated rather than trusted. The
 * plan asks for `planogramScore(0-100)`, `missingSKUs[]`, `extraItems[]`,
 * `anomalies[]`, `confidence(0-1)`; the field names used here are that list
 * renamed to the vocabulary the codebase already speaks — `sku` (matching
 * `CocaColaSKU`), and `complianceScore` matching the score every other engine
 * produces.
 *
 * WHY A SCHEMA, WHEN THE CLIENT ALREADY PARSES BY HAND
 * -----------------------------------------------------
 * `openrouterClient.parseJudgement` coerces a loose object and fills gaps with
 * zeros. That is deliberate for the transport — a malformed reply must not
 * crash a submission — but it has the cost that a model returning
 * `complianceScore: "85"` (a string) is silently accepted as 85, and
 * `confidence: 7` (out of range) as 0. Coercion that never rejects is how a
 * number becomes a number that means nothing.
 *
 * This module is the other half: strict validation. A reply that cannot satisfy
 * the schema is a FAILED VERDICT, never a defaulted one. That distinction is
 * the whole point — "the model said 70%" and "we could not read what the model
 * said" must never look the same to a supervisor.
 *
 * The two layers are not redundant. `parseJudgement` is what the transport must
 * do to stay up; this is what a verdict must do to be believed.
 *
 * THE MODEL IS NOT TRUSTED, INCLUDING ITS OWN SELF-REPORT
 * -------------------------------------------------------
 * `confidence` is the model's claim about itself, bounded to 0-1. A model
 * returning `confidence: 0.95` on a blurry photo has not been checked, so the
 * pipeline treats a high self-confidence as a claim rather than a fact — see
 * `assessVerdict`.
 */
import { z } from 'zod';
import { SKU_METADATA, type CocaColaSKU, type PlanogramRequirement } from '../aiVision';

/** The SKUs a model is allowed to name. Anything else is a hallucinated SKU. */
const SKU_ENUM = z.enum([
  'coca_cola_classic',
  'coca_cola_zero',
  'fanta',
  'sprite',
  'out_of_stock_gap',
] as const);

/**
 * Compile-time guard: this enum must stay in step with `CocaColaSKU`.
 *
 * Without it, adding a SKU to the domain type would compile fine here and fail
 * only at runtime, when a model named the new SKU and the schema rejected it.
 * Both directions are checked, so neither adding a domain SKU nor dropping one
 * from the enum can pass unnoticed.
 */
type _EnumCoversDomain =
  Exclude<CocaColaSKU, z.infer<typeof SKU_ENUM>> extends never ? true : never;
type _DomainCoversEnum =
  Exclude<z.infer<typeof SKU_ENUM>, CocaColaSKU> extends never ? true : never;
const _enumIsInStep: [_EnumCoversDomain, _DomainCoversEnum] = [true, true];
void _enumIsInStep;

/**
 * One SKU the model says is missing or under-faced.
 *
 * `shortfall` is how many facings were MISSING, not how many were seen: a model
 * that cannot count says `shortfall: 0` and is not wrong about the SKU being
 * absent, only about the size of the gap. Keeping them separate lets a caller
 * use the reliable half.
 */
export const MissingSkuSchema = z.object({
  sku: SKU_ENUM,
  shortfall: z.number().int().min(0).max(99),
  note: z.string().max(200).optional(),
});

/**
 * An item on the shelf that the planogram does not call for.
 *
 * Deliberately a free string, NOT a SKU: the point of `extraItems` is catching
 * a competitor's product, which by definition is not in our catalogue. Forcing
 * it into `CocaColaSKU` would make the field useless for its only real use.
 */
export const ExtraItemSchema = z.object({
  description: z.string().min(1).max(120),
  /** Where on the shelf. Untrusted free text — a display hint only. */
  location: z.string().max(80).optional(),
});

/**
 * Something visibly wrong that is neither a count nor a SKU.
 *
 * Free text on purpose. The catalogue of shelf faults is open (a crushed bottle,
 * a leaking cap, a facing turned the wrong way, a price label facing outward),
 * and narrowing it to an enum would force the model to drop the ones we did not
 * think of — which are exactly the ones worth a supervisor's eyes. Only the
 * *kind* is closed, and it `.catch`es, so an unforeseen word degrades to
 * 'other' instead of failing the whole verdict.
 */
export const AnomalySchema = z.object({
  kind: z
    .enum(['damaged', 'misplaced', 'price_label', 'expired', 'out_of_stock', 'other'])
    .catch('other'),
  description: z.string().min(1).max(200),
  severity: z.enum(['low', 'medium', 'high']).catch('low'),
});

/**
 * The verdict, strict.
 *
 * The top-level fields carry no defaults on purpose: a model that omits
 * `complianceScore` has not judged the shelf, and defaulting it to 0 would
 * turn silence into a failing grade. The three array/count fields default to
 * empty, because "empty" is a truthful statement about a shelf rather than a
 * claim about the model's competence.
 */
export const ShelfVerdictSchema = z.object({
  /** 0-100. Integer: a score with decimals implies precision the model lacks. */
  complianceScore: z.number().int().min(0).max(100),
  /** 0-1, the model's own certainty. A CLAIM, not a verified fact. */
  confidence: z.number().min(0).max(1),
  /** Facing counts per SKU. Only known SKUs, only non-negative counts. */
  detectedCounts: z
    // Built from the enum rather than `z.record(SKU_ENUM, …)`, and the reason
    // is measured, not stylistic: in zod 4 a record keyed by an enum REQUIRES
    // every key of that enum. A model that reported three of five SKUs was
    // rejected for omitting the other two — which is the normal case, not a
    // malformed one. Each key is optional instead, and because the object is
    // still keyed by the enum, an invented SKU is still rejected outright.
    .object(
      Object.fromEntries(
        SKU_ENUM.options.map((k) => [k, z.number().int().min(0).max(999).optional()]),
      ),
    )
    .default({}),
  missingSKUs: z.array(MissingSkuSchema).max(20).default([]),
  extraItems: z.array(ExtraItemSchema).max(20).default([]),
  anomalies: z.array(AnomalySchema).max(20).default([]),
  /** One sentence, Azerbaijani preferred. */
  summary: z.string().max(400).default(''),
  /** Which model wrote this. Filled in by the pipeline, not by the model. */
  model: z.string().max(120).optional(),
});

export type ShelfVerdict = z.infer<typeof ShelfVerdictSchema>;
export type MissingSku = z.infer<typeof MissingSkuSchema>;

/** Why a reply could not be turned into a verdict. */
export type VerdictFailureReason =
  | 'not-json'
  | 'schema-invalid'
  | 'empty'
  // A model that returns a parseable, well-shaped object with no score and no
  // counts has not judged the shelf. Distinct from 'invalid' because the JSON
  // parsed cleanly — it is only empty.
  | 'no-signal';

export type VerdictResult =
  | { ok: true; verdict: ShelfVerdict; warnings: string[] }
  | { ok: false; reason: VerdictFailureReason; detail: string };

/**
 * Parse a model's raw reply into a verdict, or say precisely why not.
 *
 * Never throws and never invents a value. The caller gets either a validated
 * verdict or a reason; `assessVerdict` decides what to do with each.
 */
export function parseVerdict(raw: string): VerdictResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  if (!cleaned) return { ok: false, reason: 'empty', detail: 'the model returned nothing' };

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return {
      ok: false,
      reason: 'not-json',
      detail: `not JSON: ${cleaned.slice(0, 160)}`,
    };
  }

  const parsed = ShelfVerdictSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'schema-invalid',
      detail: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'unknown',
    };
  }

  const warnings: string[] = [];
  const verdict = parsed.data;

  // A score with no counts and no missing SKUs is internally inconsistent: the
  // model graded the shelf without saying what is on it. The score may still be
  // usable, but the SKU breakdown is not, and a reviewer must know which half
  // they are looking at.
  if (Object.keys(verdict.detectedCounts).length === 0 && verdict.missingSKUs.length === 0) {
    warnings.push('no detected counts and no missing SKUs — the score cannot be checked');
  }

  // `out_of_stock_gap` is synthetic: it means "an empty slot where product
  // should be", not a product. A model naming it as a normal item is a category
  // error that would otherwise reach the breakdown as a real facing count.
  if ((verdict.detectedCounts.out_of_stock_gap ?? 0) > 0) {
    warnings.push('"out_of_stock_gap" is an empty slot, not a product — counted as a gap');
  }

  return { ok: true, verdict, warnings };
}

/**
 * What the pipeline should do with a verdict.
 *
 * Separated from `parseVerdict` so the policy is testable without a schema and
 * the schema without a policy. The threshold is one number and it is the hinge
 * the platform turns on: below it, a human decides.
 */
export const MIN_REVIEW_CONFIDENCE = 0.5;

export type VerdictTriage = 'accept' | 'human-review';

export function assessVerdict(
  result: VerdictResult,
  opts: { minConfidence?: number } = {},
): { triage: VerdictTriage; reason: string } {
  const floor = opts.minConfidence ?? MIN_REVIEW_CONFIDENCE;

  if (!result.ok) {
    // Every failure is a human, never a zero. A model that could not be read
    // has said nothing about the shelf; inventing a failing grade would
    // auto-reject work nobody looked at.
    return { triage: 'human-review', reason: `verdict unreadable (${result.reason})` };
  }

  if (result.verdict.confidence < floor) {
    return {
      triage: 'human-review',
      reason: `the model is unsure of its own reading (${result.verdict.confidence})`,
    };
  }

  if (result.warnings.length > 0) {
    return { triage: 'human-review', reason: result.warnings[0] };
  }

  return { triage: 'accept', reason: `confidence ${result.verdict.confidence}` };
}

/**
 * The prompt sent with the image.
 *
 * Written for a model that has been told to return JSON, so it says what to
 * judge, what the planogram is, and the exact keys — without restating the
 * schema's constraints as prose, which models follow less reliably than an
 * explicit key list. The opening line is the plan's own wording.
 */
export function buildVerdictPrompt(
  requirements: PlanogramRequirement[],
  opts: { detectedCounts?: Partial<Record<CocaColaSKU, number>>; roiNote?: string } = {},
): string {
  const rules = requirements
    .map(
      (r) =>
        `- ${r.sku} (${SKU_METADATA[r.sku]?.label ?? r.label}): minimum ${r.minFacings} facing`,
    )
    .join('\n');

  // Pre-filter output, when there is any. This does not tell the model the
  // answer — the detector says how many bottles, the model says whether the
  // shelf is RIGHT — but it anchors the count and cuts the tokens spent
  // re-deriving them from the pixels. Framed as "verify", never "assume": a
  // detector that counted a shadow would otherwise be adopted as fact.
  const hint = opts.detectedCounts
    ? `\nAvtomatik detektor saydı (yoxla, etibar etmə): ${JSON.stringify(opts.detectedCounts)}.`
    : '';

  const roi = opts.roiNote ? `\n${opts.roiNote}\n` : '';

  return (
    'Sən Coca-Cola rəf auditçisisən. Yalnız JSON qaytar, mətn yazma.\n\n' +
    `${roi}` +
    `PLANOGRAM (minimum facing sayı):\n${rules || '- (verilməyib — ümumi rəf tənzimi qiymətləndir)'}\n` +
    hint +
    '\nQiymətləndir:\n' +
    '1. complianceScore (0-100) — rəf planogram-a nə qədər uyğundur.\n' +
    '2. confidence (0-1) — BU ŞƏKİL haqqında öz oxumağına NƏ QƏDƏR ƏMİN olduğun. ' +
    'Şəkil bulanıqdırsa, qaranlıqdırsa və ya rəf görünmürsə, aşağı ver.\n' +
    '3. detectedCounts — hər SKU üçün facing sayı (yalnız yuxarıdakı SKU-lar).\n' +
    '4. missingSKUs — çatışmayan SKU və shortfall (neçə facing çatışır).\n' +
    '5. extraItems — planda olmayan məhsul (rəqib məhsulu ola bilər).\n' +
    '6. anomalies — qırılmış qab, səhv yerləşdirilmiş, qiymət etiketi və s.\n' +
    '7. summary — bir cümlə, azərbaycanca.\n' +
    '"detectedCounts":object,"missingSKUs":[],"extraItems":[],"anomalies":[],"summary":string}'
  );
}
