/**
 * Simulation fixtures and generic YOLO object detection.
 * ============================================================================
 *
 * Explicit `mockScenario` inputs use hardcoded fixtures. Production inputs run
 * the YOLO worker; stock COCO weights can locate bottles but cannot identify
 * Coca-Cola SKUs or grade a planogram. A generic bottle must not be scored as
 * a branded product.
 *
 * It was wired into the bot's submission path until recently, which meant every
 * merchandiser saw a confident-looking "AI Uyğunluq Balı" that had been produced
 * from a file name. Because the bot generated its own names
 * (`audits/<store>/<task>_<timestamp>.jpg`), none of the keywords ever matched,
 * so every photo scored the same flattering result.
 *
 * Simulation is kept for explicit development scenarios only. Never use its
 * scores as evidence for production approval.
 */

import { clock } from '@oneteam/types';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export type CocaColaSKU =
  'coca_cola_classic' | 'coca_cola_zero' | 'fanta' | 'sprite' | 'out_of_stock_gap';

export interface BoundingBox {
  /** X coordinate percentage from left (0 - 100) */
  x: number;
  /** Y coordinate percentage from top (0 - 100) */
  y: number;
  /** Width percentage (0 - 100) */
  width: number;
  /** Height percentage (0 - 100) */
  height: number;
}

export interface DetectionItem {
  id: string;
  sku: CocaColaSKU | 'unverified_bottle';
  label: string;
  confidence: number;
  box: BoundingBox;
  color: string;
  shelfRow: number;
  facingIndex: number;
  /** COCO object class, not a product brand. Required for trusted YOLO boxes. */
  objectClass?: string;
}

/**
 * Why a worker run produced no detections.
 *
 * The previous signature returned `DetectionItem[] | null`, which collapsed
 * seven distinct conditions — no virtualenv, no worker script, a spawn error, a
 * wall-clock timeout, a non-zero exit, unparseable output, and a successful run
 * that simply found nothing — into a single `null`. No caller could tell
 * "this machine has not built the Python environment" apart from "the model
 * looked and found no bottles", so the test that consumed it could only report
 * `null` and the reason was lost at the boundary.
 */
export type YoloRunFailure = 'worker-unavailable' | 'timeout' | 'worker-failed' | 'no-detections';

export type YoloRunOutcome =
  | {
      ok: true;
      detections: DetectionItem[];
      /**
       * Legacy worker compatibility. The current worker never draws boxes.
       */
      synthetic: boolean;
    }
  | { ok: false; reason: YoloRunFailure; detail: string };

