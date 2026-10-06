/**
 * oneTeam — Vision provider registry (the env-selected edge)
 * ============================================================================
 *
 * The one place that decides which engine runs, from configuration alone.
 * `resolveVisionProvider` reads the environment and returns a `VisionProvider`
 * — or `null`, which is the whole safety story: with nothing configured the
 * function returns `null`, no vision runs, and `autoApproveSubmission` keeps
 * using its rule-based score exactly as it does today. Turning vision on is
 * setting `ONETEAM_VISION_PROVIDER`; there is no code change and no default that
 * quietly starts judging photos.
 *
 * ENV (values referenced by name; keys must never be logged)
 *   ONETEAM_VISION_PROVIDER   off | simulation | yolo | vision-llm | hybrid  (default: off)
 *   ONETEAM_VISION_LLM_URL    OpenAI-compatible chat-completions endpoint
 *   ONETEAM_VISION_LLM_MODEL  e.g. google/gemini-flash-1.5, anthropic/claude-3.5-sonnet
 *   ONETEAM_VISION_LLM_KEY    bearer key for that endpoint
 *   ONETEAM_VISION_LLM_LABEL  optional provider label for the audit trail
 *   ONETEAM_YOLO_WORKER_URL         base URL of a long-lived YOLO worker; unset
 *                                   means the local spawnSync worker (see
 *                                   runUltralyticsInferenceRemote for why that
 *                                   is only right on a developer's machine)
 *   ONETEAM_YOLO_CONFIDENCE_FLOOR  optional 0-1 override for the hybrid hinge
 *
 * EXTERNAL-CALL WARNING
 * ---------------------
 * `vision-llm` and `hybrid` send the shelf photo to a third party. A shelf photo
 * can carry commercial data and incidental PII (a bystander, a price label, a
 * reflection). That is why the network client is opt-in, off by default, and the
 * provider label is recorded on every result: an operator turning this on is
 * making a data-handling decision, and the audit trail must show which model saw
 * what. Free/community models additionally log prompts by default — use a paid,
 * no-log endpoint for anything but prototyping.
 */
import { aiVisionService, SKU_METADATA, type CocaColaSKU } from '../aiVision';
import type { VisionInput, VisionLLMClient, VisionLLMJudgement, VisionProvider } from './types';
import { SimulationVisionProvider, YoloVisionProvider } from './engineProviders';
import { VisionLLMProvider } from './llmProvider';
import { openRouterClientFromEnv } from './openrouterClient';
import { HybridVisionProvider, type HybridThresholds } from './hybridProvider';

export type VisionProviderKind = 'off' | 'simulation' | 'yolo' | 'vision-llm' | 'hybrid';

const COUNTED_SKUS: CocaColaSKU[] = [
  'coca_cola_classic',
  'coca_cola_zero',
  'fanta',
  'sprite',
  'out_of_stock_gap',
];

/**
 * An OpenAI-compatible vision client (OpenRouter, Anthropic via its compat
 * endpoint, or any gateway that speaks chat-completions with image parts).
 *
 * It inlines the image as a base64 data URL and asks for a strict-JSON verdict.
 * It never reads the key from anywhere but its constructor argument, and never
 * puts the key in a log line or an error message.
 */
