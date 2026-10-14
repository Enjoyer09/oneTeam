#!/usr/bin/env node
/**
 * OpenRouter client — hermetic tests
 * ============================================================================
 *
 * No network and no real waiting: `fetch` is a fake, and the clock/sleep are
 * injected so a 60-second `Retry-After` costs zero milliseconds of test time.
 *
 * Each case below is a way the limiter or the retry policy could look green
 * while being useless — a limiter that never limits, a retry that retries the
 * wrong failures, a key that leaks into a log line.
 *
 *   npm run test:openrouter
 */
import {
  OpenRouterClient,
  TokenBucket,
  openRouterClientFromEnv,
  parseJudgement,
} from './openrouterClient';
import type { VisionInput } from './types';

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

/** A controllable clock: tests move it explicitly, a sleep advances it. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const INPUT: VisionInput = {
  photoUrl: 'https://example.test/a.jpg',
  imageBuffer: Buffer.from('fake-jpeg-bytes'),
  taskTitle: 'Raf yoxlaması',
};

const GOOD_BODY = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          complianceScore: 82,
          confidence: 0.71,
          isBeverageShelf: true,
          detectedCounts: { coca_cola_classic: 6, fanta: 2, bogus_sku: 9 },
          missingItems: ['Sprite çatışmır'],
          summary: 'Rəf planogram ilə qismən uyğundur',
        }),
      },
    },
  ],
};

/** A `fetch` that replays a scripted list of responses and records each call. */
function fakeFetch(
  responses: Array<{ status: number; json?: any; text?: string; retryAfter?: string }>,
) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let i = 0;
  const impl = (async (url: string, init: any) => {
    calls.push({
      url: String(url),
      headers: init?.headers ?? {},
      body: JSON.parse(init?.body ?? '{}'),
    });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(spec.text ?? JSON.stringify(spec.json ?? {}), {
      status: spec.status,
      headers: spec.retryAfter ? { 'retry-after': spec.retryAfter } : undefined,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeClient(over: Record<string, unknown>, responses: any[]) {
  const clock = fakeClock();
  const { impl, calls } = fakeFetch(responses);
  const c = new OpenRouterClient({
    apiKey: 'sk-test-SECRET',
    model: 'google/gemini-flash-1.5',
    fetchImpl: impl,
    now: clock.now,
    sleep: clock.sleep,
    // A generous bucket: the limiter has its own section, so these cases test
    // the HTTP policy only. Without it, the default 20/min would cap the loop.
    bucket: new TokenBucket({
      capacity: 1000,
      refillIntervalMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    }),
    ...over,
  } as any);
  return { c, calls, clock };
}

async function main(): Promise<void> {
  console.log('OpenRouter client\n');

  // --- TokenBucket: it must actually limit, and wait rather than throw -------
  {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      capacity: 3,
      refillIntervalMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    for (let i = 0; i < 3; i++) await bucket.take();
    check('a bucket hands out its whole burst without waiting', clock.sleeps.length === 0);

    await bucket.take();
    check(
      'the next caller WAITS instead of throwing',
      clock.sleeps.length === 1,
      `sleeps=${clock.sleeps}`,
    );

    // Nothing refills within any sane bound, so the wait must be reported.
    const never = new TokenBucket({
      capacity: 1,
      refillIntervalMs: 10_000_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await never.take();
    let threw = '';
    try {
      await never.take(1000);
    } catch (e) {
      threw = (e as Error).message;
    }
    check(
      'a wait longer than the bound is reported, not queued forever',
      threw.includes('no token within'),
      threw,
    );
  }

  // --- Happy path -----------------------------------------------------------
  {
    const { c, calls } = makeClient({}, [{ status: 200, json: GOOD_BODY }]);
    const j = await c.judge(INPUT);
    check(
      'a well-formed reply becomes a judgement',
      j.complianceScore === 82 && j.confidence === 0.71 && j.isBeverageShelf === true,
    );
    check(
      'an unknown SKU in the reply is dropped, not trusted',
      !('bogus_sku' in j.detectedCounts),
    );
    check(
      'the key is sent as a bearer header',
      calls[0].headers.Authorization === 'Bearer sk-test-SECRET',
    );
    check(
      'the image is inlined as a data URL',
      String(calls[0].body.messages[0].content[1].image_url.url).startsWith(
        'data:image/jpeg;base64,',
      ),
    );
    check(
      'the prompt asks for JSON only',
      calls[0].body.messages[0].content[0].text.includes('ONLY a JSON object'),
    );
  }

  // --- 429 is the one retried failure ---------------------------------------
  {
    const { c, calls, clock } = makeClient({ maxRetries: 2 }, [
      { status: 429, text: 'rate limited', retryAfter: '30' },
      { status: 200, json: GOOD_BODY },
    ]);
    const j = await c.judge(INPUT);
    check(
      'a 429 is retried and the retry succeeds',
      j.complianceScore === 82 && calls.length === 2,
      `calls=${calls.length}`,
    );
    check(
      'it waits exactly the Retry-After it was given',
      clock.sleeps.includes(30_000),
      `sleeps=${clock.sleeps}`,
    );
  }

  {
    const { c, calls } = makeClient({ maxRetries: 2 }, [
      { status: 429, text: 'rate limited', retryAfter: '1' },
    ]);
    let threw = '';
    try {
      await c.judge(INPUT);
    } catch (e) {
      threw = (e as Error).message;
    }
    check(
      'a 429 that never clears stops after maxRetries, not forever',
      calls.length === 3 && threw.includes('HTTP 429'),
      `calls=${calls.length} err=${threw}`,
    );
  }

  // --- Everything else throws on the first attempt ---------------------------
  for (const status of [401, 402, 500]) {
    const { c, calls } = makeClient({ maxRetries: 3 }, [{ status, text: 'upstream said no' }]);
    let threw = '';
    try {
      await c.judge(INPUT);
    } catch (e) {
      threw = (e as Error).message;
    }
    check(
      `HTTP ${status} is thrown on the first attempt, not retried`,
      calls.length === 1 && threw.includes(String(status)),
      `calls=${calls.length} err=${threw}`,
    );
  }

  // --- A bad payload must not become a fabricated verdict -------------------
  {
    let threw = '';
    try {
      parseJudgement('I am a model and I will not comply.');
    } catch (e) {
      threw = (e as Error).message;
    }
    check(
      'a non-JSON reply throws rather than becoming a 0 score',
      threw.includes('non-JSON'),
      threw,
    );
  }

  // --- Env wiring: half-configured is not configured -------------------------
  {
    check('no key + no model → no client', openRouterClientFromEnv({} as any) === null);
    check(
      'a key without a model → no client',
      openRouterClientFromEnv({ OPENROUTER_API_KEY: 'k' } as any) === null,
    );
    const built = openRouterClientFromEnv({
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_MODEL: 'm',
    } as any);
    check('key + model → a client labelled for the audit trail', built?.label === 'openrouter:m');
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
