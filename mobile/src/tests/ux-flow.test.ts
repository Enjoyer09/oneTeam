import assert from 'node:assert/strict';
import { ChecklistDrafts } from '../services/checklistDrafts';
import { answerError, answerValue } from '../utils/checklist';
import { AuditHistoryController } from '../screens/AuditHistoryScreen';
import { CameraAuditController } from '../screens/CameraAuditScreen';
import { mobileApi } from '../services/portalApi';
import { offlineQueueService } from '../services/offlineQueue';
import type { MobileStore, MobileTask, AuditMetadata } from '../types';

async function main() {
  let disk: string | null = null;
  const storage = {
    getItem: async () => disk,
    setItem: async (_key: string, value: string) => {
      disk = value;
    },
  };
  const drafts = new ChecklistDrafts();
  await drafts.initialize(storage);
  await Promise.all([drafts.save('s', 't', { q: 'old' }), drafts.save('s', 't', { q: 'new' })]);
  const reopened = new ChecklistDrafts();
  await reopened.initialize(storage);
  assert.equal(reopened.get('s', 't').q, 'new');
  assert.deepEqual(reopened.get('other-store', 't'), {});
  await reopened.clear('s', 't');
  const afterSubmit = new ChecklistDrafts();
  await afterSubmit.initialize(storage);
  assert.deepEqual(afterSubmit.get('s', 't'), {});
  let failWrite = true;
  const resilient = new ChecklistDrafts();
  await resilient.initialize({
    getItem: async () => null,
    setItem: async () => {
      if (failWrite) throw new Error('disk full');
    },
  });
  await assert.rejects(resilient.save('s', 't', { q: 'saved in memory' }));
  assert.equal(resilient.get('s', 't').q, 'saved in memory');
  failWrite = false;
  await resilient.save('s', 't', { q: 'retry' });
  const number = { id: 'n', type: 'number' as const, minValue: 0, maxValue: 10 };
  assert.equal(answerError(number, '3,5'), null);
  assert.equal(answerValue(number, '3,5'), 3.5);
  assert.ok(answerError(number, '11'));
  assert.ok(answerError(number, '0x10'));
  assert.equal(answerError({ id: 'b', type: 'boolean' }, 'false'), null);
  assert.equal(answerValue({ id: 'b', type: 'boolean' }, 'false'), false);
  assert.equal(answerError({ ...number, required: false }, ''), null);
  assert.ok(answerError({ id: 'c', type: 'single_choice', options: ['A'] }, 'B'));

  const original = {
    ack: mobileApi.acknowledgeTask,
    upload: mobileApi.uploadPhoto,
    submit: mobileApi.submitAudit,
  };
  const metadata = {
    checklist_answers: [{ questionId: 'n', value: 3.5 }],
    gps: { latitude: 40, longitude: 49 },
    distance_from_store_meters: 0,
  } as AuditMetadata;
  const controller = new CameraAuditController(
    { id: 'ux-task' } as MobileTask,
    { id: 'ux-store' } as MobileStore,
  );
  let received: unknown;
  mobileApi.acknowledgeTask = async () => ({ advanced: false }) as never;
  mobileApi.uploadPhoto = async () =>
    ({ photoUrl: 'data:image/jpeg;base64,test', origin: 'inline' }) as never;
  mobileApi.submitAudit = async (params) => {
    received = params.checklistAnswers;
    return { id: 'submission' } as never;
  };
  try {
    offlineQueueService.setOnlineStatus(true);
    await controller.processAuditSubmission({
      photoUri: 'camera://test',
      base64: 'test',
      metadata,
    });
    assert.deepEqual(received, metadata.checklist_answers);
    offlineQueueService.setOnlineStatus(false);
    const queued = await controller.processAuditSubmission({
      photoUri: 'camera://test',
      base64: 'test',
      metadata,
    });
    assert.deepEqual(queued.queueItem?.metadata.checklist_answers, metadata.checklist_answers);
    received = undefined;
    new AuditHistoryController();
    offlineQueueService.setOnlineStatus(true);
    await offlineQueueService.autoSync;
    assert.deepEqual(received, metadata.checklist_answers);
    assert.equal(offlineQueueService.getQueue().length, 0);
  } finally {
    mobileApi.acknowledgeTask = original.ack;
    mobileApi.uploadPhoto = original.upload;
    mobileApi.submitAudit = original.submit;
  }
  console.log(
    'UX: draft restoration/isolation/clear, checklist validation, online and offline answer transport passed.',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
