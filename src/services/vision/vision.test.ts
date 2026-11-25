#!/usr/bin/env node
/**
 * Hybrid vision seam — hermetic tests
 * ============================================================================
 *
 * Nothing here touches the detector worker or the network. The deterministic engines
 * are stubbed by feeding controlled `VisionAnalysis` objects through the pure
 * `combineHybrid`, and the LLM is a fake `VisionLLMClient`. What these guard:
 *
 *   - the escalation ladder: detector-confident short-circuits the LLM; an unsure
 *     detector escalates; an absent or unsure LLM lands on human review;
 *   - `combineHybrid` picks the authoritative layer and keeps detector's boxes;
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
import { resolveVisionProvider, SimulationVisionProvider, TorchVisionProvider } from './index';
import { aiVisionService, torchvisionCliArgs } from '../aiVision';

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
  taskDescription: 'oneTeam Retail soyuducusu',
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
    engine: 'torchvision-detection',
    provider: 'torchvision',
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
    const out = combineHybrid(yolo, null, 'detector-confident', 'T');
    check('detector-confident keeps detector score', out.complianceScore === 88);
    check('detector-confident is not human review', out.needsHumanReview === false);
    check('hybrid result is labelled hybrid', out.engine === 'hybrid' && out.provider === 'hybrid');
    check('hybrid keeps detector detections', out.detections.length === 1);
  }
  {
    const yolo = analysis({
      complianceScore: 40,
      confidence: 0.3,
      detections: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }] as any,
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
    check('llm-confident keeps detector boxes', out.detections.length === 3);
    check('llm-confident carries the model', out.model === 'test-model');
    check(
      'LLM confidence still requires human review before model qualification',
      out.needsHumanReview === true,
    );
    check('confidence is the max of both layers', out.confidence === 0.9);
  }
  {
    const yolo = analysis({ confidence: 0.3 });
    const llm = analysis({ confidence: 0.4, engine: 'vision-llm' });
    const out = combineHybrid(yolo, llm, 'llm-unsure-human-review', 'T');
    check('both-unsure escalates to human', out.needsHumanReview === true);
  }
  {
    const yolo = analysis({ confidence: 0, detections: [] });
    const llm = analysis({ confidence: 0.99, complianceScore: 99, engine: 'vision-llm' });
    const out = combineHybrid(yolo, llm, 'llm-confident', 'T');
    check('a room without detected bottles cannot auto-approve', out.needsHumanReview);
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
    check('confident detector short-circuits the LLM', llm.calls === 0, `llm.calls=${llm.calls}`);
    check(
      'only a separately trusted detector can short-circuit review',
      out.needsHumanReview === false,
    );
  }
  {
    const yolo = new StubProvider(
      'yolo',
      analysis({
        confidence: 0.2,
        needsHumanReview: true,
        detections: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }] as any,
      }),
    );
    const llm = new StubProvider(
      'llm',
      analysis({ confidence: 0.9, complianceScore: 77, engine: 'vision-llm' }),
    );
    const out = await new HybridVisionProvider(yolo, llm).analyze(INPUT);
    check('unsure detector escalates to the LLM', llm.calls === 1, `llm.calls=${llm.calls}`);
    check(
      'LLM score is retained but held for human review',
      out.complianceScore === 77 && out.needsHumanReview === true,
    );
  }
  {
    const yolo = new StubProvider('yolo', analysis({ confidence: 0.2, needsHumanReview: true }));
    const out = await new HybridVisionProvider(yolo, null).analyze(INPUT);
    check('unsure detector with no LLM lands on human review', out.needsHumanReview === true);
  }
  {
    const yolo = new StubProvider('yolo', analysis({ confidence: 0.2, needsHumanReview: true }));
    const llm = new StubProvider(
      'llm',
      analysis({ confidence: 0.3, needsHumanReview: true, engine: 'vision-llm' }),
    );
    const out = await new HybridVisionProvider(yolo, llm).analyze(INPUT);
    check('unsure detector + unsure LLM lands on human review', out.needsHumanReview === true);
  }

  // --- VisionLLMProvider: mapping and failure -------------------------------
  {
    let seenRequirements = 0;
    const client: VisionLLMClient = {
      label: 'vision-llm:fake',
      model: 'fake-1',
      async judge(input) {
        seenRequirements = input.requirements?.length ?? 0;
        return {
          complianceScore: 82,
          confidence: 0.85,
          isBeverageShelf: true,
          detectedCounts: { classic_soda: 3 },
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
    check('derived planogram reaches the model prompt', seenRequirements > 0);
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
      label: 'vision-llm:off-shelf',
      model: 'fake-1',
      async judge() {
        return {
          complianceScore: 96,
          confidence: 0.99,
          isBeverageShelf: false,
          detectedCounts: { lemon_soda: 5 },
          missingItems: [],
          summary: 'wrong scene',
        };
      },
    };
    const out = await new VisionLLMProvider(client).analyze(INPUT);
    check('a confident off-shelf claim still requires human review', out.needsHumanReview);
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
      'torchvision resolves to the TorchVision provider',
      resolveVisionProvider({ ONETEAM_VISION_PROVIDER: 'torchvision' } as any) instanceof
        TorchVisionProvider,
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

  // --- The remote detector worker (HTTP) ---------------------------------------
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
    let lastRequest: { image?: unknown; conf?: unknown; raw?: string } = {};

    const server = http.createServer((req, res) => {
      hits++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        lastRequest = { raw };
        try {
          const parsed = JSON.parse(raw);
          lastRequest.image = parsed.image;
          lastRequest.conf = parsed.conf;
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
      sku: 'unverified_bottle',
      label: 'Butulka — marka təsdiqlənməyib',
      confidence: 0.91,
      objectClass: 'bottle',
      box: { x: 10, y: 20, width: 8, height: 40 },
      color: '#F40009',
      shelfRow: 1,
      facingIndex: 1,
    };

    stub = {
      body: JSON.stringify({ success: true, detections: [box], synthetic_fallback: false }),
    };
    let out = await aiVisionService.runTorchVisionInferenceRemote(INPUT.photoUrl, {
      workerUrl: url,
    });
    check(
      'remote worker: a real box is reported as ok and not synthetic',
      out.ok === true && out.detections.length === 1 && out.synthetic === false,
      JSON.stringify(out),
    );

    stub = { body: JSON.stringify({ success: true, detections: [box], synthetic_fallback: true }) };
    out = await aiVisionService.runTorchVisionInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: the synthetic flag survives the round-trip',
      out.ok === true && out.synthetic === true,
      JSON.stringify(out),
    );

    stub = { body: JSON.stringify({ success: true, detections: [], synthetic_fallback: false }) };
    out = await aiVisionService.runTorchVisionInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: an empty detection list is no-detections, not ok',
      out.ok === false && out.reason === 'no-detections',
      JSON.stringify(out),
    );

    stub = { body: JSON.stringify({ success: false, error: 'Import error: cv2' }) };
    out = await aiVisionService.runTorchVisionInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: the worker’s own error is surfaced with its text',
      out.ok === false &&
        out.reason === 'worker-failed' &&
        out.detail.includes('Import error: cv2'),
      JSON.stringify(out),
    );

    stub = {
      body: JSON.stringify({
        success: false,
        error: 'TorchVision detector is disabled pending an approved checkpoint.',
      }),
      status: 503,
    };
    out = await aiVisionService.runTorchVisionInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: a deliberately disabled model is reported as unavailable',
      out.ok === false && out.reason === 'worker-unavailable',
      JSON.stringify(out),
    );

    stub = { body: '<html>500</html>', status: 500 };
    out = await aiVisionService.runTorchVisionInferenceRemote(INPUT.photoUrl, { workerUrl: url });
    check(
      'remote worker: a non-JSON failure is worker-failed, never detections',
      out.ok === false && out.reason === 'worker-failed',
      JSON.stringify(out),
    );

    // Nothing is listening on this port: the connection is refused outright.
    const dead = 'http://127.0.0.1:9';
    out = await aiVisionService.runTorchVisionInferenceRemote(INPUT.photoUrl, { workerUrl: dead });
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
    const providerBuf = new TorchVisionProvider(url);
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
    const provider = new TorchVisionProvider(url);
    const analysis = await provider.analyze(INPUT);
    check(
      'TorchVisionProvider with a worker URL talks to the worker, not to spawnSync',
      hits === 2 &&
        analysis.provider === 'torchvision' &&
        analysis.engine === 'torchvision-detection',
      `hits=${hits} provider=${analysis.provider} engine=${analysis.engine}`,
    );
    check(
      'generic bottle confidence never becomes SKU verdict confidence',
      analysis.confidence === 0 &&
        analysis.needsHumanReview &&
        analysis.detections.length === 1 &&
        analysis.detectedCounts.classic_soda === undefined,
      JSON.stringify(analysis),
    );

    // Old workers may be live during a rolling deploy. Their brand guesses
    // carry no object-class proof, so discard them rather than display them.
    stub = {
      body: JSON.stringify({
        success: true,
        detections: [{ ...box, sku: 'lemon_soda', objectClass: undefined }],
        synthetic_fallback: false,
      }),
    };
    const legacy = await provider.analyze(INPUT);
    check(
      'old brand-labelled worker boxes are discarded',
      legacy.detections.length === 0 && legacy.needsHumanReview,
      JSON.stringify(legacy),
    );
    stub = {
      body: JSON.stringify({ success: true, detections: [box], synthetic_fallback: false }),
    };

    // The conf knob must reach the worker on the HTTP transport too, or the
    // deployed threshold would silently stay the script default.
    lastRequest = {};
    process.env.ONETEAM_TORCHVISION_CONF = '0.55';
    try {
      const providerConf = new TorchVisionProvider(url);
      await providerConf.analyze(INPUT);
      check(
        'remote payload carries ONETEAM_TORCHVISION_CONF when set',
        lastRequest.conf === 0.55,
        JSON.stringify(lastRequest).slice(0, 200),
      );
    } finally {
      delete process.env.ONETEAM_TORCHVISION_CONF;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  })();

  // Local invocation is disabled unless an explicitly configured custom checkpoint exists.
  {
    const savedMode = process.env.ONETEAM_TORCHVISION_MODE;
    const savedCheckpoint = process.env.ONETEAM_TORCHVISION_CHECKPOINT;
    const savedConf = process.env.ONETEAM_TORCHVISION_CONF;
    delete process.env.ONETEAM_TORCHVISION_MODE;
    delete process.env.ONETEAM_TORCHVISION_CHECKPOINT;
    delete process.env.ONETEAM_TORCHVISION_CONF;
    const defaults = torchvisionCliArgs('/x/torchvision_inference.py', 'IMG');
    process.env.ONETEAM_TORCHVISION_MODE = 'custom';
    process.env.ONETEAM_TORCHVISION_CHECKPOINT = '/models/reviewed.pth';
    process.env.ONETEAM_TORCHVISION_CONF = '0.55';
    const configured = torchvisionCliArgs('/x/torchvision_inference.py', 'IMG');
    for (const [key, value] of Object.entries({
      ONETEAM_TORCHVISION_MODE: savedMode,
      ONETEAM_TORCHVISION_CHECKPOINT: savedCheckpoint,
      ONETEAM_TORCHVISION_CONF: savedConf,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    check(
      'local args default to disabled and honor reviewed custom checkpoint settings',
      defaults.join(' ') === '/x/torchvision_inference.py --image IMG --mode disabled' &&
        configured.join(' ') ===
          '/x/torchvision_inference.py --image IMG --mode custom --checkpoint /models/reviewed.pth --conf 0.55',
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
