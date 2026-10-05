import { buildSyncMessage, SyncCounts } from '../services/syncMessage';

/**
 * The guard on the one message a field worker uses to decide whether their
 * queued audits are safe. Written before the fix and watched fail — see the
 * commit message; the pre-fix copy reported completion while audits were
 * stranded.
 */

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${name}`);
  }
}

function counts(p: Partial<SyncCounts>): SyncCounts {
  return { syncedCount: 0, failedCount: 0, skippedCount: 0, ...p };
}

console.log('\n--- [SYNC MESSAGE] A worker is never told "done" while work is stranded ---');

// 1. The bug: everything left the queue only by exhausting its retries.
const deadLettered = buildSyncMessage(counts({ syncedCount: 0, skippedCount: 2 }), true);
assert(
  !/tamamlandı/i.test(deadLettered) && !/✅/.test(deadLettered),
  `stranded audits are never reported as completed (got "${deadLettered}")`,
);
assert(
  deadLettered.includes('2'),
  `the worker is told how many audits are stranded (got "${deadLettered}")`,
);

// 2. Partial success plus stragglers must not read as a clean success either —
//    this is the branch the old code got wrong, because it only looked at
//    syncedCount and failedCount and never at skippedCount.
const partial = buildSyncMessage(counts({ syncedCount: 3, skippedCount: 1 }), true);
assert(
  !/^\s*✅/.test(partial),
  `a partial sync with stranded items does not claim success (got "${partial}")`,
);
assert(
  partial.includes('3') && partial.includes('1'),
  `a partial sync reports both what landed and what is stuck (got "${partial}")`,
);

// 3. The real success case still succeeds, or the fix would be "safe" only by
//    making the button useless.
const clean = buildSyncMessage(counts({ syncedCount: 4 }), false);
assert(
  clean.includes('4') && clean.startsWith('✅'),
  `a clean sync still reports success plainly (got "${clean}")`,
);

// 4. Retryable failures keep their existing wording.
const retryable = buildSyncMessage(counts({ syncedCount: 1, failedCount: 2 }), false);
assert(
  retryable.includes('alınmadı'),
  `a retryable failure still tells the worker to retry (got "${retryable}")`,
);

// 5. An empty queue is not an error.
assert(
  buildSyncMessage(counts({ reason: 'nothing-pending' }), false) === 'Göndəriləcək audit yoxdur.',
  'an empty queue says there is nothing to send',
);

// 6. `hasStrandedItems` must be honoured even when the counts look clean — the
//    caller holding the counts cannot see the queue, so this is the only place
//    the information exists.
const hidden = buildSyncMessage(counts({ syncedCount: 2 }), true);
assert(
  /yığın|əl ilə/.test(hidden),
  `a stranded item is reported even when the counters look clean (got "${hidden}")`,
);

console.log(`\n${passed}/${passed + failed} sync-message checks passed`);
if (failed > 0) process.exit(1);
