/**
 * oneTeam Retail Execution Platform — Integration Test Suite
 * Modeled after Salesforce Consumer Goods Cloud & GoSpotCheck.
 *
 * Verifies:
 * 1. Strict Task State Machine (Valid path & Invalid transition rejection with 400 Bad Request).
 * 2. Notification Outbox (a transition reports what it queued, and never claims a send it did not make).
 * 3. Telegram Webhook Callback handling (Moving status to ACKNOWLEDGED & audit logging).
 * 4. Anti-Fraud Geofencing & Evidence Submission (Accepting <= 100m, Rejecting > 100m).
 *
 * Delivery of a queued notification is NOT covered here: this suite has no
 * database and no bot. It is covered in `notifications.spec.ts`.
 */

import 'reflect-metadata';
import { TaskState, UserRole } from '@oneteam/types';
import { db } from '@oneteam/database';
import { NotificationDispatcherService } from '../src/modules/notifications/notification-dispatcher.service';
import { TaskStateService } from '../src/modules/tasks/task-state.service';
import { WebhookController } from '../src/modules/notifications/webhook.controller';
import { EvidenceService } from '../src/modules/evidences/evidence.service';
import { AuthenticatedPrincipal } from '../src/common/auth/authenticated-principal';

/**
 * THIS SUITE FIXES ITS OWN ENVIRONMENT, OR IT IS NOT A TEST.
 *
 * WHY
 * ---
 * Suite 3b asserts that production REFUSES the webhook when no secret is
 * configured — that is `assertTrustedSender`'s fail-closed branch, and it is
 * the behaviour worth having. To reach it the suite sets
 * `process.env.NODE_ENV = 'production'` and deletes
 * `TELEGRAM_WEBHOOK_SECRET` (lines ~391-392).
 *
 * But suite 3 calls `handleTelegramWebhook` BEFORE that, with no secret
 * configured. Outside production that is fine — it logs a warning and returns.
 * Inside production the same call throws 503, and because nothing wraps suite 3
 * the rejection escapes `runTestSuite`, so every later suite — including the
 * self-approval guard — never runs at all.
 *
 * Observed, not theorised: with `NODE_ENV=production` in the ambient
 * environment this file exits 1 with "Webhook is not configured" at the suite 3
 * call, 5 runs out of 5. With `NODE_ENV` unset or `development` it exits 0.
 * The suite therefore reported green in one environment and aborted in another,
 * which is exactly the kind of gate that teaches people to ignore it.
 *
 * A test that inherits the developer's shell is not hermetic. This suite pins
 * what it needs, and restores exactly what it changed — in a `finally`, so a
 * failing assertion cannot leave the environment poisoned for the next suite.
 */
const AMBIENT_NODE_ENV = process.env.NODE_ENV;
const AMBIENT_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

process.env.NODE_ENV = 'test';
process.env.TELEGRAM_WEBHOOK_SECRET = 'integration-suite-webhook-secret';

