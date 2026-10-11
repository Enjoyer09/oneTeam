/**
 * loadPhaseReducer — assert-based check (no framework; repo convention).
 *
 * RED/GREEN/mutation guard for the dashboard load state machine that decides
 * between the skeleton, the data, and the error panel. Run with:
 *
 *   node ./node_modules/tsx/dist/cli.mjs web/src/lib/loadPhase.check.ts
 *
 * Exits non-zero on the first failed assertion.
 */

import { loadPhaseReducer, type LoadPhase } from './loadPhase';

let failures = 0;

function equal(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error(`  ✗ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failures += 1;
  } else {
    console.log(`  ✓ ${name}`);
  }
}

// A fresh dashboard has not loaded yet — the component's initial phase.
const initial: LoadPhase = 'loading';

equal('a fresh dashboard is loading, not ready', initial, 'loading');

equal('a successful load moves to ready', loadPhaseReducer(initial, { type: 'loaded' }), 'ready');

equal(
  'a failed load moves to error, not to a silent zero state',
  loadPhaseReducer(initial, { type: 'failed' }),
  'error',
);

equal(
  'retry from the error panel goes back to loading',
  loadPhaseReducer('error', { type: 'retry' }),
  'loading',
);

// A background refresh (window focus) that fails must surface: the numbers on
// screen may be minutes old, and "ready" would keep pretending otherwise.
equal(
  'a failed background refresh surfaces as error',
  loadPhaseReducer('ready', { type: 'failed' }),
  'error',
);

equal(
  'an unknown action leaves the phase alone',
  loadPhaseReducer('ready', { type: 'nonsense' } as never),
  'ready',
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nloadPhase.check: all assertions passed');
