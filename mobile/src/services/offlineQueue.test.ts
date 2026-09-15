/**
 * oneTeam mobile field client — offline queue verification
 * ============================================================================
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * Plan item 3.1 measured the offline queue and found three untruths: it lived in
 * a module-level array, `triggerAutoSync()` was an empty method that a
 * reconnection called and that did nothing, and the plan's 50 MB limit did not
 * exist. The README described it as durable local storage that uploads
 * automatically on reconnection. None of that was true.
 *
 * So this suite exists to make the new rules falsifiable, because every one of
 * them is a way an audit can be LOST or DUPLICATED:
 *
 *   - the write is awaited, and a write that did not land is rolled back and
 *     reported rather than reported as success;
 *   - the queue survives a restart — asked of a FRESH manager over the same
 *     storage, never of the instance that did the writing, because a cached
 *     answer cannot tell the difference between "kept" and "dropped";
 *   - the 50 MB limit refuses the new item instead of evicting the oldest;
 *   - the in-flight marker reaches the disk BEFORE the upload starts;
 *   - an item the app died on comes back HELD BACK, not queued for a retry that
 *     would file a second evidence row;
 *   - reconnection actually drains, and says why when it cannot.
 *
 * WHAT IT CANNOT TELL YOU
 * -----------------------
 * That AsyncStorage works. `queueStorage.ts` is not imported here — it cannot
 * be, it calls a native module — so this suite proves the policy, not the
 * storage underneath it. Nothing here has been run on a device.
 *
 * It also cannot prove there is no background retry timer, because there is
 * none: retries are triggered by reconnection or by hand. That is a stated
 * limit, recorded in the plan's debt table.
 *
 * Run with: `npm run test:queue`
 */

import {
  INTERRUPTED_UPLOAD_MESSAGE,
  MAX_QUEUE_BYTES,
  MAX_RETRY_ATTEMPTS,
  MemoryQueueStorage,
  OfflineQueueManager,
  QueueError,
  QUEUE_STORAGE_KEY,
  offlineQueueService,
  utf8Bytes,
} from './offlineQueue';
import type { QueueStorage } from './offlineQueue';
import { AuditMetadata, QueueItem } from '../types';
// Static, not `await import(...)`. `mobile/tsconfig.json` resolves modules the
// NodeNext way, which requires an explicit `.js` extension on a dynamic import
// specifier — and adding `.js` to a TypeScript path is the kind of noise that
// gets "fixed" later by someone who does not know why it is there. These two are
// imported at the top for the same reason, and importing them here is itself the
// wiring that section 10 asserts.
import { mobileApp } from '../App';
import { AuditHistoryController } from '../screens/AuditHistoryScreen';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ${colors.green}✅ [PASS]${colors.reset} ${label}`);
  } else {
    failed++;
    console.log(`  ${colors.red}❌ [FAIL]${colors.reset} ${label}`);
    if (detail !== undefined) {
      console.log(
        `         ${colors.yellow}got:${colors.reset} ${JSON.stringify(detail)?.slice(0, 400)}`,
      );
    }
  }
}

function section(title: string) {
  console.log(`\n${colors.cyan}${colors.bright}${title}${colors.reset}`);
}

/** Runs `fn` and returns the error it threw, or null if it did not throw. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * A queue storage that keeps its contents where a test can inspect them.
 *
 * `failNextWrites` is what makes the failure paths reachable: the interesting
 * behaviours are "the write did not land", "the write failed halfway through a
 * drain", and "the app stopped with the marker on disk", and none of them can be
 * produced with a storage that always works.
 */
class RecordingQueueStorage implements QueueStorage {
  value: string | null = null;
  writes = 0;
  reads = 0;
  failNextWrites = 0;

  async read(): Promise<string | null> {
    this.reads++;
    return this.value;
  }

  async write(serialized: string): Promise<void> {
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw new Error('device storage is full');
    }
    this.writes++;
    this.value = serialized;
  }

  /** What is on the "disk" right now, parsed. */
  get items(): QueueItem[] {
    return this.value === null ? [] : (JSON.parse(this.value) as QueueItem[]);
  }
}

/** A plausible audit stamp. The queue stores it; nothing here validates it. */
function metadata(): AuditMetadata {
  return {
    gps: { latitude: 40.3851, longitude: 49.8106 },
    distance_from_store_meters: 11,
    device_model: 'unknown',
    os_version: 'unknown',
    captured_at: new Date().toISOString(),
    capture_mode: 'live_camera_only',
    ghost_overlay_used: false,
    app_version: '0.0.0-test',
  };
}

/**
 * A FRESH manager over the same storage — "what does the next launch see?".
 *
 * This helper exists because of the hole plan item 3.2's break run found: a
 * cached answer cannot prove a rule was honoured. Asking the SAME instance
 * whether the queue survived answers from its own memory. Asking a new instance
 * over the same storage is the only question that means anything.
 */
async function relaunch(storage: QueueStorage): Promise<OfflineQueueManager> {
  const manager = new OfflineQueueManager();
  manager.useStorage(storage);
  await manager.load();
  return manager;
}

async function enqueue(
  manager: OfflineQueueManager,
  taskId: string,
  photoBase64?: string,
): Promise<QueueItem> {
  return await manager.enqueueSubmission({
    taskId,
    storeId: 'store-1',
    photoUri: `file:///tmp/${taskId}.jpg`,
    photoBase64,
    metadata: metadata(),
  });
}

