/**
 * oneTeam — OpenRouter transport for the vision-LLM seam
 * ============================================================================
 *
 * The provider (`llmProvider.ts`) judges a shelf photo from a `VisionLLMClient`
 * and knows nothing about HTTP. This file is that client for OpenRouter, and it
 * owns the two things a shared cloud key needs and a single call does not:
 *
 *   1. A CLIENT-SIDE rate limit. OpenRouter enforces 20 req/min and 1000
 *      req/day on a key. A burst of shelf photos (a supervisor bulk-dispatching,
 *      or a mobile queue draining after a tunnel) would otherwise be answered
 *      with 429s, and each 429 wastes a paid round trip. `TokenBucket` spends
 *      the quota locally and queues instead. Its clock and sleep are injected,
 *      so the limiter is tested without waiting a minute.
 *
 *   2. HONEST 429 HANDLING. A 429 is the one failure this client retries — the
 *      key is fine, the quota was momentarily full. It waits for `Retry-After`
 *      (capped) and re-issues. Everything else — 4xx, 5xx, a timeout — throws on
 *      the first attempt, because `VisionLLMProvider` turns a throw into
 *      `needsHumanReview`, and retrying a 401 or a 402 would turn a config error
 *      into minutes of silence before the same verdict.
 *
 * The API key is read only from the constructor, is never logged, and never
 * appears in a thrown message: the upstream error body is truncated to 300 chars
 * and the auth header is not echoed.
 */
import type { VisionInput, VisionLLMClient, VisionLLMJudgement } from './types';
import type { CocaColaSKU } from '../aiVision';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const COUNTED_SKUS: CocaColaSKU[] = [
  'coca_cola_classic',
  'coca_cola_zero',
  'fanta',
  'sprite',
  'out_of_stock_gap',
];

export interface TokenBucketOptions {
  /** Burst size. Refills `capacity` tokens per `refillIntervalMs`. */
  capacity: number;
  refillIntervalMs: number;
  /** Injected clock + sleep so tests do not wait in real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A token bucket that never throws on exhaustion — it waits.
 *
 * Taking a token when the bucket is empty waits until enough tokens exist, so N
 * concurrent callers each wait their own turn and all eventually proceed.
 * `maxWaitMs` bounds that wait: a caller would rather see a `RateLimitTimeout`
 * (which escalates to a human) than sit in a queue forever.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TokenBucketOptions) {
    this.tokens = options.capacity;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lastRefill = this.now();
  }

  /** Wait until one token is available, then consume it. */
  async take(maxWaitMs = 60_000): Promise<void> {
    const { capacity, refillIntervalMs } = this.options;
    const perTokenMs = refillIntervalMs / capacity;
    let waited = 0;
    for (;;) {
      const t = this.now();
      this.refill(t);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(perTokenMs - (t - this.lastRefill)));
      if (waited + waitMs > maxWaitMs) {
        throw new Error(`OpenRouter rate limit: no token within ${maxWaitMs}ms`);
      }
      waited += waitMs;
      await this.sleep(waitMs);
    }
  }

  private refill(t: number): void {
    const { capacity, refillIntervalMs } = this.options;
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = (elapsed / refillIntervalMs) * capacity;

    if (gained <= 0) return;
    this.tokens = Math.min(capacity, this.tokens + gained);
    this.lastRefill = t;
  }
}

/** Default key budget: OpenRouter's own per-minute limit, refilled continuously. */
export function defaultBucket(
  now?: () => number,
  sleep?: (ms: number) => Promise<void>,
): TokenBucket {
  return new TokenBucket({ capacity: 20, refillIntervalMs: 60_000, now, sleep });
}

export interface OpenRouterClientOptions {
  apiKey: string;
  model: string;
  endpoint?: string;
  /** `HTTP-Referer` — OpenRouter uses it for dashboard attribution. */
  referer?: string;
  /** `X-Title` — the app name shown next to the request. */
  title?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Longest single 429 wait, regardless of what `Retry-After` claims. */
  maxRetryAfterMs?: number;
  bucket?: TokenBucket;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class OpenRouterClient implements VisionLLMClient {
  readonly label: string;
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly bucket: TokenBucket | null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OpenRouterClientOptions) {
    if (!options.apiKey) throw new Error('OpenRouterClient requires an apiKey');
    if (!options.model) throw new Error('OpenRouterClient requires a model');
    this.endpoint = options.endpoint ?? OPENROUTER_ENDPOINT;
    this.model = options.model;
    this.label = `openrouter:${options.model}`;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.bucket = options.bucket ?? defaultBucket(options.now, this.sleep);
  }

