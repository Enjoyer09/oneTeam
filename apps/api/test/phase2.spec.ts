/**
 * oneTeam Retail Execution Platform — Phase 2 Integration Test Suite
 *
 * Verifies:
 * 1. Store Segmentation Engine & Bulk Task Dispatcher (Chain/Format/Region filtering, batch creation, notifications, audit trail).
 * 2. Dynamic Checklist Schema Validation (Missing required questions, type checking, option bounds, out-of-range rejection).
 * 3. Before & After Photo Evidence Pipeline (Dual-photo requirement, stage progression, linking before & after to same task).
 */

import 'reflect-metadata';
import { TaskState, UserRole, GEOFENCE_MAX_DISTANCE_METERS } from '@oneteam/types';
import { db } from '@oneteam/database';
import { NotificationDispatcherService } from '../src/modules/notifications/notification-dispatcher.service';
import { TaskStateService } from '../src/modules/tasks/task-state.service';
import { EvidenceService } from '../src/modules/evidences/evidence.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { PortalService } from '../src/modules/portal/portal.service';
import { isAiAutoApproveEligible } from '../src/modules/portal/field.service';
import { AuthenticatedPrincipal } from '../src/common/auth/authenticated-principal';
import { FRESH_FIX_AT } from './helpers/fresh-fix';

/**
 * Test principals — the actor passed to service methods.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bulkDispatchTasks` and `submitEvidence` take an `AuthenticatedPrincipal`
 * as their second argument. The original suites omitted it, so `principal`
 * was `undefined` and every one of these calls threw at runtime
 * (`Cannot read properties of undefined (reading 'userId')`).
 *
 * The compiler reported all fourteen call sites as TS2554, but nothing ran the
 * compiler — there was no CI and no pre-commit hook. Identity must come from
 * the principal, never from the request body.
 */
const PRINCIPALS = {
  admin: { userId: 'usr-admin-001', role: UserRole.ADMIN },
  supervisor: { userId: 'usr-super-002', role: UserRole.SUPERVISOR },
  merchandiser: { userId: 'usr-merch-003', role: UserRole.MERCHANDISER },
} satisfies Record<string, AuthenticatedPrincipal>;

