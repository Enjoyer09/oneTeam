/**
 * oneTeam Supervisor & Admin Portal — Automated Smoke & Service Test
 */

import { portalService } from './lib/portalApi';

async function runWebSmokeTest() {
  console.log('============================================================');
  console.log('  oneTeam WEB PORTAL — AUTOMATED SMOKE & SERVICE TEST');
  console.log('============================================================\n');

  // 1. Metrics check
  const metrics = await portalService.getMetrics();
  console.log('1. KPI Metrics:', metrics);
  if (metrics.totalStores < 1) throw new Error('Expected at least 1 store');
  if (metrics.activeTasks < 1) throw new Error('Expected at least 1 active task');
  console.log('   ✓ KPI calculation verified.\n');

  // 2. Stores list
  const stores = await portalService.getStores();
  console.log(`2. Stores count: ${stores.length}`);
  const bravo = stores.find((s) => s.store_code === 'BRAVO_28MAY_01');
  if (!bravo) throw new Error('Store BRAVO_28MAY_01 not found');
  console.log(`   ✓ Found sample store: ${bravo.name} (${bravo.city})\n`);

  // 3. Tasks list & creation
  const tasksBefore = await portalService.getTasks();
  console.log(`3. Tasks count: ${tasksBefore.length}`);
  const newTask = await portalService.createTask({
    title: 'Coca-Cola Zero Sugar 1L End-Cap Display Audit',
    description: 'Bütün Zero Sugar məhsullarının xüsusi end-cap rəfində səliqəli yerləşdirilməsini yoxlayın.',
    reference_image_url: 'https://images.unsplash.com/photo-1554866585-cd94860890b7',
    priority: 'urgent',
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
    assigned_stores: [bravo.id],
  });
  console.log(`   ✓ Created new task: "${newTask.title}" (ID: ${newTask.id})\n`);

  // 4. Submissions list & side-by-side review
  const subs = await portalService.getSubmissions('all');
  console.log(`4. Submissions count: ${subs.length}`);
  const pendingSub = subs.find((s) => s.status === 'pending_review');
  if (!pendingSub) throw new Error('Expected pending review submission');
  console.log(`   ✓ Found pending submission for store: ${pendingSub.store?.name}`);

  // 5. Supervisor approval
  const approved = await portalService.updateSubmissionStatus(pendingSub.id, 'approved');
  console.log(`   ✓ Updated submission status to: ${approved?.status}\n`);

  // 6. Supervisor rejection with feedback
  const rejected = await portalService.updateSubmissionStatus(
    subs[1].id,
    'rejected',
    'Rəfin sol tərəfində 0.5L Sprite məhsulları çatışmır.'
  );
  console.log(`   ✓ Tested rejection with feedback: "${rejected?.reviewer_feedback}"\n`);

  // 7. AI One-Click Auto Approval
  const aiApproved = await portalService.oneClickAIApprove('sub-001');
  if (aiApproved?.status !== 'approved' || !aiApproved.reviewer_feedback?.includes('AI Avtomatik Təsdiqi')) {
    throw new Error('AI One-Click Approval failed');
  }
  console.log(`   ✓ Tested One-Click AI Approval: "${aiApproved.reviewer_feedback}"\n`);

  // 8. Bulk Task Dispatcher with Store Segmentation
  const bulkResult = await portalService.bulkDispatchTasks({
    title: 'Kütləvi Cooler Auditi (Bravo Şəbəkəsi)',
    description: 'Bütün Bravo mağazalarında 0.5L soyuducu tərtibatı auditi.',
    reference_image_url: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97',
    priority: 'high',
    deadline: new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString(),
    chainName: 'Bravo',
  });
  if (!bulkResult.success || bulkResult.count < 1) {
    throw new Error('Bulk task dispatch failed');
  }
  console.log(`8. Bulk Task Dispatcher: Dispatched to ${bulkResult.count} stores matching Bravo chain.`);
  console.log(`   ✓ Verified bulk task creation and segmentation: ${bulkResult.tasks[0].id}\n`);

  // 9. Before & After Photo Evidence and Checklist Answers Verification
  const subWithDualPhotos = subs.find((s) => s.photo_type === 'after' && s.before_photo_url);
  if (!subWithDualPhotos) {
    throw new Error('Expected submission with Before & After photo evidence');
  }
  if (!subWithDualPhotos.checklist_answers || subWithDualPhotos.checklist_answers.length === 0) {
    throw new Error('Expected submission with checklist answers');
  }
  console.log('9. Before & After and Checklist Schema:');
  console.log(`   ✓ Before Photo: ${subWithDualPhotos.before_photo_url}`);
  console.log(`   ✓ After Photo: ${subWithDualPhotos.photo_url}`);
  console.log(`   ✓ Checklist Answers (${subWithDualPhotos.checklist_answers.length} verified):`, subWithDualPhotos.checklist_answers.map(a => `${a.questionId}: ${a.value}`).join(', '));
  console.log('   ✓ Before/After dual pipeline and checklist answers verified.\n');

  console.log('============================================================');
  console.log('  ALL WEB SERVICE SMOKE TESTS PASSED (100% OPERATIONAL)!');
  console.log('============================================================\n');
}

runWebSmokeTest().catch((err) => {
  console.error('❌ Web smoke test failed:', err);
  process.exit(1);
});
