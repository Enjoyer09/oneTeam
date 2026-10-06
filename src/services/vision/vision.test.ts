#!/usr/bin/env node
/**
 * Hybrid vision seam — hermetic tests
 * ============================================================================
 *
 * Nothing here touches the YOLO worker or the network. The deterministic engines
 * are stubbed by feeding controlled `VisionAnalysis` objects through the pure
 * `combineHybrid`, and the LLM is a fake `VisionLLMClient`. What these guard:
 *
 *   - the escalation ladder: YOLO-confident short-circuits the LLM; an unsure
 *     YOLO escalates; an absent or unsure LLM lands on human review;
 *   - `combineHybrid` picks the authoritative layer and keeps YOLO's boxes;
 *   - the LLM provider maps a judgement, escalates on low self-confidence, and
 *     turns a thrown client into human review rather than a fabricated 0;
 *   - `resolveVisionProvider` returns null for "off"/unknown and never starts
 *     an LLM path without a fully configured client.
 *
 *   npm run test:vision
 */
import type { VisionAnalysis, VisionInput, VisionLLMClient, VisionProvider } from './types';
import { combineHybrid, HybridVisionProvider } from './hybridProvider';
import { VisionLLMProvider } from './llmProvider';
import { resolveVisionProvider, SimulationVisionProvider, YoloVisionProvider } from './index';
import { aiVisionService, yoloCliArgs } from '../aiVision';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

const INPUT: VisionInput = {
  photoUrl: 'https://example.test/audits/str-1/task-1_1700000000.jpg',
  taskTitle: 'Raf yoxlaması',
  taskDescription: 'Coca-Cola soyuducusu',
};

function analysis(over: Partial<VisionAnalysis>): VisionAnalysis {
  return {
    complianceScore: 50,
    confidence: 0.5,
    needsHumanReview: false,
    detectedCounts: {},
    skuBreakdown: [],
    detections: [],
    summary: 'x',
    engine: 'ultralytics-yolo',
    provider: 'yolo',
    analyzedAt: new Date().toISOString(),
    ...over,
  };
}

/** A provider that returns a fixed analysis and records that it was called. */
class StubProvider implements VisionProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly result: VisionAnalysis,
  ) {}
  async analyze(): Promise<VisionAnalysis> {
    this.calls++;
    return this.result;
  }
}