async function runPhase2TestSuite() {
  console.log('========================================================================');
  console.log('  🧪 STARTING ONETEAM PHASE 2 ENTERPRISE INTEGRATION TESTS');
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
  const evidenceService = new EvidenceService(taskStateService, new StorageService());

  // --------------------------------------------------------------------------
  // SUITE 1: STORE SEGMENTATION & BULK TASK DISPATCHER
  // --------------------------------------------------------------------------
  console.log('\n--- [PHASE 2 - SUITE 1] Store Segmentation & Bulk Task Dispatcher ---');

  // 1.1 Dispatch targeting Bravo chain only
  const bravoDispatch = await taskStateService.bulkDispatchTasks(
    {
      templateId: 'tmpl-cooler-check',
      chainName: 'Bravo',
      deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      assignedUserId: 'usr-merch-003',
    },
    PRINCIPALS.supervisor,
  );

  assert(
    bravoDispatch.success === true &&
      bravoDispatch.totalStoresMatched === 1 &&
      bravoDispatch.tasksCreated === 1,
    'Test 1.1: Bulk dispatch filters correctly by chainName ("Bravo" -> 1 store matched & created)',
  );

  const createdBravoTask = db.getTask(bravoDispatch.taskIds[0]);
  assert(
    createdBravoTask !== null &&
      createdBravoTask.status === TaskState.PUBLISHED &&
      createdBravoTask.storeId === 'str-bravo-yasamal',
    'Test 1.2: Created bulk task is automatically PUBLISHED and assigned to Bravo Yasamal',
  );

  const auditLogBravo = db.auditLogs.find(
    (l) => l.entityId === bravoDispatch.taskIds[0] && l.action === 'TASK_BULK_DISPATCHED',
  );
  assert(
    auditLogBravo !== undefined && auditLogBravo.payload?.chainName === 'Bravo',
    'Test 1.3: Bulk dispatch action is immutably recorded in audit_logs',
  );

  // 1.2 Dispatch targeting Supermarket format (Araz + Bazarstore)
  const supermarketDispatch = await taskStateService.bulkDispatchTasks(
    {
      templateId: 'tmpl-eye-level',
      storeFormat: 'supermarket',
      deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      assignedUserId: 'usr-merch-003',
    },
    PRINCIPALS.supervisor,
  );

  assert(
    supermarketDispatch.success === true &&
      supermarketDispatch.totalStoresMatched === 2 &&
      supermarketDispatch.tasksCreated === 2 &&
      // Zero, and that is the assertion. This suite has no database, so there is
      // no outbox to write to and the API says so instead of reporting a message
      // it never queued. The number used to be 2 and meant nothing: it counted
      // pushes onto an array inside the API process that nothing ever read and
      // every deploy emptied.
      supermarketDispatch.notificationsDispatched.queued === 0 &&
      supermarketDispatch.notificationsDispatched.withoutRecipient === 0,
    'Test 1.4: Bulk dispatch filters by storeFormat ("supermarket" -> 2 stores, 2 tasks, 0 notifications queued without a database)',
  );

  // 1.3 Dispatch with no matching criteria
  let noMatchBlocked = false;
  try {
    await taskStateService.bulkDispatchTasks(
      {
        templateId: 'tmpl-cooler-check',
        chainName: 'NonExistentChain99',
        deadline: new Date().toISOString(),
      },
      PRINCIPALS.supervisor,
    );
  } catch (err: any) {
    noMatchBlocked = err?.status === 400 || err?.statusCode === 400;
  }
  assert(noMatchBlocked, 'Test 1.5: Bulk dispatch with no matching stores returns 400 Bad Request');

  // 1.4 Dispatch with invalid template ID
  let invalidTemplateBlocked = false;
  try {
    await taskStateService.bulkDispatchTasks(
      {
        templateId: 'invalid-tmpl-id',
        // A valid assignee is required here, otherwise `bulkDispatchTasks`
        // rejects with 400 (missing/invalid merchandiser) before it ever reaches
        // the template lookup this test is actually about. The original test
        // omitted it and asserted 404, so it could never have passed — the
        // failure was hidden because the missing principal produced 403 first.
        assignedUserId: 'usr-merch-003',
        chainName: 'Bravo',
        deadline: new Date().toISOString(),
      },
      PRINCIPALS.supervisor,
    );
  } catch (err: any) {
    invalidTemplateBlocked = err?.status === 404 || err?.statusCode === 404;
  }
  assert(
    invalidTemplateBlocked,
    'Test 1.6: Bulk dispatch with non-existent template returns 404 Not Found',
  );

  // --------------------------------------------------------------------------
  // SUITE 2: DYNAMIC CHECKLIST SCHEMA VALIDATION
  // --------------------------------------------------------------------------
  console.log('\n--- [PHASE 2 - SUITE 2] Dynamic Checklist Schema Validation ---');

  // Create a clean task for checklist testing
  const checklistTaskId = `task-chk-${Date.now()}`;
  db.storeTasks.push({
    id: checklistTaskId,
    templateId: 'tmpl-cooler-check', // Has 3 required questions: q-temp, q-clean, q-promo-posm
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 2.1 Missing required question (e.g. q-temp omitted)
  let missingQuestionBlocked = false;
  let missingErrorType = '';
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: checklistTaskId,
        photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
        latitude: 40.38505,
        longitude: 49.8106,
        locatedAt: FRESH_FIX_AT(),
        photoType: 'before',
        checklistAnswers: [
          { questionId: 'q-clean', value: true },
          { questionId: 'q-promo-posm', value: 'Mövcuddur və yerləşdirilib' },
        ],
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    missingQuestionBlocked = err?.status === 400 || err?.statusCode === 400;
    missingErrorType = err?.response?.error;
  }
  assert(
    missingQuestionBlocked && missingErrorType === 'MISSING_REQUIRED_CHECKLIST_QUESTION',
    'Test 2.1: Missing required checklist question is blocked with 400 Bad Request',
  );

  // 2.2 Invalid data type: string passed for number question (q-temp)
  let invalidTypeBlocked = false;
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: checklistTaskId,
        photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
        latitude: 40.38505,
        longitude: 49.8106,
        locatedAt: FRESH_FIX_AT(),
        photoType: 'before',
        checklistAnswers: [
          { questionId: 'q-temp', value: 'soyuqdur' as any },
          { questionId: 'q-clean', value: true },
          { questionId: 'q-promo-posm', value: 'Mövcuddur və yerləşdirilib' },
        ],
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    invalidTypeBlocked = err?.status === 400 || err?.statusCode === 400;
  }
  assert(
    invalidTypeBlocked,
    'Test 2.2: Invalid question data type (string instead of number) is blocked with 400',
  );

  // 2.3 Invalid single_choice option
  let invalidChoiceBlocked = false;
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: checklistTaskId,
        photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
        latitude: 40.38505,
        longitude: 49.8106,
        locatedAt: FRESH_FIX_AT(),
        photoType: 'before',
        checklistAnswers: [
          { questionId: 'q-temp', value: 3.5 },
          { questionId: 'q-clean', value: true },
          { questionId: 'q-promo-posm', value: 'İcazəsiz Variant' },
        ],
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    invalidChoiceBlocked = err?.status === 400 || err?.statusCode === 400;
  }
  assert(
    invalidChoiceBlocked,
    'Test 2.3: Invalid single choice option not in schema options is blocked with 400',
  );

  // 2.4 Number out of range (> 15°C)
  let outOfRangeBlocked = false;
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: checklistTaskId,
        photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
        latitude: 40.38505,
        longitude: 49.8106,
        locatedAt: FRESH_FIX_AT(),
        photoType: 'before',
        checklistAnswers: [
          { questionId: 'q-temp', value: 38.0 },
          { questionId: 'q-clean', value: true },
          { questionId: 'q-promo-posm', value: 'Mövcuddur və yerləşdirilib' },
        ],
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    outOfRangeBlocked = err?.status === 400 || err?.statusCode === 400;
  }
  assert(
    outOfRangeBlocked,
    'Test 2.4: Out-of-range numerical checklist answer (38°C > 15°C) is blocked with 400',
  );

  // 2.5 Valid checklist submission
  const validAnswers = [
    { questionId: 'q-temp', value: 3.2 },
    { questionId: 'q-clean', value: true },
    { questionId: 'q-promo-posm', value: 'Mövcuddur və yerləşdirilib' },
  ];

  const validChkRes = await evidenceService.submitEvidence(
    {
      storeTaskId: checklistTaskId,
      photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      latitude: 40.38505,
      longitude: 49.8106,
      locatedAt: FRESH_FIX_AT(),
      photoType: 'before',
      checklistAnswers: validAnswers,
    },
    PRINCIPALS.merchandiser,
  );

  assert(
    validChkRes.success === true &&
      validChkRes.evidence.checklistAnswers?.length === 3 &&
      validChkRes.evidence.checklistAnswers[0].value === 3.2,
    'Test 2.5: Valid checklist submission passes schema validation and answers are saved',
  );

  // --------------------------------------------------------------------------
  // SUITE 3: BEFORE & AFTER PHOTO EVIDENCE PIPELINE
  // --------------------------------------------------------------------------
  console.log('\n--- [PHASE 2 - SUITE 3] Before & After Photo Evidence Pipeline ---');

  const dualPhotoTaskId = `task-dual-${Date.now()}`;
  db.storeTasks.push({
    id: dualPhotoTaskId,
    templateId: 'tmpl-cooler-check', // requiresBeforeAfterPhoto: true
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 3.1 Directly submitting 'after' photo without prior 'before' photo must be blocked
  let missingBeforeBlocked = false;
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: dualPhotoTaskId,
        photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
        photoType: 'after',
        latitude: 40.38505,
        longitude: 49.8106,
        locatedAt: FRESH_FIX_AT(),
        checklistAnswers: validAnswers,
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    missingBeforeBlocked = err?.status === 400 || err?.statusCode === 400;
  }
  assert(
    missingBeforeBlocked,
    'Test 3.1: Submitting "after" photo without initial "before" photo is blocked with 400',
  );

  // 3.2 Submit valid 'before' photo
  const beforeRes = await evidenceService.submitEvidence(
    {
      storeTaskId: dualPhotoTaskId,
      photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      photoType: 'before',
      latitude: 40.38505,
      longitude: 49.8106,
      locatedAt: FRESH_FIX_AT(),
      checklistAnswers: validAnswers,
    },
    PRINCIPALS.merchandiser,
  );

  const taskAfterBefore = db.getTask(dualPhotoTaskId);
  assert(
    beforeRes.success === true &&
      beforeRes.evidence.photoType === 'before' &&
      taskAfterBefore?.status === TaskState.IN_PROGRESS,
    'Test 3.2: Submitting "before" photo transitions task to IN_PROGRESS (not prematurely SUBMITTED)',
  );

  // 3.3 Submit valid 'after' photo
  const afterRes = await evidenceService.submitEvidence(
    {
      storeTaskId: dualPhotoTaskId,
      photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      photoType: 'after',
      latitude: 40.38505,
      longitude: 49.8106,
      locatedAt: FRESH_FIX_AT(),
      aiScore: 96,
      aiSummary: '✅ Planogram uyğunluğu: 96%',
      checklistAnswers: validAnswers,
    },
    PRINCIPALS.merchandiser,
  );

  const taskAfterBoth = db.getTask(dualPhotoTaskId);
  const taskEvidences = db.evidences.filter((e) => e.storeTaskId === dualPhotoTaskId);

  assert(
    afterRes.success === true &&
      afterRes.evidence.photoType === 'after' &&
      taskAfterBoth?.status === TaskState.SUBMITTED &&
      taskEvidences.length === 2 &&
      taskEvidences.some((e) => e.photoType === 'before') &&
      taskEvidences.some((e) => e.photoType === 'after'),
    'Test 3.3: Submitting "after" photo advances task to SUBMITTED; both photos linked to task',
  );

  // --------------------------------------------------------------------------
  // SUITE 4: SPOOFED (MOCK) GPS — HELD FOR REVIEW, SUPERVISOR OVERRIDE
  // --------------------------------------------------------------------------
  console.log('\n--- [PHASE 2 - SUITE 4] Mock-location hold & supervisor override ---');

  // 4.1 The auto-approve gate lets a high, confident, non-mock score through.
  assert(
    isAiAutoApproveEligible({ score: 96, confident: true, locationMocked: false }) === true,
    'Test 4.1: A high, confident, non-mock score is auto-approve eligible',
  );

  // 4.2 THE BLOCK: the same high, confident score does NOT auto-approve when the
  //     fix was flagged mock. This is the whole feature — a spoof can never buy
  //     an auto-pass, however good the photo looks.
  assert(
    isAiAutoApproveEligible({ score: 96, confident: true, locationMocked: true }) === false,
    'Test 4.2: A mock/spoofed fix is NOT auto-approve eligible even at score 96',
  );

  // 4.2b THE OTHER HALF OF THE SAME HOLE — NO FIX AT ALL.
  //
  // `locationMocked` says "this location is a lie". It does NOT cover "there is
  // no location": the Telegram bot offers a skip button, and a skip sends
  // `locationUnverified: true` with no device to report a mock, so the flag
  // arrives false. The API then substitutes the store's own coordinates, which
  // makes the geofence pass by construction.
  //
  // The case below is the exact shape of that submission: score 96, confident,
  // not mocked — identical to 4.1 except that nobody proved where anyone was.
  // Before the `locationUnverified` parameter existed it returned TRUE, so the
  // one channel that cannot prove location was the one channel that never had
  // to. It must be false now.
  assert(
    isAiAutoApproveEligible({
      score: 96,
      confident: true,
      locationMocked: false,
      locationUnverified: true,
    }) === false,
    'Test 4.2b: A submission with NO real fix is NOT auto-approve eligible, even at score 96 and not mocked',
  );

  // 4.2c Both flags together — the realistic mobile case where a device reports
  //     a mock and the channel also has no trustworthy fix.
  assert(
    isAiAutoApproveEligible({
      score: 100,
      confident: true,
      locationMocked: true,
      locationUnverified: true,
    }) === false,
    'Test 4.2c: Mocked AND unverified is held',
  );

  // 4.2d The parameter is optional, so a caller that says nothing is treated as
  //     "verified" — the pre-existing 4.1 behaviour is preserved rather than
  //     silently inverted. This is what keeps the change opt-in and narrow.
  assert(
    isAiAutoApproveEligible({ score: 96, confident: true, locationMocked: false }) === true &&
      isAiAutoApproveEligible({
        score: 96,
        confident: true,
        locationMocked: false,
        locationUnverified: false,
      }) === true,
    'Test 4.2d: Omitting the flag keeps the old behaviour (no silent inversion)',
  );

  // 4.3 Evidence carries the mock flag so the panel can show it and a later
  //     review can be recorded as a deliberate override.
  const mockTaskId = `task-mock-${Date.now()}`;
  db.storeTasks.push({
    id: mockTaskId,
    templateId: 'tmpl-eye-level', // requiresBeforeAfterPhoto: false, one boolean question
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const mockRes = await evidenceService.submitEvidence(
    {
      storeTaskId: mockTaskId,
      photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      photoType: 'standard',
      latitude: 40.38505,
      longitude: 49.8106,
      locatedAt: FRESH_FIX_AT(),
      locationMocked: true,
      checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
    },
    PRINCIPALS.merchandiser,
  );

  const taskAfterMock = db.getTask(mockTaskId);
  assert(
    mockRes.success === true &&
      mockRes.evidence.locationMocked === true &&
      taskAfterMock?.status === TaskState.SUBMITTED,
    'Test 4.3: A mock-flagged submission is stored with locationMocked=true and reaches SUBMITTED (held, not rejected)',
  );

  // 4.4 A non-mock submission stores locationMocked=false (the flag is not sticky).
  const cleanTaskId = `task-clean-${Date.now()}`;
  db.storeTasks.push({
    id: cleanTaskId,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const cleanRes = await evidenceService.submitEvidence(
    {
      storeTaskId: cleanTaskId,
      photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      photoType: 'standard',
      latitude: 40.38505,
      longitude: 49.8106,
      locatedAt: FRESH_FIX_AT(),
      checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
    },
    PRINCIPALS.merchandiser,
  );
  assert(
    cleanRes.evidence.locationMocked === false,
    'Test 4.4: A normal submission stores locationMocked=false',
  );

  // 4.5 Supervisor override: approving a mock submission moves the task to
  //     APPROVED and writes a LOCATION_MOCK_OVERRIDE audit event naming the
  //     reviewer — the anti-fraud hold cannot be lifted without a trail.
  const portalService = new PortalService(taskStateService);
  const overrideDecision = await portalService.reviewSubmission(
    mockRes.evidence.id,
    { status: 'approved', feedback: 'Yoxlandı, işçi tanınır — təsdiqləndi.' },
    PRINCIPALS.supervisor,
  );
  const overrideLogged = db.auditLogs.some(
    (log) => log.action === 'LOCATION_MOCK_OVERRIDE' && log.entityId === mockRes.evidence.id,
  );
  assert(
    overrideDecision.data.currentState === TaskState.APPROVED && overrideLogged,
    'Test 4.5: Supervisor approval of a mock submission moves task to APPROVED and logs LOCATION_MOCK_OVERRIDE',
  );

  // --------------------------------------------------------------------------
  // SUITE 5: GEOFENCE ENFORCEMENT — OUT-OF-PERIMETER SUBMISSIONS ARE REJECTED
  // --------------------------------------------------------------------------
  //
  // Unlike a mock fix (SUITE 4), which is *held* for review because it may still
  // be a real person the device slandered, a fix that lands hundreds of metres
  // from the store is not up for review at all: the worker is demonstrably not
  // there, so there is nothing a supervisor could legitimately override. The
  // server rejects it outright — 400, no evidence row, no state change — and this
  // suite proves that control actually fires, on the coordinates a real audit
  // would carry.
  console.log('\n--- [PHASE 2 - SUITE 5] Geofence enforcement (out-of-perimeter rejection) ---');

  const geoTaskId = `task-geo-${Date.now()}`;
  db.storeTasks.push({
    id: geoTaskId,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal', // seeded at 40.385012, 49.810541
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 5.1 A submission from ~3-4 km away (40.4000, 49.8500 — well past the 100 m
  //     perimeter) is refused with 400 GEOFENCE_VIOLATION.
  let geofenceBlocked = false;
  let geofenceErrorType = '';
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: geoTaskId,
        photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
        photoType: 'standard',
        latitude: 40.4,
        longitude: 49.85,
        locatedAt: FRESH_FIX_AT(),
        checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    geofenceBlocked = err?.status === 400 || err?.statusCode === 400;
    geofenceErrorType = err?.response?.error;
  }
  assert(
    geofenceBlocked && geofenceErrorType === 'GEOFENCE_VIOLATION',
    'Test 5.1: A submission outside the store geofence is blocked with 400 GEOFENCE_VIOLATION',
  );

  // 5.2 The rejection is not silent — it leaves an auditable trail (the reviewer
  //     needs to know an audit was attempted from the wrong place), and it must
  //     NOT have created an evidence row or advanced the task.
  const geofenceRejectionLogged = db.auditLogs.some(
    (log) => log.action === 'GEOFENCE_REJECTION' && log.entityId === geoTaskId,
  );
  const noEvidenceForGeoTask = db.evidences.every((e) => e.storeTaskId !== geoTaskId);
  const geoTaskAfterReject = db.getTask(geoTaskId);
  assert(
    geofenceRejectionLogged &&
      noEvidenceForGeoTask &&
      geoTaskAfterReject?.status === TaskState.ACKNOWLEDGED,
    'Test 5.2: A rejected out-of-geofence attempt is audited, creates no evidence, and does not move the task',
  );

  // 5.3 The same task, submitted from inside the perimeter, is accepted — the
  //     control blocks the fraud without punishing honest work, and the earlier
  //     rejection left the task in a state a real submission can still complete.
  const withinGeoRes = await evidenceService.submitEvidence(
    {
      storeTaskId: geoTaskId,
      photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      photoType: 'standard',
      latitude: 40.38505,
      longitude: 49.8106,
      locatedAt: FRESH_FIX_AT(),
      checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
    },
    PRINCIPALS.merchandiser,
  );
  const geoTaskAfterAccept = db.getTask(geoTaskId);
  assert(
    withinGeoRes.success === true &&
      withinGeoRes.distanceMeters <= GEOFENCE_MAX_DISTANCE_METERS &&
      geoTaskAfterAccept?.status === TaskState.SUBMITTED,
    'Test 5.3: A within-perimeter submission to the same task is accepted and advances to SUBMITTED',
  );

  // --------------------------------------------------------------------------
  // SUITE 6: PHOTO OWNERSHIP — A CLIENT-SUPPLIED URL MUST BE ONE WE MINTED
  // --------------------------------------------------------------------------
  //
  // POST /api/evidences used to write `dto.photoUrl` into the record unchecked,
  // so a caller could submit https://cdn.example/x.png as shelf-compliance
  // evidence. The field path guards this with `ownsPublicUrl`; this suite proves
  // the direct evidence path now applies the same gate, before any state change.
  console.log('\n--- [PHASE 2 - SUITE 6] Photo ownership on the direct evidence path ---');

  const photoTaskId = `task-photo-${Date.now()}`;
  db.storeTasks.push({
    id: photoTaskId,
    templateId: 'tmpl-eye-level',
    storeId: 'str-bravo-yasamal',
    assignedUserId: 'usr-merch-003',
    status: TaskState.ACKNOWLEDGED,
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 6.1 An external URL is refused with 400 PHOTO_UPLOAD_FAILED — no evidence
  //     row, and the task has not advanced.
  let foreignPhotoBlocked = false;
  let foreignPhotoErrorType = '';
  try {
    await evidenceService.submitEvidence(
      {
        storeTaskId: photoTaskId,
        photoUrl: 'https://cdn.example.com/not-our-shelf.png',
        photoType: 'standard',
        latitude: 40.38505,
        longitude: 49.8106,
        locatedAt: FRESH_FIX_AT(),
        checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
      },
      PRINCIPALS.merchandiser,
    );
  } catch (err: any) {
    foreignPhotoBlocked = err?.status === 400 || err?.statusCode === 400;
    foreignPhotoErrorType = err?.response?.error;
  }
  const noEvidenceForPhotoTask = db.evidences.every((e) => e.storeTaskId !== photoTaskId);
  const photoTaskAfterReject = db.getTask(photoTaskId);
  assert(
    foreignPhotoBlocked &&
      foreignPhotoErrorType === 'PHOTO_UPLOAD_FAILED' &&
      noEvidenceForPhotoTask &&
      photoTaskAfterReject?.status === TaskState.ACKNOWLEDGED,
    'Test 6.1: A foreign photo URL is refused with 400, creates no evidence, and does not move the task',
  );

  // 6.2 The same task with an inline data: URL is accepted — the guard blocks
  //     substitution without breaking the supported no-bucket channel.
  const inlinePhotoRes = await evidenceService.submitEvidence(
    {
      storeTaskId: photoTaskId,
      photoUrl: 'data:image/png;base64,iVBORw0KGgo=',
      photoType: 'standard',
      latitude: 40.38505,
      longitude: 49.8106,
      locatedAt: FRESH_FIX_AT(),
      checklistAnswers: [{ questionId: 'q-eye-clean', value: true }],
    },
    PRINCIPALS.merchandiser,
  );
  assert(
    inlinePhotoRes.success === true &&
      inlinePhotoRes.evidence.photoUrl === 'data:image/png;base64,iVBORw0KGgo=',
    'Test 6.2: An inline data: URL submission to the same task is accepted and stored unchanged',
  );

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n------------------------------------------------------------------------');
  console.log(
    `  📊 PHASE 2 TEST RESULTS: ${passed}/${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`,
  );
  console.log('------------------------------------------------------------------------\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runPhase2TestSuite().catch((err) => {
  console.error('❌ Phase 2 test execution failed:', err);
  process.exit(1);
});
