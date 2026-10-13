#!/usr/bin/env node
/**
 * A blocked device must stop authenticating, not just stop enrolling.
 * ============================================================================
 *
 * THE HOLE
 * --------
 * `device_blocks` is written when an operator revokes a device. Two paths
 * consult it:
 *
 *   enrollment.controller.ts:440   isDeviceBlocked()  — refuse a NEW enrolment
 *
 * That is the only one. `AuthGuard.fromDeviceToken` checks only
 * `verifyDeviceToken()`, which asks "does this token exist and is its user
 * alive?" — it never asks whether the device has been blocked.
 *
 * So the sequence is:
 *
 *   1. a phone is enrolled, gets a long-lived device token
 *   2. the phone is stolen
 *   3. the operator blocks the device   -> device_blocks row written
 *   4. the stolen phone keeps working    -> the token is still valid
 *
 * The block does what an operator expects a block to do — it stops the device
 * enrolling again — and nothing else. Revocation without revocation.
 *
 * WHY THIS SUITE INSTEADS OF A DB TEST
 * -----------------------------------
 * `device-block.spec.ts` already covers the enrolment path against a live
 * Postgres, and it passes. The gap is that `AuthGuard` never consults the
 * table at all, which is a statement about the guard's code, not about the
 * database.
 *
 * `verifyDeviceToken` returns null when there is no pool, so a token cannot be
 * authenticated without a database — which means the block cannot be asserted
 * by seeding the in-memory replica. Instead this suite drives `AuthGuard` with
 * `db.verifyDeviceToken` and `db.isDeviceBlocked` stubbed, and asserts which
 * of them the guard calls. That is the honest level for this question: not
 * "is the SQL correct" but "does the auth path ask the question at all".
 */

import { AuthGuard } from '../src/common/auth/auth.guard';
import { db } from '@oneteam/database';

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

// ---------------------------------------------------------------------------
// A stand-in for the two database calls the guard makes. `blockedDeviceIds`
// is the operator's decision; `liveTokens` is what still verifies.
// ---------------------------------------------------------------------------

interface StubDevice {
  userId: string;
  deviceId: string;
  blocked: boolean;
}

const devices: StubDevice[] = [
  { userId: 'usr-merch-003', deviceId: 'dev-live-1', blocked: false },
  { userId: 'usr-merch-003', deviceId: 'dev-blocked-1', blocked: true },
];

const dbStub = {
  async verifyDeviceToken(token: string): Promise<{ userId: string; deviceId: string } | null> {
    const match = devices.find((d) => d.deviceId === token);
    return match ? { userId: match.userId, deviceId: match.deviceId } : null;
  },
  async isDeviceBlocked(deviceId: string): Promise<boolean> {
    return devices.find((d) => d.deviceId === deviceId)?.blocked ?? false;
  },
  async getUserById(id: string): Promise<{ id: string; role: string } | null> {
    if (id !== 'usr-merch-003') return null;
    return { id: 'usr-merch-003', role: 'MERCHANDISER' };
  },
  // Fields fromDeviceToken's failure path may touch; keep them harmless.
  async isPanelKeyRevoked(): Promise<boolean> {
    return false;
  },
  auditLogs: [] as unknown[],
  logAuditEvent(entry: unknown): void {
    this.auditLogs.push(entry);
  },
};

// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log('\n--- [DEVICE BLOCK] A blocked device cannot keep authenticating ---');

  const guard = new AuthGuard();
  // Swap only the database module's surface the guard touches. Every suite in
  // this repo builds services directly against the singleton, so this is the
  // seam the guard has.
  const dbAny = db as any;
  const saved = {
    verifyDeviceToken: dbAny.verifyDeviceToken,
    isDeviceBlocked: dbAny.isDeviceBlocked,
    getUserById: dbAny.getUserById,
    logAuditEvent: dbAny.logAuditEvent,
  };
  dbAny.verifyDeviceToken = dbStub.verifyDeviceToken;
  dbAny.isDeviceBlocked = dbStub.isDeviceBlocked;
  dbAny.getUserById = dbStub.getUserById;
  dbAny.logAuditEvent = dbStub.logAuditEvent;

  try {
    // 1. The regression. A token whose device has been blocked must not
    //    authenticate, even though the token itself is perfectly valid.
    const blockedPrincipal = await guard['fromDeviceToken']('dev-blocked-1');
    check(
      'a token for a BLOCKED device is refused',
      blockedPrincipal === null,
      `got ${JSON.stringify(blockedPrincipal)}`,
    );

    // 2. The control. An unblocked device must still authenticate, or fix 1
    //    would be "safe" only by locking every phone out of the platform.
    const livePrincipal = await guard['fromDeviceToken']('dev-live-1');
    check(
      'an unblocked device still authenticates',
      livePrincipal !== null && livePrincipal.deviceId === 'dev-live-1',
      `got ${JSON.stringify(livePrincipal)}`,
    );

    // 3. The already-working case must not regress: an unknown token is still
    //    refused, because the guard must not have been changed to consult the
    //    block table INSTEAD of verifying the token.
    const unknownPrincipal = await guard['fromDeviceToken']('dev-does-not-exist');
    check('an unknown token is still refused', unknownPrincipal === null);

    // 4. The block table has to be consulted at all. If the guard reached the
    //    right answer without asking, this catches it.
    let asked = 0;
    dbAny.isDeviceBlocked = async (deviceId: string) => {
      asked++;
      return deviceId === 'dev-blocked-1';
    };
    await guard['fromDeviceToken']('dev-blocked-1');
    check('the guard actually asks whether the device is blocked', asked > 0);
  } finally {
    dbAny.verifyDeviceToken = saved.verifyDeviceToken;
    dbAny.isDeviceBlocked = saved.isDeviceBlocked;
    dbAny.getUserById = saved.getUserById;
    dbAny.logAuditEvent = saved.logAuditEvent;
  }

  console.log(`\n${passed}/${passed + failed} device-block checks passed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('❌ device-block suite failed:', err);
  process.exitCode = 1;
});