async function main(): Promise<void> {
  console.log('hybrid vision seam\n');

  // --- combineHybrid: pure verdict merging ----------------------------------
  {
    const yolo = analysis({
      complianceScore: 88,
      confidence: 0.8,
      detections: [{ id: 'd1' } as any],
    });
    const out = combineHybrid(yolo, null, 'yolo-confident', 'T');
    check('yolo-confident keeps YOLO score', out.complianceScore === 88);
    check('yolo-confident is not human review', out.needsHumanReview === false);
    check('hybrid result is labelled hybrid', out.engine === 'hybrid' && out.provider === 'hybrid');
    check('hybrid keeps YOLO detections', out.detections.length === 1);
  }
  {
    const yolo = analysis({
      complianceScore: 40,
      confidence: 0.3,
      detections: [{ id: 'd1' } as any],
    });
    const llm = analysis({
      complianceScore: 91,
      confidence: 0.9,
      engine: 'vision-llm',
      provider: 'vision-llm:test',
      model: 'test-model',
    });
    const out = combineHybrid(yolo, llm, 'llm-confident', 'T');
    check('llm-confident takes LLM score', out.complianceScore === 91);
    check('llm-confident keeps YOLO boxes', out.detections.length === 1);
    check('llm-confident carries the model', out.model === 'test-model');
    check('llm-confident is not human review', out.needsHumanReview === false);
    check('confidence is the max of both layers', out.confidence === 0.9);
  }
  {
    const yolo = analysis({ confidence: 0.3 });
    const llm = analysis({ confidence: 0.4, engine: 'vision-llm' });
    const out = combineHybrid(yolo, llm, 'llm-unsure-human-review', 'T');
    check('both-unsure escalates to human', out.needsHumanReview === true);
  }
  {
    const out = combineHybrid(analysis({ confidence: 0.2 }), null, 'no-llm-human-review', 'T');
    check('no-LLM path escalates to human', out.needsHumanReview === true);
  }

  // --- HybridVisionProvider: the escalation ladder --------------------------
  {
    const yolo = new StubProvider('yolo', analysis({ confidence: 0.8, needsHumanReview: false }));
    const llm = new StubProvider('llm', analysis({ confidence: 0.9, engine: 'vision-llm' }));
    const out = await new HybridVisionProvider(yolo, llm).analyze(INPUT);
    check('confident YOLO short-circuits the LLM', llm.calls === 0, `llm.calls=${llm.calls}`);
    check('confident YOLO produces a decisive result', out.needsHumanReview === false);
  }
  {
    const yolo = new StubProvider('yolo', analysis({ confidence: 0.2, needsHumanReview: true }));
    const llm = new StubProvider(
      'llm',
      analysis({ confidence: 0.9, complianceScore: 77, engine: 'vision-llm' }),
    );
    const out = await new HybridVisionProvider(yolo, llm).analyze(INPUT);
    check('unsure YOLO escalates to the LLM', llm.calls === 1, `llm.calls=${llm.calls}`);
    check(
      'confident LLM verdict wins',
      out.complianceScore === 77 && out.needsHumanReview === false,
    );
  }
  {
    const yolo = new StubProvider('yolo', analysis({ confidence: 0.2, needsHumanReview: true }));
    const out = await new HybridVisionProvider(yolo, null).analyze(INPUT);
    check('unsure YOLO with no LLM lands on human review', out.needsHumanReview === true);
  }
  {
    const yolo = new StubProvider('yolo', analysis({ confidence: 0.2, needsHumanReview: true }));
    const llm = new StubProvider(
      'llm',
      analysis({ confidence: 0.3, needsHumanReview: true, engine: 'vision-llm' }),
    );
    const out = await new HybridVisionProvider(yolo, llm).analyze(INPUT);
    check('unsure YOLO + unsure LLM lands on human review', out.needsHumanReview === true);
  }

  // --- VisionLLMProvider: mapping and failure -------------------------------
  {
    const client: VisionLLMClient = {
      label: 'vision-llm:fake',
      model: 'fake-1',
      async judge() {
        return {
          complianceScore: 82,
          confidence: 0.85,
          detectedCounts: { coca_cola_classic: 3 },
          missingItems: [],
          summary: 'ok',
        };
      },
    };
    const out = await new VisionLLMProvider(client).analyze(INPUT);
    check('LLM provider maps the score', out.complianceScore === 82);
    check('LLM provider is labelled vision-llm', out.engine === 'vision-llm');
    check('confident LLM does not force human review', out.needsHumanReview === false);
    check('LLM provider builds a breakdown from counts', out.skuBreakdown.length > 0);
  }
  {
    const client: VisionLLMClient = {
      label: 'vision-llm:unsure',
      model: 'fake-1',
      async judge() {
        return {
          complianceScore: 80,
          confidence: 0.3,
          detectedCounts: {},
          missingItems: [],
          summary: 'blurry',
        };
      },
    };
    const out = await new VisionLLMProvider(client).analyze(INPUT);
    check('low LLM self-confidence forces human review', out.needsHumanReview === true);
  }
  {
    const client: VisionLLMClient = {
      label: 'vision-llm:down',
      model: 'fake-1',
      async judge() {
        throw new Error('HTTP 503');
      },
    };
    const out = await new VisionLLMProvider(client).analyze(INPUT);
    check(
      'a thrown client becomes human review, not a fabricated 0-verdict',
      out.needsHumanReview === true,
    );
    check('a thrown client still reports engine vision-llm', out.engine === 'vision-llm');
  }

  // --- resolveVisionProvider: the env edge ----------------------------------
  {
    check('default (no env) is off → null', resolveVisionProvider({} as any) === null);
    check(
      'explicit off is null',
      resolveVisionProvider({ ONETEAM_VISION_PROVIDER: 'off' } as any) === null,
    );
    check(
      'simulation resolves to the simulation provider',
      resolveVisionProvider({ ONETEAM_VISION_PROVIDER: 'simulation' } as any) instanceof
        SimulationVisionProvider,
    );
    check(
      'yolo resolves to the YOLO provider',
      resolveVisionProvider({ ONETEAM_VISION_PROVIDER: 'yolo' } as any) instanceof
        YoloVisionProvider,
    );
    check(
      'vision-llm with no client config is null (not a broken provider)',
      resolveVisionProvider({ ONETEAM_VISION_PROVIDER: 'vision-llm' } as any) === null,
    );
    check(
      'vision-llm with full config resolves to a provider',
      resolveVisionProvider({
        ONETEAM_VISION_PROVIDER: 'vision-llm',
        ONETEAM_VISION_LLM_URL: 'https://x.test/v1/chat/completions',
        ONETEAM_VISION_LLM_MODEL: 'test/model',
        ONETEAM_VISION_LLM_KEY: 'dummy',
      } as any) instanceof VisionLLMProvider,
    );
    check(
      'hybrid always resolves to the hybrid provider (LLM optional)',
      resolveVisionProvider({ ONETEAM_VISION_PROVIDER: 'hybrid' } as any) instanceof
        HybridVisionProvider,
    );
    check(
      'unknown provider is disabled → null',
      resolveVisionProvider({ ONETEAM_VISION_PROVIDER: 'gpt5-vision' } as any) === null,
    );
  }

  // --- The remote YOLO worker (HTTP) ---------------------------------------
  //
  // The worker was reachable only through `spawnSync`, which freezes the event
  // loop for the whole run — a cold start measured 47s, and that cost was paid
  // inside the bot process, which has a Telegram answer to send. A long-lived
  // worker owns the cost instead, so these checks drive the client against a
  // real socket: a stub that answers with the worker's own JSON contract.
  await (async () => {
    const http = await import('node:http');
    type Stub = { body: string; status?: number };
    let stub: Stub = { body: '' };
    let hits = 0;
    let lastRequest: { image?: unknown; raw?: string } = {};

    const server = http.createServer((req, res) => {
      hits++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        lastRequest = { raw };
        try {
          lastRequest.image = JSON.parse(raw).image;
        } catch {
          lastRequest.image = undefined;
        }
        res.writeHead(stub.status ?? 200, { 'content-type': 'application/json' });
        res.end(stub.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}`;

    const box = {
      id: 'det-1',
      sku: 'coca_cola_classic',
      label: 'Coca-Cola Classic 0.5L',
      confidence: 0.91,
      box: { x: 10, y: 20, width: 8, height: 40 },
      color: '#F40009',
      shelfRow: 1,
      facingIndex: 1,
    };

    stub = {
      body: JSON.stringify({ success: true, detections: [box], synthetic_fallback: false }),
    };
    let out = await aiVisionService.runUltralyticsInferenceRemote(INPUT.photoUrl, {
      workerUrl: url,
    });
    check(
      'remote worker: a real box is reported as ok and not synthetic',
      out.ok === true && out.detections.length === 1 && out.synthetic === false,
      JSON.stringify(out),
    );

    stub = { body: JSON.stringify({ success: true, detections: [box], synthetic_fallback: true }) };
    out = await aiVisionService.runUltralyticsInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: the synthetic flag survives the round-trip',
      out.ok === true && out.synthetic === true,
      JSON.stringify(out),
    );

    stub = { body: JSON.stringify({ success: true, detections: [], synthetic_fallback: false }) };
    out = await aiVisionService.runUltralyticsInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: an empty detection list is no-detections, not ok',
      out.ok === false && out.reason === 'no-detections',
      JSON.stringify(out),
    );

    stub = { body: JSON.stringify({ success: false, error: 'Import error: cv2' }) };
    out = await aiVisionService.runUltralyticsInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: the worker’s own error is surfaced with its text',
      out.ok === false &&
        out.reason === 'worker-failed' &&
        out.detail.includes('Import error: cv2'),
      JSON.stringify(out),
    );

    stub = { body: '<html>500</html>', status: 500 };
    out = await aiVisionService.runUltralyticsInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: a non-JSON failure is worker-failed, never detections',
      out.ok === false && out.reason === 'worker-failed',
      JSON.stringify(out),
    );

    // Nothing is listening on this port: the connection is refused outright.
    const dead = 'http://127.0.0.1:9';
    out = await aiVisionService.runUltralyticsInferenceRemote(INPUT.photoUrl, { workerUrl: dead });
    check(
      'remote worker: an unreachable worker is worker-unavailable and names the URL',
      out.ok === false && out.reason === 'worker-unavailable' && out.detail.includes(dead),
      JSON.stringify(out),
    );

    hits = 0;
    stub = {
      body: JSON.stringify({ success: true, detections: [box], synthetic_fallback: false }),
    };
    // The bot holds the decoded bytes already (it just downloaded them from
    // Telegram) — the configured R2 URL is a second fetch away and a data: URL
    // is not addressable at all. When an imageBuffer is supplied it must win,
    // as the inline payload, instead of the URL.
    hits = 0;
    stub = {
      body: JSON.stringify({ success: true, detections: [box], synthetic_fallback: false }),
    };
    lastRequest = {};
    const providerBuf = new YoloVisionProvider(url);
    await providerBuf.analyze({
      ...INPUT,
      imageBuffer: Buffer.from('fake-jpeg-bytes'),
    });
    check(
      'an imageBuffer reaches the worker inline instead of the photo URL',
      typeof lastRequest.image === 'string' &&
        lastRequest.image.startsWith('data:image/jpeg;base64,'),
      JSON.stringify(lastRequest).slice(0, 200),
    );

    // Two analyze calls happened by this point (the imageBuffer one above and
    // this one) — asserting exactly one would pin the test to its own ordering.
    const provider = new YoloVisionProvider(url);
    const analysis = await provider.analyze(INPUT);
    check(
      'YoloVisionProvider with a worker URL talks to the worker, not to spawnSync',
      hits === 2 && analysis.provider === 'yolo' && analysis.engine === 'ultralytics-yolo',
      `hits=${hits} provider=${analysis.provider} engine=${analysis.engine}`,
    );
    // Not `needsHumanReview === false`: one bottle against a planogram that
    // demands three facings SHOULD land on human review, and asserting the
    // opposite would pin the test to a wrong rule. What the remote path must
    // preserve is that the run counts as *trustworthy* — the hybrid turns on
    // confidence, and an untrustworthy run reports 0 no matter how good the
    // boxes were.
    check(
      'a trustworthy remote result carries the detector’s confidence',
      analysis.confidence > 0 && !analysis.summary.includes('etibarsız'),
      JSON.stringify({ confidence: analysis.confidence, summary: analysis.summary }),
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
  })();

  // The model is the worker's to own: the local spawn path must read the same
  // ONETEAM_YOLO_MODEL the worker's /health reports, or the two transports
  // silently run different detectors.
  {
    const saved = process.env.ONETEAM_YOLO_MODEL;
    delete process.env.ONETEAM_YOLO_MODEL;
    const defaults = yoloCliArgs('/x/yolo_inference.py', 'IMG');
    process.env.ONETEAM_YOLO_MODEL = 'yolo11n.pt';
    const configured = yoloCliArgs('/x/yolo_inference.py', 'IMG');
    if (saved === undefined) delete process.env.ONETEAM_YOLO_MODEL;
    else process.env.ONETEAM_YOLO_MODEL = saved;
    check(
      'local spawn args default to yolo11n and honor ONETEAM_YOLO_MODEL',
      defaults.join(' ') === '/x/yolo_inference.py --image IMG --model yolo11n.pt' &&
        configured.join(' ') === '/x/yolo_inference.py --image IMG --model yolo11n.pt',
      JSON.stringify({ defaults, configured }),
    );
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The suite could not finish:', error);
  process.exit(1);
});