class HttpVisionLLMClient implements VisionLLMClient {
  readonly label: string;
  readonly model: string;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    model: string,
    label?: string,
    private readonly timeoutMs = 20000,
  ) {
    this.model = model;
    this.label = label ?? `vision-llm:${model}`;
  }

  async judge(input: VisionInput): Promise<VisionLLMJudgement> {
    const dataUrl = await this.toDataUrl(input);
    const prompt = this.buildPrompt(input);

    // A vision model that hangs must not hang the caller (the bot's photo
    // handler awaits this). Bound the call and turn a timeout into a normal
    // throw, so VisionLLMProvider degrades it to needsHumanReview like any other
    // transport failure rather than blocking the submission forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`Vision-LLM HTTP 000: client timeout ${this.timeoutMs}ms`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body may echo request detail; keep it short and never include the key.
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Vision-LLM HTTP ${response.status}: ${detail}`);
    }

    const payload: any = await response.json();
    const content: string = payload?.choices?.[0]?.message?.content ?? '';
    return parseJudgement(content);
  }

  /** Bytes → data URL. Prefers the supplied buffer, else downloads the photo once. */
  private async toDataUrl(input: VisionInput): Promise<string> {
    let buffer = input.imageBuffer;
    let contentType = 'image/jpeg';
    if (!buffer) {
      const res = await fetch(input.photoUrl);
      if (!res.ok) throw new Error(`Could not fetch photo (HTTP ${res.status})`);
      contentType = res.headers.get('content-type') ?? contentType;
      buffer = Buffer.from(await res.arrayBuffer());
    }
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  /** The planogram, spelled out, plus the exact JSON shape we will parse back. */
  private buildPrompt(input: VisionInput): string {
    const requirements = aiVisionService.extractPlanogramRequirements(
      input.taskTitle,
      input.taskDescription,
      input.requirements,
    );
    const rules = requirements
      .map((r) => `- ${r.sku} (${r.label}): minimum ${r.minFacings} facing`)
      .join('\n');
    const skuList = COUNTED_SKUS.map((s) => `"${s}"`).join(', ');

    return (
      'You are auditing a retail cooler shelf photo against a Coca-Cola planogram.\n' +
      'Count the FACINGS (front-facing units) of each SKU you can see, and judge ' +
      'how well the shelf meets the planogram below.\n\n' +
      `PLANOGRAM:\n${rules}\n\n` +
      'Return ONLY a JSON object, no prose, with exactly these keys:\n' +
      '{\n' +
      '  "complianceScore": number (0-100, how well the shelf meets the planogram),\n' +
      '  "confidence": number (0-1, how sure YOU are of your own reading of this photo),\n' +
      `  "detectedCounts": object mapping any of [${skuList}] to integer counts,\n` +
      '  "missingItems": string[] (short human-readable shortfalls),\n' +
      '  "summary": string (one sentence, Azerbaijani preferred)\n' +
      '}\n' +
      'If the photo is too blurry, dark, or does not show a shelf, set confidence low.'
    );
  }
}

/** Strip code fences and parse the model's JSON into a normalized judgement. */
function parseJudgement(raw: string): VisionLLMJudgement {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Vision-LLM returned non-JSON: ${cleaned.slice(0, 200)}`);
  }

  const detectedCounts: Partial<Record<CocaColaSKU, number>> = {};
  const rawCounts = parsed?.detectedCounts ?? {};
  for (const sku of COUNTED_SKUS) {
    const n = Number(rawCounts[sku]);
    if (Number.isFinite(n) && n > 0) detectedCounts[sku] = Math.round(n);
  }

  return {
    complianceScore: Number(parsed?.complianceScore) || 0,
    confidence: Number(parsed?.confidence) || 0,
    detectedCounts,
    missingItems: Array.isArray(parsed?.missingItems) ? parsed.missingItems.map(String) : [],
    summary: typeof parsed?.summary === 'string' ? parsed.summary : '',
  };
}

/**
 * Build the LLM client from env, or return null when it is not fully configured.
 *
 * All three of URL, model and key are required: a half-configured client that
 * silently does nothing is worse than an absent one, because the hybrid would
 * escalate to it and get an error instead of a clean "no LLM" path.
 */