export interface YoloRunOptions {
  /** Wall-clock cap for the worker process. See `DEFAULT_YOLO_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Wall-clock guard against a hung worker — not a performance budget.
 *
 * A cold start measured **47s** on this machine against **3.3s** once the page
 * cache was warm (torch and OpenCV shared libraries, plus the 6.5MB model).
 * The cap used to be 60s, so an idle machine had roughly a 25% margin and a
 * loaded one had none: the child was killed, `spawnSync` reported
 * `status: null` with `error.code === 'ETIMEDOUT'`, and the caller read that as
 * an empty shelf. Widened so that a cold start on a busy machine is not
 * mistaken for a model that found nothing.
 */
export const DEFAULT_YOLO_TIMEOUT_MS = 180_000;

/**
 * Which engine produced a set of detections.
 *
 * Carried on the evaluation because a result that came from the simulation must
 * not be indistinguishable from one that came from the detector.
 *
 * `vision-llm` and `hybrid` are produced by the provider seam in `./vision`, not
 * by this file: `vision-llm` is a vision model's own judgement, and `hybrid` is
 * the YOLO-then-LLM orchestrator's verdict. They live in this union so that a
 * `VisionAnalysis.engine` can never be a value the record's audit trail cannot
 * name — the whole point of carrying the engine is that no layer masquerades as
 * another.
 */
export type AnalysisEngine = 'ultralytics-yolo' | 'simulation' | 'vision-llm' | 'hybrid';

export interface PlanogramRequirement {
  sku: CocaColaSKU;
  label: string;
  minFacings: number;
}

export interface SKUComplianceItem {
  sku: CocaColaSKU;
  label: string;
  required: number;
  detected: number;
  isMet: boolean;
  matchPercentage: number;
}

export interface PlanogramComplianceEvaluation {
  complianceScore: number; // 0 - 100
  autoStatus: 'approved' | 'needs_manual_review';
  detectedCounts: Record<CocaColaSKU, number>;
  skuBreakdown: SKUComplianceItem[];
  outOfStockGaps: number;
  penaltiesApplied: number;
  missingItems: string[];
  aiSummary: string;
  detections: DetectionItem[];
  /**
   * Which engine produced `detections`. Added because the fallback used to be
   * invisible: a caller could request the real detector, silently receive the
   * simulation, and have no way to notice.
   */
  engine: AnalysisEngine;
  analyzedAt: string;
}

export interface AnalysisInput {
  photoUrl: string;
  imageBuffer?: Buffer;
  taskTitle?: string;
  taskDescription?: string;
  customRequirements?: PlanogramRequirement[];
  mockScenario?: 'compliant' | 'minor_gap' | 'missing_sku' | 'severe_issues';
  useUltralytics?: boolean;
}

export const SKU_METADATA: Record<
  CocaColaSKU,
  { label: string; color: string; defaultMin: number }
> = {
  coca_cola_classic: {
    label: 'Coca-Cola Classic 0.5L',
    color: '#F40009', // Coke Red
    defaultMin: 3,
  },
  coca_cola_zero: {
    label: 'Coca-Cola Zero Sugar 0.5L',
    color: '#111827', // Slate Dark / Black
    defaultMin: 2,
  },
  fanta: {
    label: 'Fanta Orange 0.5L',
    color: '#FF7300', // Vibrant Fanta Orange
    defaultMin: 2,
  },
  sprite: {
    label: 'Sprite 0.5L',
    color: '#008B47', // Sprite Green
    defaultMin: 2,
  },
  out_of_stock_gap: {
    label: 'Boşluq (Out of Stock)',
    color: '#EF4444', // Warning Red
    defaultMin: 0,
  },
};

/**
 * The shape `spawnSync` returns once `encoding` is set, narrowed so that
 * `stdout` and `stderr` are strings.
 *
 * Written out because `ReturnType<typeof spawnSync>` resolves to the overload
 * whose streams are `Buffer`s, which loses the narrowing that an inline call
 * gets for free from the `encoding: 'utf-8'` option.
 */
interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

/**
 * The one branch both worker transports must agree on: a payload that carries a
 * `detections` array either found boxes or did not, and the difference decides
 * whether a shelf is empty or the detector never looked.
 *
 * Returns null for anything that is not that payload, so a caller reading a
 * stream of stdout lines (the `spawnSync` path prints ultralytics noise around
 * the worker's line) can keep scanning instead of treating noise as an answer.
 */
function outcomeFromDetectionPayload(parsed: unknown): YoloRunOutcome | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed as { detections?: unknown; synthetic_fallback?: unknown };

  if (!Array.isArray(payload.detections)) return null;
  if (payload.detections.length === 0) {
    return {
      ok: false,
      reason: 'no-detections',
      detail: 'The worker ran and returned an empty detection list.',
    };
  }

  return {
    ok: true,
    detections: payload.detections as DetectionItem[],
    synthetic: payload.synthetic_fallback === true,
  };
}

/** Validated ONETEAM_YOLO_CONF (0 exclusive .. 1 inclusive), or undefined
 *  when unset/invalid — an absent knob must keep the worker's own default. */
function envConf(): number | undefined {
  const conf = Number(process.env.ONETEAM_YOLO_CONF);
  return Number.isFinite(conf) && conf > 0 && conf <= 1 ? conf : undefined;
}

/** CLI argv for the spawned worker. The model is the worker's to own:
 *  ONETEAM_YOLO_MODEL is the same knob the deployed worker's /health reads, so
 *  both transports can never run different detectors. */
