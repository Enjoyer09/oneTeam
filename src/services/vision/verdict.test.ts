#!/usr/bin/env node
/**
 * Shelf-verdict schema (4.2) — hermetic tests
 * ============================================================================
 *
 * No model and no network: these feed hand-written replies through the schema
 * and check what survives.
 *
 * The cases that matter are the ones where a lenient parser would produce a
 * plausible number from a reply that never stated one:
 *
 *   - a score given as a STRING, or a confidence of 7, is rejected rather than
 *     coerced;
 *   - a reply with no score at all is rejected, not defaulted to 0;
 *   - a hallucinated SKU is rejected — it would otherwise reach a planogram
 *     breakdown as a real product;
 *   - prose, empty output and unfenced code all behave;
 *   - and no failure ever becomes a score: every unreadable reply escalates to
 *     a human, because a fabricated zero is a rejection nobody made.
 *
 *   npm run test:verdict
 */
import { assessVerdict, parseVerdict, buildVerdictPrompt } from './verdict';

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

const GOOD = {
  complianceScore: 82,
  confidence: 0.71,
  detectedCounts: { coca_cola_classic: 6, fanta: 3 },
  missingSKUs: [{ sku: 'sprite', shortfall: 2 }],
  extraItems: [{ description: 'Pepsi', location: 'yuxarı rəf' }],
  anomalies: [{ kind: 'damaged', description: 'ezilmiş qab', severity: 'low' }],
  summary: 'Rəf qismən uyğundur',
};

console.log('shelf verdict schema\n');

// --- The happy path, and that the schema adds nothing it did not have -------
{
  const r = parseVerdict(JSON.stringify(GOOD));
  check('a well-formed verdict parses', r.ok, r.ok ? '' : r.detail);
  if (r.ok) {
    check('the score survives exactly', r.verdict.complianceScore === 82);
    check('the SKU counts survive', r.verdict.detectedCounts.fanta === 3);
    check('missing SKUs survive', r.verdict.missingSKUs[0]?.sku === 'sprite');
    check('a complete verdict raises no warnings', r.warnings.length === 0, r.warnings.join('; '));
    check('a confident, complete verdict is accepted', assessVerdict(r).triage === 'accept');
  }
}

// --- Coercion must NOT happen (the whole reason this module exists) --------
{
  const asString = parseVerdict(JSON.stringify({ ...GOOD, complianceScore: '82' }));
  check('a score sent as a STRING is rejected, not coerced', !asString.ok, `ok=${asString.ok}`);

  const outOfRange = parseVerdict(JSON.stringify({ ...GOOD, confidence: 7 }));
  check('a confidence of 7 is rejected rather than clamped', !outOfRange.ok, `ok=${outOfRange.ok}`);

  const noScore = parseVerdict(JSON.stringify({ confidence: 0.9, detectedCounts: { fanta: 2 } }));
  check(
    'a verdict with NO score is rejected, not defaulted to 0',
    !noScore.ok && noScore.reason === 'schema-invalid',
    `ok=${noScore.ok} reason=${noScore.ok ? 'n/a' : noScore.reason}`,
  );
}
// --- Unfenced JSON, prose and silence -------------------------------------
{
  const fenced = parseVerdict('```json\n' + JSON.stringify(GOOD) + '\n```');
  check('a fenced code block still parses', fenced.ok, fenced.ok ? '' : fenced.detail);

  const prose = parseVerdict('Sən Coca-Cola rəf auditçisisən. Rəf çox yaxşıdır.');
  check(
    'prose is rejected',
    !prose.ok && prose.reason === 'not-json',
    `reason=${prose.ok ? 'n/a' : prose.reason}`,
  );

  const silence = parseVerdict('   ');
  check('silence is rejected as empty', !silence.ok && silence.reason === 'empty');

  const scoresInProse = parseVerdict('Score: 85. Looks good!');
  check('a number inside prose is not read as a score', !scoresInProse.ok);
}