  async judge(input: VisionInput): Promise<VisionLLMJudgement> {
    const dataUrl = await this.toDataUrl(input);
    const body = JSON.stringify({
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(input) },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    let attempt = 0;
    for (;;) {
      await this.bucket?.take();
      const response = await this.post(body);
      // 429 is the only retried status: the quota was full, not the request wrong.
      if (response.status !== 429 || attempt >= this.maxRetries) {
        return this.readJudgement(response);
      }
      const waitMs = Math.min(this.retryAfterMs(response), this.maxRetryAfterMs);
      attempt += 1;
      await this.sleep(waitMs);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    if (this.options.referer) headers['HTTP-Referer'] = this.options.referer;
    if (this.options.title) headers['X-Title'] = this.options.title;
    return headers;
  }

  /** One HTTP attempt, bounded by the timeout so a hang cannot block the caller. */
  private async post(body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`OpenRouter HTTP 000: client timeout ${this.timeoutMs}ms`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turn the response into a judgement, or throw. */
  private async readJudgement(response: Response): Promise<VisionLLMJudgement> {
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`OpenRouter HTTP ${response.status}: ${detail}`);
    }
    const payload = (await response.json()) as any;
    const content: string = payload?.choices?.[0]?.message?.content ?? '';
    return parseJudgement(content);
  }

  /** Seconds from `Retry-After`, else exponential backoff. Never above the cap. */
  private retryAfterMs(response: Response): number {
    const header = response.headers?.get?.('retry-after');
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return Math.min(this.maxRetryAfterMs, 1000 * 2 ** this.maxRetries);
  }

  private async toDataUrl(input: VisionInput): Promise<string> {
    let buffer = input.imageBuffer;
    let contentType = 'image/jpeg';
    if (!buffer) {
      const res = await this.fetchImpl(input.photoUrl);
      if (!res.ok) throw new Error(`Could not fetch photo (HTTP ${res.status})`);
      contentType = res.headers.get('content-type') ?? contentType;
      buffer = Buffer.from(await res.arrayBuffer());
    }
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }
}

/** Strip code fences and normalize the model's JSON into a judgement. */
export function parseJudgement(raw: string): VisionLLMJudgement {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`OpenRouter returned non-JSON: ${cleaned.slice(0, 200)}`);
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

/** The planogram spelled out, plus the exact JSON shape parsed back above. */
export function buildPrompt(input: VisionInput): string {
  const requirements = input.requirements ?? [];
  const rules = requirements
    .map((r) => `- ${r.sku} (${r.label}): minimum ${r.minFacings} facing`)
    .join('\n');
  const skuList = COUNTED_SKUS.map((s) => `"${s}"`).join(', ');
  return (
    'You are auditing a retail cooler shelf photo against a Coca-Cola planogram.\n' +
    'Count the FACINGS (front-facing units) of each SKU you can see, and judge ' +
    'how well the shelf meets the planogram below.\n\n' +
    `PLANOGRAM:\n${rules || '(none supplied — judge general shelf tidiness)'}\n\n` +
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

/**
 * Build the client from env, or `null` when it is not fully configured.
 *
 * `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` are both required: a half-configured
 * client that silently does nothing is worse than an absent one, because the
 * hybrid would escalate to it and get an error instead of a clean "no LLM" path.
 */
export function openRouterClientFromEnv(env: NodeJS.ProcessEnv): OpenRouterClient | null {
  const key = env.OPENROUTER_API_KEY;
  const model = env.OPENROUTER_MODEL;
  if (!key || !model) return null;
  const timeout = Number(env.OPENROUTER_TIMEOUT_MS);
  return new OpenRouterClient({
    apiKey: key,
    model,
    referer: env.OPENROUTER_REFERER,
    title: env.OPENROUTER_TITLE ?? 'oneTeam',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
  });
}