export function yoloCliArgs(scriptPath: string, imageSource: string): string[] {
  const model = process.env.ONETEAM_YOLO_MODEL || 'yolo11n.pt';
  const conf = envConf();
  return [
    scriptPath,
    '--image',
    imageSource,
    '--model',
    model,
    ...(conf !== undefined ? ['--conf', String(conf)] : []),
  ];
}

export class AIVisionService {
  /**
   * Parse planogram requirements from task text or return standard Coca-Cola cooler rules.
   */
  public extractPlanogramRequirements(
    title = '',
    description = '',
    custom?: PlanogramRequirement[],
  ): PlanogramRequirement[] {
    if (custom && custom.length > 0) {
      return custom;
    }

    const text = `${title} ${description}`.toLowerCase();

    // If task is specifically Zero Sugar focused
    if (text.includes('zero') && !text.includes('classic')) {
      return [
        { sku: 'coca_cola_zero', label: SKU_METADATA.coca_cola_zero.label, minFacings: 4 },
        { sku: 'coca_cola_classic', label: SKU_METADATA.coca_cola_classic.label, minFacings: 2 },
      ];
    }

    // If task is Fanta & Sprite focused
    if ((text.includes('fanta') || text.includes('sprite')) && !text.includes('classic')) {
      return [
        { sku: 'fanta', label: SKU_METADATA.fanta.label, minFacings: 3 },
        { sku: 'sprite', label: SKU_METADATA.sprite.label, minFacings: 3 },
      ];
    }

    // Default Full Cooler Planogram Rule
    return [
      { sku: 'coca_cola_classic', label: SKU_METADATA.coca_cola_classic.label, minFacings: 3 },
      { sku: 'coca_cola_zero', label: SKU_METADATA.coca_cola_zero.label, minFacings: 2 },
      { sku: 'fanta', label: SKU_METADATA.fanta.label, minFacings: 2 },
      { sku: 'sprite', label: SKU_METADATA.sprite.label, minFacings: 2 },
    ];
  }

  /**
   * Run official Ultralytics YOLO inference via the local Python worker, and
   * report *why* it produced nothing when it does.
   *
   * The worker is a separate process with its own interpreter, a model file and
   * a cold start, so "it looked and found no bottles" and "it never ran" are
   * different answers that call for different responses. That is why this
   * returns an outcome rather than a bare list: the previous `DetectionItem[] |
   * null` collapsed seven distinct conditions into one value, and a killed
   * worker became indistinguishable from an empty shelf.
   */
  public runUltralyticsInferenceDetailed(
    imageSource: string | Buffer,
    options: YoloRunOptions = {},
  ): YoloRunOutcome {
    // A Buffer is the bot's decoded Telegram bytes. The worker understands a
    // data: URL (it decodes the base64 itself), so the same string that the
    // HTTP path sends works here too — keep both transports on one payload.
    const source =
      typeof imageSource === 'string'
        ? imageSource
        : `data:image/jpeg;base64,${imageSource.toString('base64')}`;
    const venvPython = path.resolve(process.cwd(), '.venv/bin/python');
    const scriptPath = path.resolve(process.cwd(), 'scripts/yolo_inference.py');

    if (!fs.existsSync(venvPython)) {
      return {
        ok: false,
        reason: 'worker-unavailable',
        detail:
          `No Python environment at ${venvPython}, so the worker cannot run. ` +
          'Build it with: python3.12 -m venv .venv && ' +
          '.venv/bin/pip install ultralytics opencv-python numpy',
      };
    }

    if (!fs.existsSync(scriptPath)) {
      return {
        ok: false,
        reason: 'worker-unavailable',
        detail: `No worker script at ${scriptPath}.`,
      };
    }

    const configDir = path.resolve(process.cwd(), '.yolo_config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const timeoutMs =
      options.timeoutMs ?? (Number(process.env.ONETEAM_YOLO_TIMEOUT_MS) || DEFAULT_YOLO_TIMEOUT_MS);

    let res: SpawnResult;
    try {
      res = spawnSync(venvPython, yoloCliArgs(scriptPath, source), {
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          YOLO_CONFIG_DIR: configDir,
          ULTRALYTICS_CONFIG_DIR: configDir,
          YOLO_VERBOSE: 'False',
        },
      });
    } catch (err) {
      return {
        ok: false,
        reason: 'worker-failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // Checked before `status`, because a timeout is the one failure that leaves
    // no trace in the worker's own output: `spawnSync` kills the child and
    // reports `status: null` with `error.code === 'ETIMEDOUT'`. Reading that as
    // "found nothing" is precisely how a cold start came to look like an empty
    // shelf.
    if (res.error && res.error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        reason: 'timeout',
        detail:
          `The worker was still running after ${timeoutMs}ms and was killed ` +
          `(signal ${res.signal ?? 'none'}). A cold start measured 47s; raise ` +
          'ONETEAM_YOLO_TIMEOUT_MS if this machine is slower.',
      };
    }

    if (res.error) {
      return {
        ok: false,
        reason: 'worker-failed',
        detail: `Could not run the worker: ${res.error.message}`,
      };
    }

    if (res.status !== 0) {
      const stderr = (res.stderr ?? '').trim().slice(0, 500);
      return {
        ok: false,
        reason: 'worker-failed',
        detail:
          `The worker exited with status ${res.status ?? 'null'}` +
          (res.signal ? ` (signal ${res.signal})` : '') +
          (stderr ? `: ${stderr}` : '.'),
      };
    }

    // The worker prints one JSON line, but ultralytics can print its own output
    // around it, so scan from the end for the last line that parses.
    const lines = (res.stdout ?? '').trim().split('\n');
    let reportedError: string | null = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = lines[i].trim();
      if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(candidate) as Record<string, unknown>;
      } catch {
        continue; // not the worker's line; keep looking
      }

      if (parsed.success === false) {
        reportedError =
          typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed).slice(0, 500);
        continue;
      }