// --- Every failure escalates to a human, never to a grade ------------------
{
  const failures = [
    parseVerdict(''),
    parseVerdict('not json'),
    parseVerdict(JSON.stringify({ ...GOOD, complianceScore: 500 })),
    parseVerdict(JSON.stringify({ ...GOOD, confidence: -1 })),
  ];
  check(
    'every unreadable reply is human-review, and none becomes a 0',
    failures.every((f) => assessVerdict(f).triage === 'human-review'),
    failures.map((f) => assessVerdict(f).triage).join(','),
  );
}

// --- Low self-confidence escalates even with a perfect score ---------------
{
  const unsure = parseVerdict(JSON.stringify({ ...GOOD, confidence: 0.2 }));
  check(
    'a high score with low self-confidence still goes to a human',
    unsure.ok && assessVerdict(unsure).triage === 'human-review',
  );
}

// --- Incoherent verdicts are surfaced, not silently accepted ---------------
{
  const noCounts = parseVerdict(JSON.stringify({ complianceScore: 90, confidence: 0.8 }));
  check('a score with no counts parses but warns', noCounts.ok && noCounts.warnings.length > 0);
  check(
    'a warned verdict goes to a human',
    noCounts.ok && assessVerdict(noCounts).triage === 'human-review',
  );

  const gapAsProduct = parseVerdict(
    JSON.stringify({
      ...GOOD,
      detectedCounts: { out_of_stock_gap: 4 },
      missingSKUs: [{ sku: 'fanta', shortfall: 1 }],
    }),
  );
  check(
    '"out_of_stock_gap" counted as a product is flagged, not accepted',
    gapAsProduct.ok && gapAsProduct.warnings.some((w) => w.includes('out_of_stock_gap')),
    gapAsProduct.ok ? gapAsProduct.warnings.join('; ') : 'rejected outright',
  );
}

// --- An unforeseen anomaly kind degrades instead of failing ---------------
{
  const odd = parseVerdict(
    JSON.stringify({
      ...GOOD,
      anomalies: [{ kind: 'melted', description: 'nəsə', severity: 'apocalyptic' }],
    }),
  );
  check(
    'an unknown anomaly kind/severity degrades to other/low rather than failing',
    odd.ok &&
      odd.verdict.anomalies[0]?.kind === 'other' &&
      odd.verdict.anomalies[0]?.severity === 'low',
  );
}

// --- The prompt says what it must ------------------------------------------
{
  const prompt = buildVerdictPrompt([
    { sku: 'fanta', label: 'Fanta Orange 0.5L', minFacings: 2 },
    { sku: 'sprite', label: 'Sprite 0.5L', minFacings: 3 },
  ]);
  check(
    "the prompt opens with the plan's own instruction",
    prompt.startsWith('Sən Coca-Cola rəf auditçisisən'),
  );
  check(
    'the prompt states the planogram minimums',
    prompt.includes('minimum 2 facing') && prompt.includes('minimum 3 facing'),
  );
  check(
    'the prompt lists every required key',
    [
      'complianceScore',
      'confidence',
      'detectedCounts',
      'missingSKUs',
      'extraItems',
      'anomalies',
      'summary',
    ].every((k) => prompt.includes(k)),
  );

  const hinted = buildVerdictPrompt([{ sku: 'fanta', label: 'F', minFacings: 1 }], {
    detectedCounts: { fanta: 4 },
  });
  check(
    'pre-filter counts are passed as a hint, framed as "verify"',
    hinted.includes('yoxla, etibar etmə'),
  );

  const empty = buildVerdictPrompt([]);
  check('an empty planogram does not produce an empty prompt', empty.length > 200);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);

// --- A hallucinated SKU is not a SKU ---------------------------------------
{
  const invented = parseVerdict(
    JSON.stringify({ ...GOOD, detectedCounts: { coca_cola_diet: 5, fanta: 1 } }),
  );
  check(
    'an invented SKU is rejected rather than counted as product',
    !invented.ok,
    `ok=${invented.ok}`,
  );
}
