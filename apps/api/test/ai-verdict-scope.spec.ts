#!/usr/bin/env node
/**
 * The AI verdict is the engine's, never the submitter's.
 * ============================================================================
 *
 * `submitSubmission` accepts `aiScore`/`aiConfidence`/… and a high, confident
 * score auto-approves the evidence past the human-review gate. Those fields are
 * produced by our own vision engine and arrive with the bot's SERVICE credential.
 * A device (or panel) credential resolves to the very person being judged, so
 * letting it set the score would let a merchandiser approve their own work.
 *
 * This drives the real controller with a stub service: the question is not "does
 * the SQL store a score" but "does the route refuse a score from the wrong door".
 */
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@oneteam/types';
import { FieldController } from '../src/modules/portal/field.controller';
import type { FieldService } from '../src/modules/portal/field.service';
import type { AuthenticatedPrincipal } from '../src/common/auth/authenticated-principal';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

let serviceCalls = 0;
const stubService = {
  async submitSubmission() {
    serviceCalls++;
    return { success: true };
  },
} as unknown as FieldService;
const controller = new FieldController(stubService);

const DEVICE_ID = 'dev-test-001';
function request(via: AuthenticatedPrincipal['via']): { principal: AuthenticatedPrincipal } {
  return {
    principal: {
      userId: 'usr-merch-003',
      role: UserRole.MERCHANDISER,
      via,
      deviceId: via === 'device' ? DEVICE_ID : undefined,
    },
  };
}
const baseBody = {
  deviceId: DEVICE_ID,
  storeTaskId: 'strtask-001',
  photoUrl: 'data:image/png;base64,AAAA',
};

async function expectForbidden(label: string, via: AuthenticatedPrincipal['via']): Promise<void> {
  const before = serviceCalls;
  let status = 0;
  try {
    await controller.submitSubmission(request(via) as never, { ...baseBody, aiScore: 99 } as never);
  } catch (error) {
    status = error instanceof ForbiddenException ? error.getStatus() : 0;
  }
  check(
    label,
    status === 403 && serviceCalls === before,
    `status=${status}, calls=${serviceCalls}`,
  );
}

async function main(): Promise<void> {
  console.log('\n=== AI verdict scope ===');

  await expectForbidden('a device token cannot submit an AI verdict', 'device');
  await expectForbidden('a panel key cannot submit an AI verdict', 'panel');

  // A device submitting WITHOUT a verdict is the normal mobile path — allowed.
  const before = serviceCalls;
  await controller.submitSubmission(request('device') as never, { ...baseBody } as never);
  check('a device submission without a verdict reaches the service', serviceCalls === before + 1);

  // The bot (service) legitimately carries the engine's verdict.
  const beforeService = serviceCalls;
  await controller.submitSubmission(
    { principal: { userId: 'usr-admin-001', role: UserRole.ADMIN, via: 'service' } } as never,
    {
      chatId: 12345,
      storeTaskId: 'strtask-001',
      photoUrl: 'data:image/png;base64,AAAA',
      aiScore: 95,
    } as never,
  );
  check('a service credential may carry the AI verdict', serviceCalls === beforeService + 1);

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