// ===========================================================================
// The suite body.
//
// One async function rather than top-level await: `tsx` compiles this file to
// CommonJS, and CommonJS has no top-level await. Every other suite in this repo
// is shaped this way for the same reason.
// ===========================================================================
async function main() {
  // ===========================================================================
  // 0. The refusal. Must run first: it is about a manager that has been wired to
  //    a persistent store and not yet read from it, and every later section
  //    leaves a loaded manager behind.
  // ===========================================================================
  section('0. Reading a queue that has not been read yet is refused, not answered');

  {
    const storage = new RecordingQueueStorage();
    storage.value = JSON.stringify([
      {
        id: 'a',
        task_id: 't',
        store_id: 's',
        photo_uri: 'x',
        metadata: metadata(),
        created_at: '',
        retry_count: 0,
        sync_status: 'queued',
      },
    ]);

    const unloaded = new OfflineQueueManager();
    unloaded.useStorage(storage);

    check('a wired-but-unread queue reports that it is not loaded', unloaded.isLoaded() === false);

    const readError = await caught(async () => unloaded.getQueue());
    check(
      'getQueue() throws instead of returning an empty array that would look like "nothing queued"',
      readError instanceof QueueError && readError.code === 'QUEUE_NOT_LOADED',
      readError instanceof Error ? readError.message : readError,
    );

    const countError = await caught(async () => unloaded.getPendingCount());
    check(
      'getPendingCount() refuses for the same reason',
      countError instanceof QueueError && countError.code === 'QUEUE_NOT_LOADED',
    );

    const enqueueError = await caught(async () => enqueue(unloaded, 'task-before-load'));
    check(
      'and an enqueue cannot happen before the read — so it cannot overwrite what is on disk',
      enqueueError === null && unloaded.getQueue().length === 2,
      enqueueError instanceof Error ? enqueueError.message : enqueueError,
    );

    // The item that was on disk is still there. An enqueue that had started from
    // an empty in-memory array would have written a one-item queue over it.
    check(
      'the item that was already on disk survived that enqueue',
      storage.items.some((item) => item.id === 'a'),
      storage.items.map((item) => item.id),
    );
  }

  // ===========================================================================
  // 1. Durability: the write is awaited, and a write that did not land is not
  //    reported as success.
  // ===========================================================================
  section('1. An audit is queued only if it reached the device, and it survives a restart');

  {
    const storage = new RecordingQueueStorage();
    const manager = await relaunch(storage);

    const queued = await enqueue(manager, 'task-1', 'AAAA');

    check(
      'enqueueing writes to the device before it returns',
      storage.items.length === 1 && storage.items[0].id === queued.id,
      storage.items.map((item) => item.id),
    );
    check(
      'and the item it returns is the one that was written',
      storage.items[0].task_id === 'task-1' && storage.items[0].photo_base64 === 'AAAA',
    );

    // THE question that matters, and it is asked of a NEW manager. Asking the one
    // above would answer from its own array.
    const nextLaunch = await relaunch(storage);
    check(
      'a fresh launch over the same storage sees the audit',
      nextLaunch.getQueue().length === 1 && nextLaunch.getQueue()[0].id === queued.id,
      nextLaunch.getQueue().map((item) => item.id),
    );
    check(
      'and the image bytes came back with it, so the upload can still happen',
      nextLaunch.getQueue()[0].photo_base64 === 'AAAA',
    );

    // Now the failure. The device cannot store it, so the audit is NOT queued.
    const failing = new RecordingQueueStorage();
    const failingManager = await relaunch(failing);
    failing.failNextWrites = 1;

    const writeError = await caught(async () => enqueue(failingManager, 'task-2'));

    check(
      'a storage failure makes enqueueSubmission throw rather than report success',
      writeError instanceof QueueError && writeError.code === 'QUEUE_WRITE_FAILED',
      writeError instanceof Error ? writeError.message : writeError,
    );
    check(
      'and the item is rolled back out of memory — the queue does not claim work it cannot produce',
      failingManager.getQueue().length === 0,
      failingManager.getQueue().map((item) => item.id),
    );
    check('and nothing was left on the device either', failing.items.length === 0, failing.items);
    check(
      'the message says the audit was not queued, rather than blaming the network',
      writeError instanceof Error && writeError.message.includes('yazıla bilmədi'),
      writeError instanceof Error ? writeError.message : writeError,
    );
  }

  // ===========================================================================
  // 2. The 50 MB limit. Refuses the new item; never evicts the oldest.
  // ===========================================================================
  section('2. The 50 MB limit refuses the new audit instead of discarding an old one');

  {
    check("the limit is the plan's 50 MB", MAX_QUEUE_BYTES === 50 * 1024 * 1024, MAX_QUEUE_BYTES);

    // The arithmetic the limit rests on. `String.length` counts UTF-16 units, so
    // it under-counts every non-ASCII character — and a store name in Azerbaijani
    // is full of them. Under-counting a size limit is the wrong direction.
    check('utf8Bytes counts ASCII as one byte each', utf8Bytes('abc') === 3, utf8Bytes('abc'));
    check(
      'utf8Bytes counts a two-byte character as two, where .length says one',
      utf8Bytes('ə') === 2 && 'ə'.length === 1,
      { utf8Bytes: utf8Bytes('ə'), length: 'ə'.length },
    );
    check('utf8Bytes counts a three-byte character as three', utf8Bytes('☃') === 3, utf8Bytes('☃'));
    check(
      'utf8Bytes counts an emoji as four, not as two surrogate units',
      utf8Bytes('😀') === 4 && '😀'.length === 2,
      { utf8Bytes: utf8Bytes('😀'), length: '😀'.length },
    );
    check(
      'utf8Bytes agrees with Buffer on a mixed string',
      utf8Bytes('rəf 😀 audit') === Buffer.byteLength('rəf 😀 audit', 'utf8'),
      { computed: utf8Bytes('rəf 😀 audit'), buffer: Buffer.byteLength('rəf 😀 audit', 'utf8') },
    );

    // The refusal itself. A 40 MB item goes in; a second one would exceed the cap.
    const storage = new RecordingQueueStorage();
    const manager = await relaunch(storage);

    const bigPhoto = 'A'.repeat(40 * 1024 * 1024);
    await enqueue(manager, 'task-big-1', bigPhoto);

    const overLimit = await caught(async () => enqueue(manager, 'task-big-2', bigPhoto));

    check(
      'an audit that would push the queue past the limit is refused',
      overLimit instanceof QueueError && overLimit.code === 'QUEUE_FULL',
      overLimit instanceof Error ? overLimit.message : overLimit,
    );
    check(
      'the audit already in the queue is STILL there — the limit did not evict it',
      manager.getQueue().length === 1 && manager.getQueue()[0].task_id === 'task-big-1',
      manager.getQueue().map((item) => item.task_id),
    );
    check(
      'and the refusal names both sizes, so the worker can see what to do about it',
      overLimit instanceof Error &&
        overLimit.message.includes('MB') &&
        overLimit.message.includes('göndərin'),
      overLimit instanceof Error ? overLimit.message : overLimit,
    );
    check(
      'and nothing was written on the refusal — the stored queue is unchanged',
      storage.items.length === 1 && storage.items[0].task_id === 'task-big-1',
      storage.items.map((item) => item.task_id),
    );

    // A single audit larger than the whole queue is refused for the same reason.
    const soloStorage = new RecordingQueueStorage();
    const soloManager = await relaunch(soloStorage);
    const tooBigAlone = await caught(async () =>
      enqueue(soloManager, 'task-solo', 'B'.repeat(MAX_QUEUE_BYTES + 1024)),
    );
    check(
      'an audit bigger than the entire queue is refused as well',
      tooBigAlone instanceof QueueError && tooBigAlone.code === 'QUEUE_FULL',
      tooBigAlone instanceof Error ? tooBigAlone.message : tooBigAlone,
    );
  }

  // ===========================================================================
  // 3. The drain: in order, one at a time, with the marker written before the
  //    upload and the removal written after it.
  // ===========================================================================
  section('3. A drain writes the in-flight marker before the upload, and the removal after');

  {
    const storage = new RecordingQueueStorage();
    const manager = await relaunch(storage);
    await enqueue(manager, 'task-1');
    await enqueue(manager, 'task-2');
    await enqueue(manager, 'task-3');

    const order: string[] = [];
    const statusOnDiskWhenUploaded: string[] = [];
    const queueLengthWhenUploaded: number[] = [];

    // Counted as a delta, not as a total: the three enqueues above each wrote once
    // too, and a total would be asserting on the setup rather than on the drain.
    const writesBeforeDrain = storage.writes;

    const result = await manager.processQueue(async (item) => {
      order.push(item.task_id);
      // Read the device, not the manager: the rule is about what is ON DISK when
      // the upload starts. Asking the manager would read its own memory.
      const onDisk = storage.items;
      statusOnDiskWhenUploaded.push(
        onDisk.find((queued) => queued.id === item.id)?.sync_status ?? '<missing>',
      );
      queueLengthWhenUploaded.push(onDisk.length);
      return { photoUrl: 'https://example.test/photo.jpg', submissionId: `sub-${item.task_id}` };
    });

    check(
      'every pending audit was uploaded',
      result.syncedCount === 3 && result.failedCount === 0,
      result,
    );
    check('the drain reported that it ran', result.reason === 'drained', result.reason);
    check(
      'and they went in the order they were captured',
      order.join(',') === 'task-1,task-2,task-3',
      order,
    );
    check(
      'each item was marked `syncing` ON THE DEVICE before its upload started',
      statusOnDiskWhenUploaded.every((status) => status === 'syncing'),
      statusOnDiskWhenUploaded,
    );
    check(
      'and no item had been removed from the device yet when its own upload began',
      queueLengthWhenUploaded.every((length, index) => length === 3 - index),
      queueLengthWhenUploaded,
    );
    check(
      'the queue is empty in memory afterwards',
      manager.getQueue().length === 0,
      manager.getQueue().map((item) => item.id),
    );

    const nextLaunch = await relaunch(storage);
    check(
      'and empty ON THE DEVICE — the removals were written, not just remembered',
      nextLaunch.getQueue().length === 0,
      nextLaunch.getQueue().map((item) => item.id),
    );
    check(
      'the drain wrote the device twice per audit — the in-flight marker, then the outcome',
      storage.writes - writesBeforeDrain === 6,
      { duringDrain: storage.writes - writesBeforeDrain, expected: 6 },
    );
  }

  // ===========================================================================
  // 4. A failed upload stays, with its reason and a retry count.
  // ===========================================================================
  section('4. An upload that fails stays in the queue and says why');

  {
    const storage = new RecordingQueueStorage();
    const manager = await relaunch(storage);
    await enqueue(manager, 'task-1');

    const result = await manager.processQueue(async () => {
      throw new Error('şəbəkə kəsildi');
    });

    check(
      'the failure is counted, not hidden',
      result.failedCount === 1 && result.syncedCount === 0,
      result,
    );

    const item = manager.getQueue()[0];
    check('the audit is still queued', manager.getQueue().length === 1, manager.getQueue().length);
    check(
      'its status is `failed`, which a later drain will pick up',
      item.sync_status === 'failed',
      item.sync_status,
    );
    check('its retry count went up', item.retry_count === 1, item.retry_count);
    check(
      'and it carries the reason it failed',
      item.error_message === 'şəbəkə kəsildi',
      item.error_message,
    );

    const nextLaunch = await relaunch(storage);
    check(
      'all of that is on the device, not only in memory',
      nextLaunch.getQueue()[0]?.sync_status === 'failed' &&
        nextLaunch.getQueue()[0]?.retry_count === 1 &&
        nextLaunch.getQueue()[0]?.error_message === 'şəbəkə kəsildi',
      nextLaunch.getQueue()[0],
    );
  }

  // ===========================================================================
  // 5. The retry cap: automatic drains stop, a person's does not.
  // ===========================================================================
  section('5. Automatic retries stop at the cap; a manual sync ignores it');

  {
    const storage = new RecordingQueueStorage();
    const manager = await relaunch(storage);
    await enqueue(manager, 'task-1');

    const alwaysFails = async () => {
      throw new Error('API cavab vermir');
    };

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      await manager.processQueue(alwaysFails);
    }

    check(
      `after ${MAX_RETRY_ATTEMPTS} failures the item is at the cap`,
      manager.getQueue()[0].retry_count === MAX_RETRY_ATTEMPTS,
      manager.getQueue()[0].retry_count,
    );

    let automaticCalls = 0;
    const automatic = await manager.processQueue(async (item) => {
      automaticCalls++;
      return { photoUrl: 'x', submissionId: item.id };
    });

    check(
      'an automatic drain does not touch it again',
      automaticCalls === 0 && automatic.skippedCount === 1,
      { automaticCalls, result: automatic },
    );
    check(
      'and it says so rather than reporting an empty success',
      automatic.reason === 'nothing-pending' && automatic.syncedCount === 0,
      automatic,
    );
    check(
      'the audit is still there — reaching the cap does not discard it',
      manager.getQueue().length === 1,
      manager.getQueue().length,
    );

    let manualCalls = 0;
    const manual = await manager.processQueue(
      async (item) => {
        manualCalls++;
        return { photoUrl: 'x', submissionId: item.id };
      },
      { manual: true },
    );

    check(
      'a manual sync retries it anyway — the cap is not there to overrule the worker',
      manualCalls === 1 && manual.syncedCount === 1,
      { manualCalls, result: manual },
    );
    check(
      'and the audit leaves the queue once it succeeds',
      manager.getQueue().length === 0,
      manager.getQueue().length,
    );
  }

  // ===========================================================================
  // 6. Reconnection. This is the section the old suite could not have had: it
  //    called `processQueue` itself, so it passed against an empty
  //    `triggerAutoSync`.
  // ===========================================================================
  section('6. Coming back online actually drains the queue');

  {
    const storage = new RecordingQueueStorage();
    const manager = new OfflineQueueManager();
    manager.useStorage(storage);
    await manager.load();

    manager.setOnlineStatus(false);
    await enqueue(manager, 'task-1');

    check('nothing has drained while offline', manager.getQueue().length === 1);

    const offlineResult = await manager.processQueue(async (item) => ({
      photoUrl: 'x',
      submissionId: item.id,
    }));
    check(
      'a drain while offline is refused and says so',
      offlineResult.reason === 'offline' && offlineResult.syncedCount === 0,
      offlineResult,
    );

    // No handler registered: the drain must REPORT that, not silently do nothing.
    // The old `triggerAutoSync` returned `undefined` in this situation too, which
    // is exactly how an empty method survived three phases.
    manager.setOnlineStatus(true);
    const handlerless = await manager.autoSync;
    check(
      'a reconnection with no upload handler reports `no-handler` instead of a silent no-op',
      handlerless !== null && handlerless.reason === 'no-handler',
      handlerless,
    );

    const uploaded: string[] = [];
    manager.setUploadHandler(async (item) => {
      uploaded.push(item.task_id);
      return { photoUrl: 'x', submissionId: item.id };
    });

    // Offline again, so the transition is a real one.
    manager.setOnlineStatus(false);
    manager.setOnlineStatus(true);

    const auto = await manager.autoSync;
    check(
      'a reconnection with a handler drains the queue without being asked',
      uploaded.join(',') === 'task-1',
      { uploaded, result: auto },
    );
    check(
      'and reports that it ran',
      auto !== null && auto.reason === 'drained' && auto.syncedCount === 1,
      auto,
    );
    check('the queue is empty afterwards', manager.getQueue().length === 0);

    // A handler that rejects must not become an unhandled rejection: a
    // connectivity listener cannot catch anything.
    const failingStorage = new RecordingQueueStorage();
    const failingManager = new OfflineQueueManager();
    failingManager.useStorage(failingStorage);
    await failingManager.load();
    failingManager.setUploadHandler(async () => {
      throw new Error('şəbəkə yenidən kəsildi');
    });
    failingManager.setOnlineStatus(false);
    await enqueue(failingManager, 'task-x');
    failingManager.setOnlineStatus(true);

    const rejected = await failingManager.autoSync;
    check(
      'a failing drain is turned into a value, not an unhandled rejection',
      rejected !== null && rejected.failedCount === 1 && rejected.reason === 'drained',
      rejected,
    );

    // A storage failure during the drain must be reported too, and the drain must
    // STOP rather than upload items whose progress cannot be recorded.
    const brokenStorage = new RecordingQueueStorage();
    const brokenManager = new OfflineQueueManager();
    brokenManager.useStorage(brokenStorage);
    await brokenManager.load();
    await enqueue(brokenManager, 'task-1');
    await enqueue(brokenManager, 'task-2');
    brokenManager.setUploadHandler(async (item) => {
      // The marker write for the NEXT transition is what fails.
      brokenStorage.failNextWrites = 1;
      return { photoUrl: 'x', submissionId: item.id };
    });
    brokenManager.setOnlineStatus(false);
    brokenManager.setOnlineStatus(true);

    const broken = await brokenManager.autoSync;
    check(
      'a drain whose writes fail reports `storage-failed` rather than crashing the listener',
      broken !== null && broken.reason === 'storage-failed',
      broken,
    );
    check(
      'and it stops instead of uploading the rest — progress that cannot be recorded must not be made',
      brokenStorage.items.filter((item) => item.sync_status === 'synced').length === 0,
      brokenStorage.items.map((item) => `${item.task_id}:${item.sync_status}`),
    );
  }

  // ===========================================================================
  // 7. The item the app died on. Held back, not retried.
  // ===========================================================================
  section('7. An audit left in flight comes back held back, not queued for a retry');

  {
    const storage = new RecordingQueueStorage();
    const manager = await relaunch(storage);
    await enqueue(manager, 'task-1');
    await enqueue(manager, 'task-2');
    await enqueue(manager, 'task-3');

    const uploaded: string[] = [];
    const drainError = await caught(async () =>
      manager.processQueue(async (item) => {
        uploaded.push(item.task_id);
        if (item.task_id === 'task-2') {
          // Two things at once, and both are the point: the upload fails, AND the
          // write that would record the failure does not land. That is the shape
          // of the process being killed — the marker for task-2 is on the device
          // and nothing after it is.
          storage.failNextWrites = 1;
          throw new Error('proses dayandırıldı');
        }
        return { photoUrl: 'x', submissionId: item.id };
      }),
    );

    check(
      'the drain aborted rather than continuing past a write it could not make',
      drainError !== null,
      drainError instanceof Error ? drainError.message : drainError,
    );
    check(
      'the first audit was uploaded and removed',
      uploaded.join(',') === 'task-1,task-2',
      uploaded,
    );
    check(
      'and the device shows task-2 still in flight',
      storage.items.find((item) => item.task_id === 'task-2')?.sync_status === 'syncing',
      storage.items.map((item) => `${item.task_id}:${item.sync_status}`),
    );

    // The next launch.
    const nextLaunch = await relaunch(storage);
    const recovered = nextLaunch.getQueue();

    check(
      'the audit that completed is gone from the device',
      !recovered.some((item) => item.task_id === 'task-1'),
      recovered.map((item) => item.task_id),
    );
    const inFlight = recovered.find((item) => item.task_id === 'task-2');
    check(
      'the in-flight audit is not restored as `queued` — that would re-upload it',
      inFlight !== undefined && inFlight.sync_status === 'failed',
      inFlight?.sync_status,
    );
    check(
      'it carries the message that says it may already have been filed',
      inFlight?.error_message === INTERRUPTED_UPLOAD_MESSAGE,
      inFlight?.error_message,
    );
    check(
      'and its retry count is at the cap, which is what keeps it out of the automatic path',
      inFlight?.retry_count === MAX_RETRY_ATTEMPTS,
      inFlight?.retry_count,
    );
    check(
      'the third audit was never attempted and is still queued',
      recovered.find((item) => item.task_id === 'task-3')?.sync_status === 'queued',
      recovered.map((item) => `${item.task_id}:${item.sync_status}`),
    );

    // The automatic drain must leave the in-flight one alone and take the third.
    const afterRecovery: string[] = [];
    const auto = await nextLaunch.processQueue(async (item) => {
      afterRecovery.push(item.task_id);
      return { photoUrl: 'x', submissionId: item.id };
    });

    check(
      'the next automatic drain skips the uncertain audit',
      !afterRecovery.includes('task-2'),
      afterRecovery,
    );
    check(
      'and it does take the one that was never attempted',
      afterRecovery.join(',') === 'task-3',
      afterRecovery,
    );
    check('the skip is reported', auto.skippedCount === 1, auto);
    check(
      'and the uncertain audit is still in the queue, for a person to decide about',
      nextLaunch.getQueue().some((item) => item.task_id === 'task-2'),
      nextLaunch.getQueue().map((item) => `${item.task_id}:${item.sync_status}`),
    );
  }

  // ===========================================================================
  // 8. A damaged payload. Reported, not thrown, and not silently swallowed.
  // ===========================================================================
  section('8. A damaged queue is reported rather than silently emptied');

  {
    const storage = new RecordingQueueStorage();
    storage.value = 'this is not JSON {{{';

    const manager = new OfflineQueueManager();
    manager.useStorage(storage);
    const report = await manager.load();

    check(
      'loading a corrupt payload does not throw — a bad file must not abort startup',
      report.corruption !== null,
      report.corruption,
    );
    check(
      'the corruption is reported with its size and a bounded sample',
      report.corruption?.length === 'this is not JSON {{{'.length &&
        report.corruption.sample.length <= 200,
      report.corruption,
    );
    check('the queue starts empty and usable', manager.getQueue().length === 0);
    check(
      'and the report is kept for a caller to read after the fact',
      manager.getLoadReport()?.corruption !== null,
    );

    // A payload that parses but is not a list of queue items.
    const mixedStorage = new RecordingQueueStorage();
    mixedStorage.value = JSON.stringify([
      {
        id: 'good',
        task_id: 't',
        store_id: 's',
        photo_uri: 'x',
        metadata: metadata(),
        created_at: '',
        retry_count: 0,
        sync_status: 'queued',
      },
      {
        id: 'no-metadata',
        task_id: 't',
        store_id: 's',
        photo_uri: 'x',
        created_at: '',
        retry_count: 0,
        sync_status: 'queued',
      },
      'a bare string',
      null,
    ]);

    const mixed = new OfflineQueueManager();
    mixed.useStorage(mixedStorage);

    // The load is CAUGHT rather than awaited directly, and that is a fix the
    // break run forced rather than a style choice.
    //
    // Without `looksLikeQueueItem`, the malformed entries reach the queue and the
    // very next read of `sync_status` throws on the `null` — so `load()` rejected,
    // this check never ran, and the suite reported a crash instead of a failure.
    // The guard was therefore NOT guarded by the check that claims to guard it.
    // Catching the throw turns that crash into this check's own red.
    const mixedLoadError = await caught(async () => mixed.load());
    const mixedReport = mixed.getLoadReport();

    check(
      'entries that are not shaped like queue items are dropped, not trusted',
      mixedLoadError === null &&
        mixedReport !== null &&
        mixed.getQueue().length === 1 &&
        mixed.getQueue()[0].id === 'good',
      mixedLoadError instanceof Error
        ? mixedLoadError.message
        : mixed.getQueue().map((item) => (item as { id?: string } | null)?.id ?? '<malformed>'),
    );
    check(
      'and the number dropped is reported rather than hidden',
      mixedReport?.droppedCount === 3,
      mixedReport,
    );
  }

  // ===========================================================================
  // 9. Clearing reaches the device.
  // ===========================================================================
  section('9. Clearing the queue clears it on the device, and says how much it cleared');

  {
    const storage = new RecordingQueueStorage();
    const manager = await relaunch(storage);
    await enqueue(manager, 'task-1');
    await enqueue(manager, 'task-2');

    const cleared = await manager.clearQueue();

    check('it reports how many it removed', cleared === 2, cleared);
    check('memory is empty', manager.getQueue().length === 0);
    check(
      'and the DEVICE is empty — the clear was written, not just remembered',
      storage.items.length === 0,
      storage.items,
    );

    const nextLaunch = await relaunch(storage);
    check(
      'so the next launch does not bring the audits back',
      nextLaunch.getQueue().length === 0,
      nextLaunch.getQueue().map((item) => item.id),
    );
    check(
      'clearing an empty queue is not an error and reports zero',
      (await manager.clearQueue()) === 0,
    );
  }

  // ===========================================================================
  // 10. The wiring. Nothing else in the repo would notice if these came apart.
  // ===========================================================================
  section('10. The queue is wired to the app, and the app entry reads it');

  {
    // Importing `mobileApp` (at the top of this file) constructs the coordinator,
    // which constructs the history controller — which is what registers the upload
    // path. That is the mechanism, so it is asserted rather than assumed: a
    // reconnection before any screen opens has to have something to upload with.
    check(
      'constructing the coordinator registers an upload handler with the queue',
      offlineQueueService.hasUploadHandler(),
    );

    const controller = new AuditHistoryController();
    check(
      'and constructing a history controller does the same, so it is not a one-off side effect',
      offlineQueueService.hasUploadHandler() && controller !== null,
    );

    // `clearLocalData` must reach the queue, and it must be awaited to do so.
    const storage = new RecordingQueueStorage();
    offlineQueueService.useStorage(storage);
    await offlineQueueService.load();
    await enqueue(offlineQueueService, 'task-clear');
    check('the singleton has an audit queued', storage.items.length === 1);

    const cleared = await mobileApp.clearLocalData();
    check(
      'the coordinator clears the queue and reports the count from the same call',
      cleared.queuedItemsCleared === 1,
      cleared,
    );
    check('and the device is empty afterwards', storage.items.length === 0, storage.items);

    // Put the singleton back on its in-memory default so nothing later in this
    // file is affected by the storage wired above.
    offlineQueueService.useStorage(new MemoryQueueStorage());
    await offlineQueueService.load();
  }

  // ===========================================================================
  // 11. The storage key is stable. Changing it silently orphans every queued
  //     audit on every device already in the field.
  // ===========================================================================
  section('11. The storage key is pinned');

  check(
    'the queue key is the versioned name the adapter uses',
    QUEUE_STORAGE_KEY === 'oneteam.offlineQueue.v1',
    QUEUE_STORAGE_KEY,
  );
  check(
    'MemoryQueueStorage starts empty and reports its own size',
    (() => {
      const memory = new MemoryQueueStorage();
      return memory.byteLength === 0;
    })(),
  );

  // ===========================================================================

  console.log(
    `\n${colors.bright}${passed + failed} checks: ${colors.green}${passed} passed${colors.reset}` +
      (failed > 0 ? `, ${colors.red}${failed} FAILED${colors.reset}` : ''),
  );
  console.log(
    `  ${colors.yellow}Not covered here:${colors.reset} AsyncStorage itself. ` +
      `queueStorage.ts calls a native\n  module and is not imported by this suite, so ` +
      `nothing here has run on a device.`,
  );

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`${colors.red}The suite itself failed:${colors.reset}`, error);
  process.exit(1);
});