function buildLLMClientFromEnv(env: NodeJS.ProcessEnv): VisionLLMClient | null {
  const url = env.ONETEAM_VISION_LLM_URL;
  const model = env.ONETEAM_VISION_LLM_MODEL;
  const key = env.ONETEAM_VISION_LLM_KEY;
  if (!url || !model || !key) {
    // No generic endpoint configured: fall back to OpenRouter's own keys, which
    // carry their own client-side rate limit. Same provider, different transport.
    return openRouterClientFromEnv(env);
  }
  // Optional per-call ceiling (ms). Defaults to 20s: long enough for a slow
  // reasoning model, short enough that a hung call escalates to a human instead
  // of stalling the bot's photo handler. A non-positive/NaN value keeps 20s.
  const t = Number(env.ONETEAM_VISION_LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : 20000;
  return new HttpVisionLLMClient(url, key, model, env.ONETEAM_VISION_LLM_LABEL, timeoutMs);
}

function hybridThresholdsFromEnv(env: NodeJS.ProcessEnv): HybridThresholds | undefined {
  const floor = Number(env.ONETEAM_YOLO_CONFIDENCE_FLOOR);
  if (!Number.isFinite(floor) || floor <= 0 || floor > 1) return undefined;
  return { yoloConfidenceFloor: floor };
}

/**
 * The edge. Reads env, returns the chosen provider, or `null` for "no vision".
 *
 * `null` (the default) leaves production untouched: no engine runs and the
 * rule-based score in `autoApproveSubmission` stands. A misconfigured `vision-llm`
 * or `hybrid` (no reachable client) does not throw here — it degrades: `vision-llm`
 * with no client returns `null`, and `hybrid` runs YOLO-only and escalates
 * unresolved cases to a human.
 */
export function resolveVisionProvider(env: NodeJS.ProcessEnv = process.env): VisionProvider | null {
  const kind = (env.ONETEAM_VISION_PROVIDER ?? 'off').toLowerCase() as VisionProviderKind;

  switch (kind) {
    case 'off':
      return null;
    case 'simulation':
      return new SimulationVisionProvider();
    case 'yolo':
      return new YoloVisionProvider(env.ONETEAM_YOLO_WORKER_URL);
    case 'vision-llm': {
      const client = buildLLMClientFromEnv(env);
      return client ? new VisionLLMProvider(client) : null;
    }
    case 'hybrid': {
      const client = buildLLMClientFromEnv(env);
      const llm = client ? new VisionLLMProvider(client) : null;
      return new HybridVisionProvider(
        new YoloVisionProvider(env.ONETEAM_YOLO_WORKER_URL),
        llm,
        hybridThresholdsFromEnv(env),
      );
    }
    default:
      // An unknown value is a configuration mistake, not a silent "off": say so
      // and fail safe to no vision rather than guessing an engine.
      console.warn(
        `⚠️ [oneTeam vision] Unknown ONETEAM_VISION_PROVIDER="${kind}"; vision disabled.`,
      );
      return null;
  }
}

export { SimulationVisionProvider, YoloVisionProvider, VisionLLMProvider, HybridVisionProvider };
export { combineHybrid, DEFAULT_YOLO_CONFIDENCE_FLOOR } from './hybridProvider';
export type { VisionAnalysis, VisionInput, VisionProvider, VisionLLMClient } from './types';
export { SKU_METADATA };
export {
  OpenRouterClient,
  TokenBucket,
  defaultBucket,
  openRouterClientFromEnv,
  OPENROUTER_ENDPOINT,
} from './openrouterClient';
export type { OpenRouterClientOptions, TokenBucketOptions } from './openrouterClient';
// 4.2 — the validated verdict the model must answer with.
export {
  ShelfVerdictSchema,
  MissingSkuSchema,
  ExtraItemSchema,
  AnomalySchema,
  parseVerdict,
  assessVerdict,
  buildVerdictPrompt,
  MIN_REVIEW_CONFIDENCE,
} from './verdict';
export type {
  ShelfVerdict,
  MissingSku,
  VerdictResult,
  VerdictFailureReason,
  VerdictTriage,
} from './verdict';
// 4.3 — the pre-filter crop decision.
export { computeRoi, roiNoteFor } from './roi';
export type { RoiDecision, RoiOptions, RoiRefusal } from './roi';
