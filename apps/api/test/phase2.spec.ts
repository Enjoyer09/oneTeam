/**
 * oneTeam Retail Execution Platform — Phase 2 Integration Test Suite
 *
 * Verifies:
 * 1. Store Segmentation Engine & Bulk Task Dispatcher (Chain/Format/Region filtering, batch creation, notifications, audit trail).
 * 2. Dynamic Checklist Schema Validation (Missing required questions, type checking, option bounds, out-of-range rejection).
 * 3. Before & After Photo Evidence Pipeline (Dual-photo requirement, stage progression, linking before & after to same task).
 */

import 'reflect-metadata';
import { TaskState, UserRole } from '@oneteam/types';
import { db } from '@oneteam/database';
import { NotificationDispatcherService } from '../src/modules/notifications/notification-dispatcher.service';
import { TaskStateService } from '../src/modules/tasks/task-state.service';
import { EvidenceService } from '../src/modules/evidences/evidence.service';
import { AuthenticatedPrincipal } from '../src/common/auth/authenticated-principal';

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
  const evidenceService = new EvidenceService(taskStateService);

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
        photoUrl: 'https://images.unsplash.com/photo-coke-shelf-1.jpg',
        latitude: 40.38505,
        longitude: 49.8106,
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
        photoUrl: 'https://images.unsplash.com/photo-coke-shelf-1.jpg',
        latitude: 40.38505,
        longitude: 49.8106,
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
        photoUrl: 'https://images.unsplash.com/photo-coke-shelf-1.jpg',
        latitude: 40.38505,
        longitude: 49.8106,
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
        photoUrl: 'https://images.unsplash.com/photo-coke-shelf-1.jpg',
        latitude: 40.38505,
        longitude: 49.8106,
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
      photoUrl: 'https://images.unsplash.com/photo-coke-shelf-before.jpg',
      latitude: 40.38505,
      longitude: 49.8106,
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
        photoUrl: 'https://images.unsplash.com/photo-coke-after-jump.jpg',
        photoType: 'after',
        latitude: 40.38505,
        longitude: 49.8106,
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
      photoUrl: 'https://images.unsplash.com/photo-coke-before-real.jpg',
      photoType: 'before',
      latitude: 40.38505,
      longitude: 49.8106,
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
      photoUrl: 'https://images.unsplash.com/photo-coke-after-real.jpg',
      photoType: 'after',
      latitude: 40.38505,
      longitude: 49.8106,
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