function restoreEnvironment(): void {
  if (AMBIENT_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = AMBIENT_NODE_ENV;
  if (AMBIENT_WEBHOOK_SECRET === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = AMBIENT_WEBHOOK_SECRET;
}

/**
 * Test principals.
 *
 * WHY THIS EXISTS
 * ---------------
 * `transitionTask` takes an `AuthenticatedPrincipal` object, not a user-id
 * string. The original suite passed bare strings, so the authorisation layer
 * saw an undefined user, rejected the call with 403, and the suite aborted
 * before reaching its summary — meaning suites 2–4 never executed.
 *
 * TypeScript would have caught this immediately, but apps/api/tsconfig.json
 * only included `src/**`, so the test directory was never type-checked.
 * That include has since been widened.
 *
 * Roles are the real values from packages/database/src/seed.ts.
 */
const PRINCIPALS = {
  admin: { userId: 'usr-admin-001', role: UserRole.ADMIN },
  supervisor: { userId: 'usr-super-002', role: UserRole.SUPERVISOR },
  merchandiser: { userId: 'usr-merch-003', role: UserRole.MERCHANDISER },
  /** Used for automatic transitions the system performs on its own behalf. */
  system: { userId: 'system', role: UserRole.ADMIN },
} satisfies Record<string, AuthenticatedPrincipal>;

async function runTestSuite() {
  console.log('========================================================================');
  console.log('  🧪 STARTING ONETEAM ENTERPRISE CORE ENGINE INTEGRATION TESTS');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      if (details) console.error(`     Details: ${details}`);
    }
  }

  const notificationService = new NotificationDispatcherService();
  const taskStateService = new TaskStateService(notificationService);
  const webhookController = new WebhookController(taskStateService);
  const evidenceService = new EvidenceService(taskStateService);

  // --------------------------------------------------------------------------
  // SUITE 1: STRICT STATE MACHINE VALIDATION
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST SUITE 1] Strict State Machine Transitions & Rejections ---');

  // Create clean test task in DRAFT
  const testTaskId = `test-task-${Date.now()}`;
  db.storeTasks.push({
    id: testTaskId,
    templateId: 'tmpl-cooler-check',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.DRAFT,
    deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 1.1 Illegal direct jump: DRAFT -> SUBMITTED (Must be rejected with 400 Bad Request)
  let rejectedIllegalJump = false;
  try {
    await taskStateService.transitionTask(testTaskId, TaskState.SUBMITTED, PRINCIPALS.admin);
  } catch (err: any) {
    rejectedIllegalJump =
      err?.status === 400 || err?.statusCode === 400 || err?.response?.success === false;
  }
  assert(
    rejectedIllegalJump,
    'Test 1.1: Illegal transition DRAFT -> SUBMITTED is blocked with 400 Bad Request',
  );

  // 1.2 Illegal jump: DRAFT -> APPROVED (Must be blocked)
  let rejectedJumpApproved = false;
  try {
    await taskStateService.transitionTask(testTaskId, TaskState.APPROVED, PRINCIPALS.admin);
  } catch (err: any) {
    rejectedJumpApproved =
      err?.status === 400 || err?.statusCode === 400 || err?.response?.success === false;
  }
  assert(
    rejectedJumpApproved,
    'Test 1.2: Illegal transition DRAFT -> APPROVED is blocked with 400 Bad Request',
  );

  // 1.3 Legal full lifecycle progression:
  // DRAFT -> PUBLISHED -> DELIVERED -> ACKNOWLEDGED -> IN_PROGRESS -> SUBMITTED -> APPROVED
  const pubRes = await taskStateService.transitionTask(
    testTaskId,
    TaskState.PUBLISHED,
    PRINCIPALS.supervisor,
  );
  assert(
    pubRes.currentState === TaskState.PUBLISHED,
    'Test 1.3: Legal transition DRAFT -> PUBLISHED succeeds',
  );

  const delRes = await taskStateService.transitionTask(
    testTaskId,
    TaskState.DELIVERED,
    PRINCIPALS.system,
  );
  assert(
    delRes.currentState === TaskState.DELIVERED,
    'Test 1.4: Legal transition PUBLISHED -> DELIVERED succeeds',
  );

  const ackRes = await taskStateService.transitionTask(
    testTaskId,
    TaskState.ACKNOWLEDGED,
    PRINCIPALS.merchandiser,
  );
  assert(
    ackRes.currentState === TaskState.ACKNOWLEDGED,
    'Test 1.5: Legal transition DELIVERED -> ACKNOWLEDGED succeeds',
  );

  const progRes = await taskStateService.transitionTask(
    testTaskId,
    TaskState.IN_PROGRESS,
    PRINCIPALS.merchandiser,
  );
  assert(
    progRes.currentState === TaskState.IN_PROGRESS,
    'Test 1.6: Legal transition ACKNOWLEDGED -> IN_PROGRESS succeeds',
  );

  const subRes = await taskStateService.transitionTask(
    testTaskId,
    TaskState.SUBMITTED,
    PRINCIPALS.merchandiser,
  );
  assert(
    subRes.currentState === TaskState.SUBMITTED,
    'Test 1.7: Legal transition IN_PROGRESS -> SUBMITTED succeeds',
  );

  const appRes = await taskStateService.transitionTask(
    testTaskId,
    TaskState.APPROVED,
    PRINCIPALS.supervisor,
  );
  assert(
    appRes.currentState === TaskState.APPROVED,
    'Test 1.8: Legal transition SUBMITTED -> APPROVED succeeds (Final approval)',
  );

  // 1.9 Terminal state violation: APPROVED -> DRAFT
  let rejectedTerminal = false;
  try {
    await taskStateService.transitionTask(testTaskId, TaskState.DRAFT, PRINCIPALS.supervisor);
  } catch (err: any) {
    rejectedTerminal = err?.status === 400 || err?.statusCode === 400;
  }
  assert(rejectedTerminal, 'Test 1.9: Terminal state APPROVED cannot transition to DRAFT');

  // --------------------------------------------------------------------------
  // SUITE 2: THE NOTIFICATION OUTBOX
  //
  // WHAT THIS SUITE USED TO PROVE, AND WHY IT NO LONGER CAN
  // ------------------------------------------------------
  // Three assertions lived here, and all three passed against a service that
  // sent nothing:
  //
  //   - `notificationsDispatched.telegram === true` — a boolean the dispatcher
  //     returned as `true` unconditionally, after pushing a payload into an
  //     array in its own process memory
  //   - a `[✅ Qəbul Et]` button with `callback_data: ack_task_<id>` and an
  //     `oneteam://` deep link — read back out of that array
  //   - an APNs push payload, likewise, for a mobile client with no
  //     registration and no push permission
  //
  // The array was the whole of the "dispatch". Nothing left the process, and
  // the array was emptied by every deploy. So this suite asserted the shape of
  // a fabrication, which is the one thing it could do — it has no database, and
  // a notification now lives in one.
  //
  // What remains here is the honest half: the API must not claim to have sent
  // anything. With no database there is no outbox at all, and it says so.
  // Delivery itself is proven in `notifications.spec.ts`, which runs against a
  // real database and the real bot.
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST SUITE 2] Notification Outbox ---');

  const notifyTaskId = `notify-task-${Date.now()}`;
  db.storeTasks.push({
    id: notifyTaskId,
    templateId: 'tmpl-cooler-check',
    storeId: 'str-araz-ganjlik',
    assignedUserId: 'usr-merch-003',
    status: TaskState.DRAFT,
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Transition to PUBLISHED is the trigger.
  const notifyTransitionRes = await taskStateService.transitionTask(
    notifyTaskId,
    TaskState.PUBLISHED,
    PRINCIPALS.supervisor,
  );

  assert(
    notifyTransitionRes.notificationsDispatched?.outcome === 'no-queue',
    'Test 2.1: Transition to PUBLISHED reports no notification queued when there is no database',
    `outcome was ${notifyTransitionRes.notificationsDispatched?.outcome}`,
  );

  assert(
    notifyTransitionRes.success === true &&
      notifyTransitionRes.currentState === TaskState.PUBLISHED,
    'Test 2.2: A missing outbox does not fail the transition itself',
  );

  // --------------------------------------------------------------------------
  // SUITE 3: TELEGRAM WEBHOOK TASK ACKNOWLEDGEMENT
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST SUITE 3] Telegram Webhook Callback & Database Update ---');

  const webhookUpdate = {
    update_id: 1002003,
    callback_query: {
      id: 'cbq-test-1',
      from: {
        id: 998877665,
        first_name: 'Eldar',
        username: 'eldar_coke',
      },
      message: {
        message_id: 888,
        chat: { id: 998877665 },
      },
      data: `ack_task_${notifyTaskId}`,
    },
  };

  // The suite pinned a webhook secret at startup, so this legitimate call must
  // present it — a real Telegram request always carries the secret_token it was
  // registered with. Omitting it here is what made this call 401 once the
  // suite stopped relying on an unconfigured secret to pass by default.
  const webhookResult = await webhookController.handleTelegramWebhook(
    webhookUpdate,
    'integration-suite-webhook-secret',
  );
  assert(
    webhookResult.ok === true && webhookResult.status === TaskState.ACKNOWLEDGED,
    'Test 3.1: Telegram Webhook [✅ Qəbul Et] callback returns success & ACKNOWLEDGED',
  );

  const updatedNotifyTask = db.getTask(notifyTaskId);
  assert(
    updatedNotifyTask?.status === TaskState.ACKNOWLEDGED,
    'Test 3.2: StoreTask status in database is updated to ACKNOWLEDGED',
  );

  const auditAcknowledged = db.auditLogs.some(
    (log) => log.entityId === notifyTaskId && log.action === 'TELEGRAM_ACKNOWLEDGED',
  );
  assert(
    auditAcknowledged,
    'Test 3.3: Telegram acknowledgment event is immutably logged in audit_logs',
  );

  // --------------------------------------------------------------------------
  // SUITE 3b: WEBHOOK SENDER VERIFICATION
  //
  // The webhook is reachable by anyone who knows the URL. Without sender
  // verification, a forged callback can move a task through its state machine
  // and write an arbitrary actor into audit_logs — which makes the audit trail
  // actively misleading rather than merely incomplete.
  //
  // These tests prove the endpoint refuses to do that, and that it fails
  // closed when the secret is not configured in production.
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST SUITE 3b] Telegram Webhook Sender Verification ---');

  const WEBHOOK_SECRET = 'test-webhook-secret-abc123';
  const previousSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;

  // A task a forged callback will try — and fail — to acknowledge.
  const forgeTargetId = `forge-target-${Date.now()}`;
  db.storeTasks.push({
    id: forgeTargetId,
    templateId: 'tmpl-cooler-check',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.DELIVERED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const forgedUpdate = {
    update_id: 9001,
    callback_query: {
      id: 'cbq-forged',
      from: { id: 998877665, first_name: 'Eldar', username: 'eldar_coke' },
      message: { message_id: 1, chat: { id: 998877665 } },
      data: `ack_task_${forgeTargetId}`,
    },
  };

  // With a secret configured, an attacker who does not know it must be refused.
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;

  let wrongSecretStatus: number | undefined;
  try {
    await webhookController.handleTelegramWebhook(forgedUpdate, 'not-the-right-secret');
  } catch (err: any) {
    wrongSecretStatus = err?.status ?? err?.statusCode;
  }
  assert(
    wrongSecretStatus === 401,
    `Test 3b.1: Forged callback with an invalid secret token is rejected with 401 (got ${wrongSecretStatus})`,
  );

  assert(
    db.getTask(forgeTargetId)?.status === TaskState.DELIVERED,
    'Test 3b.2: Rejected forged callback did not move the task through its state machine',
  );

  let missingHeaderStatus: number | undefined;
  try {
    await webhookController.handleTelegramWebhook(forgedUpdate);
  } catch (err: any) {
    missingHeaderStatus = err?.status ?? err?.statusCode;
  }
  assert(
    missingHeaderStatus === 401,
    `Test 3b.3: Callback with no secret header at all is rejected with 401 (got ${missingHeaderStatus})`,
  );

  // The genuine caller, presenting the right secret, still works.
  const verifiedResult = await webhookController.handleTelegramWebhook(
    forgedUpdate,
    WEBHOOK_SECRET,
  );
  assert(
    verifiedResult.ok === true && db.getTask(forgeTargetId)?.status === TaskState.ACKNOWLEDGED,
    'Test 3b.4: Callback with the correct secret token is accepted and acknowledged',
  );

  // A valid secret does not make an unknown Telegram account trustworthy.
  let unknownAccountStatus: number | undefined;
  try {
    await webhookController.handleTelegramWebhook(
      {
        ...forgedUpdate,
        callback_query: {
          ...forgedUpdate.callback_query,
          from: { id: 111222333, first_name: 'Stranger', username: 'stranger' },
        },
      },
      WEBHOOK_SECRET,
    );
  } catch (err: any) {
    unknownAccountStatus = err?.status ?? err?.statusCode;
  }
  assert(
    unknownAccountStatus === 403,
    `Test 3b.5: Callback from an unregistered Telegram account is refused with 403 (got ${unknownAccountStatus})`,
  );

  // Fail closed: production without a configured secret must refuse everything,
  // not quietly accept unverified requests.
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.NODE_ENV = 'production';

  let unconfiguredStatus: number | undefined;
  try {
    await webhookController.handleTelegramWebhook(forgedUpdate, 'anything');
  } catch (err: any) {
    unconfiguredStatus = err?.status ?? err?.statusCode;
  }
  assert(
    unconfiguredStatus === 503,
    `Test 3b.6: Production with no configured webhook secret fails closed with 503 (got ${unconfiguredStatus})`,
  );

  // Restore what 3b changed, back to the values THIS SUITE pinned at startup —
  // not to whatever the developer's shell happened to hold. Restoring to
  // `previousSecret`/`previousNodeEnv` would undo the isolation above and
  // leave production mode armed for suite 4.
  process.env.TELEGRAM_WEBHOOK_SECRET = 'integration-suite-webhook-secret';
  process.env.NODE_ENV = 'test';
  void previousSecret;
  void previousNodeEnv;

  // --------------------------------------------------------------------------
  // SUITE 4: ANTI-FRAUD GEOFENCING & EVIDENCE SUBMISSION
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST SUITE 4] Anti-Fraud Geofencing (<100m) & Evidence Submission ---');

  // Store: Bravo Yasamal (Lat: 40.385012, Lon: 49.810541)
  const yasamalTask = `geofence-task-${Date.now()}`;
  db.storeTasks.push({
    id: yasamalTask,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 4.1 Valid inside store (12 meters away: 40.385050, 49.810600)
  const validInsideRes = await evidenceService.submitEvidence(
    {
      storeTaskId: yasamalTask,
      photoUrl: 'https://images.unsplash.com/photo-coke-shelf-perfect.jpg',
      latitude: 40.38505,
      longitude: 49.8106,
      aiScore: 95,
      aiSummary: '✅ Planogram Uyğunluğu: 95%',
      checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
    },
    PRINCIPALS.merchandiser,
  );

  assert(
    validInsideRes.success === true &&
      validInsideRes.distanceMeters <= 100 &&
      validInsideRes.evidence.gpsDistanceMeters <= 100,
    `Test 4.1: Evidence submission inside store perimeter accepted (${validInsideRes.distanceMeters}m)`,
  );

  const yasamalTaskAfter = db.getTask(yasamalTask);
  assert(
    yasamalTaskAfter?.status === TaskState.SUBMITTED,
    'Test 4.2: StoreTask advances to SUBMITTED upon evidence verification',
  );

  // 4.2 Fake audit / Out of geofence (1350 meters away: 40.375000, 49.825000)
  const outTask = `geofence-fail-task-${Date.now()}`;
  db.storeTasks.push({
    id: outTask,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  let geofenceBlocked = false;
  let blockedDistance = 0;
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: outTask,
        photoUrl: 'https://images.unsplash.com/photo-fake-audit.jpg',
        latitude: 40.375,
        longitude: 49.825, // ~1.6km away
        checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    geofenceBlocked = err?.status === 400 || err?.statusCode === 400;
    blockedDistance = err?.response?.distanceMeters || 0;
  }

  assert(
    geofenceBlocked && blockedDistance > 100,
    `Test 4.3: Anti-fraud engine blocks evidence submission outside store perimeter (${blockedDistance}m > 100m)`,
  );

  const auditGeofenceViolation = db.auditLogs.some(
    (log) => log.entityId === outTask && log.action === 'GEOFENCE_REJECTION',
  );
  assert(
    auditGeofenceViolation,
    'Test 4.4: Geofence violation is logged in audit_logs as security incident',
  );

  // --------------------------------------------------------------------------
  // SUITE 5: SELF-APPROVAL IS REFUSED (a merchandiser must not review their own work)
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST SUITE 5] Self-Approval Guard ---');

  // WHY THIS SUITE EXISTS
  // ---------------------
  // `requireReviewer` in portal.service.ts documents, at length, why the
  // MERCHANDISER-of-the-task can be the AUTHOR of the submission being judged:
  // enrolment hands a store's open work to whoever enrolled, so the assignee is
  // the author. That guard protects `reviewSubmission`.
  //
  // But `POST /api/tasks/:id/transition` reaches the SAME state change through
  // `transitionTask`, which authorised on reachability only — and a MERCHANDISER
  // can reach exactly their own task (`canUserAccessTask`). The route is not
  // under /api/portal/ or /api/panel/, so `isSupervisorRoute()` returns false and
  // `mayUseRoute()` short-circuits to true for every credential type.
  //
  // The result was a complete bypass: self-approval, and — because the
  // LOCATION_MOCK_OVERRIDE event is only written by `reviewSubmission` — a
  // mocked-GPS self-approval left no override trail at all.
  //
  // These two tests are the guard for that hole. Per the repo's own test
  // philosophy (HANDOFF §4), the first of them was written against the broken
  // code and watched fail with a 200.
  const selfTask = `self-approve-task-${Date.now()}`;
  db.storeTasks.push({
    id: selfTask,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.SUBMITTED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  let selfApprovalStatus: number | undefined;
  try {
    await taskStateService.transitionTask(selfTask, TaskState.APPROVED, PRINCIPALS.merchandiser);
  } catch (err: any) {
    selfApprovalStatus = err?.status ?? err?.statusCode;
  }
  assert(
    selfApprovalStatus === 403,
    `Test 5.1: A merchandiser cannot APPROVE their own submission (got ${selfApprovalStatus})`,
  );

  // The refusal must actually hold the task — a 403 that still advanced the
  // state would leave the audit approved with the error reported as thrown.
  assert(
    db.getTask(selfTask)?.status === TaskState.SUBMITTED,
    'Test 5.2: Refused self-approval leaves the task in SUBMITTED',
  );

  // A supervisor must still be able to close the very same task, or the fix
  // above would be "safe" only because it broke approvals entirely.
  //
  // Read the task fresh: once the guard works, the merchandiser's attempt above
  // will have left it in SUBMITTED, and this transition is then the supervisor
  // doing the approval the merchandiser was refused. While the hole is still
  // open that same attempt has already moved the task to APPROVED — a terminal
  // state — and this call then correctly fails 400. That 400 is the exploit
  // reproducing, not the fix being wrong, so the assertion says so.
  const supervisorTask = `supervisor-approve-task-${Date.now()}`;
  db.storeTasks.push({
    id: supervisorTask,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.SUBMITTED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  let supervisorApprovalStatus: number | undefined;
  try {
    await taskStateService.transitionTask(
      supervisorTask,
      TaskState.APPROVED,
      PRINCIPALS.supervisor,
    );
    supervisorApprovalStatus = 200;
  } catch (err: any) {
    supervisorApprovalStatus = err?.status ?? err?.statusCode;
  }
  assert(
    supervisorApprovalStatus === 200 && db.getTask(supervisorTask)?.status === TaskState.APPROVED,
    `Test 5.3: A supervisor CAN still approve a submitted task (got ${supervisorApprovalStatus})`,
  );

  // A merchandiser moving their OWN task forward through the states they are
  // legitimately responsible for must keep working — the guard is about REVIEW,
  // not about the whole transition endpoint.
  const merchProgressTask = `merch-progress-task-${Date.now()}`;
  db.storeTasks.push({
    id: merchProgressTask,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  let merchProgressStatus: number | undefined;
  try {
    await taskStateService.transitionTask(
      merchProgressTask,
      TaskState.IN_PROGRESS,
      PRINCIPALS.merchandiser,
    );
    merchProgressStatus = 200;
  } catch (err: any) {
    merchProgressStatus = err?.status ?? err?.statusCode;
  }
  assert(
    merchProgressStatus === 200,
    `Test 5.4: A merchandiser can still advance their own task ACKNOWLEDGED -> IN_PROGRESS (got ${merchProgressStatus})`,
  );

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n------------------------------------------------------------------------');
  console.log(
    `  📊 CORE ENGINE TEST RESULTS: ${passed}/${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`,
  );
  console.log('------------------------------------------------------------------------\n');

  if (passed !== total) {
    process.exitCode = 1;
  }
}

runTestSuite()
  .catch((err) => {
    console.error('❌ Integration test execution failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Unconditional. A suite that threw half way through must not leave
    // NODE_ENV=production armed for whatever runs next in this process — that
    // was the mechanism behind the intermittent failure documented above.
    restoreEnvironment();
  });
