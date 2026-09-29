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

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The suite could not finish:', error);
  process.exit(1);
});