      const fromPayload = outcomeFromDetectionPayload(parsed);
      if (fromPayload) return fromPayload;
    }

    if (reportedError) {
      return { ok: false, reason: 'worker-failed', detail: reportedError };
    }

    return {
      ok: false,
      reason: 'worker-failed',
      detail:
        'The worker produced no parsable result. stdout: ' +
        ((res.stdout ?? '').trim().slice(0, 500) || '(empty)'),
    };
  }

  /**
   * Same worker, same JSON contract, but over HTTP to a process that is already
   * running.
   *
   * WHY A SECOND TRANSPORT EXISTS
   * -----------------------------
   * The `spawnSync` path above starts a Python interpreter, imports torch and
   * OpenCV and loads a 6.5MB model on every single call — measured at **47s**
   * cold and 3.3s warm — and it does so on the caller's thread: `spawnSync`
   * blocks the event loop for the whole run. In the bot that meant a shelf photo
   * could stall the Telegram handler for the better part of a minute.
   *
   * A long-lived worker pays that cost once at boot. The caller then spends one
   * HTTP round-trip, which is what the timeout below is actually guarding — the
   * `spawnSync` cap had to be 180s to survive a cold start, which is no longer a
   * meaningful guard for a request that should take milliseconds once warm.
   *
   * Failure shapes match the local path deliberately, so `YoloVisionProvider`
   * and the hybrid's confidence rules read either transport identically: an
   * unreachable worker is `worker-unavailable` (the hybrid then escalates to the
   * LLM), a worker that answered with its own error is `worker-failed`, and an
   * empty detection list is `no-detections` — never `ok`, because "the model
   * looked and found nothing" and "the model was never asked" are different
   * answers.
   */
  public async runUltralyticsInferenceRemote(
    imageSource: string | Buffer,
    options: { workerUrl: string; timeoutMs?: number },
  ): Promise<YoloRunOutcome> {
    const base = options.workerUrl.replace(/\/+$/, '');
    const timeoutMs =
      options.timeoutMs ??
      (Number(process.env.ONETEAM_YOLO_WORKER_TIMEOUT_MS) || DEFAULT_YOLO_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${base}/detect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image:
            typeof imageSource === 'string'
              ? imageSource
              : `data:image/jpeg;base64,${imageSource.toString('base64')}`,
          ...(envConf() !== undefined ? { conf: envConf() } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return {
          ok: false,
          reason: 'timeout',
          detail: `The vision worker at ${base} did not answer within ${timeoutMs}ms.`,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: 'worker-unavailable',
        detail: `The vision worker at ${base} could not be reached: ${message}`,
      };
    }

    if (!response.ok) {
      const body = (await response.text()).trim().slice(0, 300);
      return {
        ok: false,
        reason: 'worker-failed',
        detail: `The vision worker at ${base} answered HTTP ${response.status}: ${body || '(empty body)'}`,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return {
        ok: false,
        reason: 'worker-failed',
        detail: `The vision worker at ${base} answered with something that is not JSON.`,
      };
    }

    const reported = payload as { success?: unknown; error?: unknown };
    if (reported.success === false) {
      return {
        ok: false,
        reason: 'worker-failed',
        detail:
          typeof reported.error === 'string'
            ? reported.error
            : JSON.stringify(payload).slice(0, 500),
      };
    }

    const outcome = outcomeFromDetectionPayload(payload);
    if (outcome) return outcome;

    return {
      ok: false,
      reason: 'worker-failed',
      detail:
        `The vision worker at ${base} returned no recognisable payload: ` +
        JSON.stringify(payload).slice(0, 300),
    };
  }

  /**
   * Run Computer Vision inference on shelf photo.
   * Generates realistic YOLO-style bounding boxes with confidence scores.
   */
  public detectShelfProducts(input: AnalysisInput): {
    detections: DetectionItem[];
    engine: AnalysisEngine;
  } {
    // 1. Try real Ultralytics YOLO if explicitly requested or if no mockScenario override
    if (input.useUltralytics || (!input.mockScenario && input.photoUrl)) {
      const outcome = this.runUltralyticsInferenceDetailed(input.photoUrl);
      if (outcome.ok) {
        return { detections: outcome.detections, engine: 'ultralytics-yolo' };
      }

      // A real-detector failure must never turn into plausible demo boxes.
      console.warn(
        `⚠️ [oneTeam vision] Ultralytics worker unavailable (${outcome.reason}): ${outcome.detail}`,
      );
      return { detections: [], engine: 'ultralytics-yolo' };
    }

    if (!input.mockScenario) return { detections: [], engine: 'ultralytics-yolo' };

    // 2. Explicit demo scenario only — never a production fallback.
    const detections: DetectionItem[] = [];
    const scenario = input.mockScenario || this.inferScenario(input);

    let idCounter = 1;
    const addDetection = (
      sku: CocaColaSKU,
      x: number,
      y: number,
      width: number,
      height: number,
      confidence: number,
      shelfRow: number,
      facingIndex: number,
    ) => {
      detections.push({
        id: `det-${idCounter++}`,
        sku,
        label: SKU_METADATA[sku].label,
        confidence: Number(confidence.toFixed(2)),
        box: {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
        },
        color: SKU_METADATA[sku].color,
        shelfRow,
        facingIndex,
      });
    };

    // Layout configuration across 2 shelf rows
    // Row 1: Eye-level (Y: ~18% to ~48%)
    // Row 2: Lower shelf (Y: ~52% to ~82%)

    if (scenario === 'compliant') {
      // Shelf Row 1: 3x Classic, 2x Zero
      addDetection('coca_cola_classic', 8, 18, 14, 30, 0.96, 1, 1);
      addDetection('coca_cola_classic', 24, 18, 14, 30, 0.94, 1, 2);
      addDetection('coca_cola_classic', 40, 18, 14, 30, 0.97, 1, 3);
      addDetection('coca_cola_zero', 58, 18, 14, 30, 0.93, 1, 4);
      addDetection('coca_cola_zero', 74, 18, 14, 30, 0.95, 1, 5);

      // Shelf Row 2: 2x Fanta, 2x Sprite, 1x Classic
      addDetection('fanta', 8, 54, 15, 30, 0.92, 2, 1);
      addDetection('fanta', 25, 54, 15, 30, 0.91, 2, 2);
      addDetection('sprite', 44, 54, 15, 30, 0.95, 2, 3);
      addDetection('sprite', 61, 54, 15, 30, 0.94, 2, 4);
      addDetection('coca_cola_classic', 78, 54, 15, 30, 0.89, 2, 5);
    } else if (scenario === 'minor_gap') {
      // Row 1: 3x Classic, 1x Zero, 1x GAP
      addDetection('coca_cola_classic', 8, 18, 14, 30, 0.95, 1, 1);
      addDetection('coca_cola_classic', 24, 18, 14, 30, 0.93, 1, 2);
      addDetection('coca_cola_classic', 40, 18, 14, 30, 0.96, 1, 3);
      addDetection('coca_cola_zero', 58, 18, 14, 30, 0.91, 1, 4);
      addDetection('out_of_stock_gap', 74, 18, 14, 30, 0.88, 1, 5); // 1 gap

      // Row 2: 2x Fanta, 2x Sprite
      addDetection('fanta', 10, 54, 16, 30, 0.94, 2, 1);
      addDetection('fanta', 28, 54, 16, 30, 0.92, 2, 2);
      addDetection('sprite', 48, 54, 16, 30, 0.9, 2, 3);
      addDetection('sprite', 66, 54, 16, 30, 0.93, 2, 4);
    } else if (scenario === 'missing_sku') {
      // Missing Fanta facings and 1 gap
      addDetection('coca_cola_classic', 8, 18, 15, 30, 0.95, 1, 1);
      addDetection('coca_cola_classic', 25, 18, 15, 30, 0.92, 1, 2);
      addDetection('coca_cola_zero', 43, 18, 15, 30, 0.91, 1, 3);
      addDetection('out_of_stock_gap', 62, 18, 15, 30, 0.87, 1, 4); // gap

      // Row 2: 1x Fanta (missing 1), 2x Sprite
      addDetection('fanta', 12, 54, 16, 30, 0.89, 2, 1);
      addDetection('sprite', 35, 54, 16, 30, 0.91, 2, 2);
      addDetection('sprite', 55, 54, 16, 30, 0.93, 2, 3);
      addDetection('out_of_stock_gap', 75, 54, 16, 30, 0.85, 2, 4); // second gap
    } else {
      // Severe issues: multiple gaps, low facings
      addDetection('coca_cola_classic', 10, 18, 16, 30, 0.92, 1, 1);
      addDetection('out_of_stock_gap', 32, 18, 18, 30, 0.89, 1, 2);
      addDetection('out_of_stock_gap', 55, 18, 18, 30, 0.91, 1, 3);
      addDetection('coca_cola_zero', 76, 18, 16, 30, 0.86, 1, 4);

      addDetection('fanta', 15, 54, 16, 30, 0.88, 2, 1);
      addDetection('out_of_stock_gap', 40, 54, 20, 30, 0.93, 2, 2);
      addDetection('sprite', 68, 54, 16, 30, 0.87, 2, 3);
    }

    return { detections, engine: 'simulation' };
  }

  /**
   * Evaluate compliance of detected products against Planogram requirements.
   */
  public evaluateCompliance(
    detections: DetectionItem[],
    requirements: PlanogramRequirement[],
    engine: AnalysisEngine = 'simulation',
  ): PlanogramComplianceEvaluation {
    const counts: Record<CocaColaSKU, number> = {
      coca_cola_classic: 0,
      coca_cola_zero: 0,
      fanta: 0,
      sprite: 0,
      out_of_stock_gap: 0,
    };

    detections.forEach((d) => {
      if (d.sku === 'unverified_bottle') return;
      counts[d.sku] = (counts[d.sku] || 0) + 1;
    });

    const skuBreakdown: SKUComplianceItem[] = requirements.map((req) => {
      const detected = counts[req.sku] || 0;
      const matchPercentage = Math.min(100, Math.round((detected / req.minFacings) * 100));
      return {
        sku: req.sku,
        label: req.label,
        required: req.minFacings,
        detected,
        isMet: detected >= req.minFacings,
        matchPercentage,
      };
    });

    // 1. Calculate Base SKU Fulfillment Score (average of match percentages)
    const totalRequiredSKUs = skuBreakdown.length || 1;
    const sumFulfillment = skuBreakdown.reduce((acc, item) => acc + item.matchPercentage, 0);
    const baseScore = sumFulfillment / totalRequiredSKUs;

    // 2. Out-of-stock Gap Penalty (-15% per gap detected)
    const outOfStockGaps = counts.out_of_stock_gap || 0;
    const penaltyPerGap = 15;
    const penaltiesApplied = outOfStockGaps * penaltyPerGap;

    // 3. Final Compliance Score (Bounded between 0 and 100)
    const complianceScore = Math.max(0, Math.min(100, Math.round(baseScore - penaltiesApplied)));

    // 4. Automated Verdict
    // Score >= 80% is Auto-Approved, otherwise needs manual supervisor review
    const autoStatus: 'approved' | 'needs_manual_review' =
      complianceScore >= 80 ? 'approved' : 'needs_manual_review';

    // 5. Generate Missing Items & Azerbaijani Summary
    const missingItems: string[] = [];
    skuBreakdown.forEach((item) => {
      if (!item.isMet) {
        const diff = item.required - item.detected;
        missingItems.push(
          `${item.label} çatışmır: ${item.detected}/${item.required} facing (çatışmayan: ${diff})`,
        );
      }
    });

    if (outOfStockGaps > 0) {
      missingItems.push(
        `Rəfdə ${outOfStockGaps} ədəd boşluq (out of stock) aşkarlandı (-${penaltiesApplied}% cərimə)`,
      );
    }

    // Build Azerbaijani summary string
    let aiSummary: string;
    if (autoStatus === 'approved') {
      aiSummary =
        `✅ Planogram Uyğunluğu: ${complianceScore}%. ` +
        `Rəf düzülüşü standartlara tam cavab verir. Aşkarlandı: ` +
        `${counts.coca_cola_classic}x Classic, ${counts.coca_cola_zero}x Zero, ` +
        `${counts.fanta}x Fanta, ${counts.sprite}x Sprite.` +
        (outOfStockGaps > 0
          ? ` Xəbərdarlıq: ${outOfStockGaps} boşluq qeydə alındı.`
          : ' Boşluq yoxdur.');
    } else {
      aiSummary =
        `⚠️ Planogram Uyğunluğu: ${complianceScore}% (Supervayzer yoxlaması tələb olunur). ` +
        `Səbəb: ${missingItems.slice(0, 2).join('; ')}. ` +
        `Aşkarlandı: ${counts.coca_cola_classic}x Classic, ${counts.coca_cola_zero}x Zero, ` +
        `${counts.fanta}x Fanta, ${counts.sprite}x Sprite, ${outOfStockGaps}x boşluq.`;
    }

    return {
      complianceScore,
      autoStatus,
      detectedCounts: counts,
      skuBreakdown,
      outOfStockGaps,
      penaltiesApplied,
      missingItems,
      aiSummary,
      detections,
      engine,
      analyzedAt: clock.now().toISOString(),
    };
  }

  /**
   * Main entrypoint: analyze photo and return complete evaluation.
   */
  public analyzeShelfPhoto(input: AnalysisInput): PlanogramComplianceEvaluation {
    const requirements = this.extractPlanogramRequirements(
      input.taskTitle,
      input.taskDescription,
      input.customRequirements,
    );
    const { detections, engine } = this.detectShelfProducts(input);
    return this.evaluateCompliance(detections, requirements, engine);
  }

  /**
   * Helper to infer scenario based on photo URL or text hints
   */
  private inferScenario(
    input: AnalysisInput,
  ): 'compliant' | 'minor_gap' | 'missing_sku' | 'severe_issues' {
    const text = `${input.photoUrl} ${input.taskTitle || ''}`.toLowerCase();
    if (text.includes('reject') || text.includes('poor') || text.includes('empty')) {
      return 'severe_issues';
    }
    if (text.includes('gap') || text.includes('warning') || text.includes('sub-002')) {
      return 'minor_gap';
    }
    if (text.includes('sub-004') || text.includes('missing')) {
      return 'missing_sku';
    }
    return 'compliant';
  }
}

export const aiVisionService = new AIVisionService();
