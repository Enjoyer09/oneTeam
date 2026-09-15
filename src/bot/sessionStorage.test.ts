/**
 * oneTeam — the bot's session storage adapter
 * ============================================================================
 *
 * WHY THIS EXISTS SEPARATELY FROM `test:flow`
 * ------------------------------------------
 * `apps/api/test/bot-session.spec.ts` proves the flow is stored and survives a
 * restart. It talks to the API directly, so it says nothing about the layer the
 * bot actually uses to reach it — `src/bot/sessionStorage.ts`.
 *
 * That layer is thin, which is exactly why it is worth pinning. It holds three
 * decisions that are invisible from either end and expensive to get wrong:
 *
 *   1. WHAT COUNTS AS EMPTY. A chat that only ever said "salam" produces an
 *      empty session. Writing it would make `bot_sessions` grow with every stray
 *      message, so an empty session is deleted instead. But "bound to a store,
 *      no task open" is also a resting state and must NOT be deleted — that is
 *      the state whose loss makes the bot ask for a store code again.
 *
 *   2. `null` FROM THE API BECOMES `undefined` IN THE SESSION. Handlers test
 *      `if (ctx.session.storeId)`, so both are falsy and either would work —
 *      until something compares against `undefined` explicitly. The translation
 *      is asserted rather than assumed.
 *
 *   3. A FAILURE MUST NOT LOOK LIKE "NO SESSION". This is the important one. If
 *      `read` returned `undefined` when the API was unreachable, the bot would
 *      treat a database hiccup as "this chat has never started" and ask a
 *      merchandiser standing in a shop to type their store code again — losing
 *      work that is sitting safely in the database. So `read` must throw.
 *
 * HOW IT IS RUN
 * -------------
 * It starts its own API process, on its own port, against `DATABASE_URL`, and
 * stops it again — including on purpose, to test decision 3. It needs no
 * externally running service.
 *
 *   npm run test:bot-storage
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Refuses to run in production: it starts its own API and writes rows. The same
 * guard exists in `apps/api/test/bot-session.spec.ts` and `test-runner.ts`.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: this suite starts its own API and writes rows.');
  process.exit(1);
}

process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

const PORT = Number(process.env.ONETEAM_TEST_BOT_STORAGE_PORT || 3121);
const API_BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';

const REPO_ROOT = process.cwd();
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');

const RUN = Date.now().toString(36).toUpperCase();
const CHAT = `storage-${RUN}`;
const CHAT_BLANK = `storage-blank-${RUN}`;
const CHAT_BOUND = `storage-bound-${RUN}`;

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let api: ChildProcess | null = null;
let apiLog: string[] = [];

async function waitForHealth(timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error(`The API did not become healthy on ${API_BASE}.\n${apiLog.join('')}`);
}

async function waitForDown(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${API_BASE}/api/health`);
    } catch {
      return;
    }
    await sleep(150);
  }
  throw new Error(`The API on ${API_BASE} did not stop.`);
}

async function startApi(): Promise<void> {
  if (!existsSync(API_ENTRY)) {
    throw new Error('apps/api/dist/main.js is missing — run `npm run api:build` first.');
  }
  apiLog = [];
  const child = spawn(process.execPath, [API_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV || 'development',
      ONETEAM_REFRESH_MS: '0',
      // The sweep is not what this file tests, and a live one would only add a
      // moving part.
      ONETEAM_BOT_SWEEP_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    apiLog.push(chunk.toString());
    if (apiLog.length > 300) apiLog.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  api = child;
  await waitForHealth();
}

async function stopApi(): Promise<void> {
  const child = api;
  if (!child) return;
  api = null;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const forced = await Promise.race([exited.then(() => false), sleep(6_000).then(() => true)]);
  if (forced) child.kill('SIGKILL');
  await waitForDown();
}

async function main(): Promise<void> {
  // The API client reads `ONETEAM_API_URL` when its module is first evaluated,
  // so it has to be set before the import rather than after.
  process.env.ONETEAM_API_URL = API_BASE;
  process.env.ONETEAM_API_TOKEN = process.env.ONETEAM_API_TOKEN || 'oneteam-user:usr-admin-001';

  await startApi();

  const { ApiSessionStorage, FlowStorageError } = await import('./sessionStorage.js');
  const storage = new ApiSessionStorage();

  try {
    // -------------------------------------------------------------------------
    console.log('a chat with no session');
    // -------------------------------------------------------------------------

    check(
      'reading a chat the bot has never seen gives undefined',
      (await storage.read(CHAT)) === undefined,
    );

    // -------------------------------------------------------------------------
    console.log('\nwriting and reading back');
    // -------------------------------------------------------------------------

    const session = {
      step: 'awaiting_checklist' as const,
      storeId: 'str-bravo-yasamal',
      storeCode: 'BRAVO_YASAMAL_01',
      storeName: 'Bravo Yasamal',
      activeTaskId: `task-storage-${RUN}`,
      activeTaskTitle: `Rəf yoxlaması ${RUN}`,
      location: { latitude: 40.3724, longitude: 49.8372 },
      checklistQuestions: [
        { id: 'q1', question: 'Sıra düzülüb?', type: 'boolean' as const, required: true },
      ],
      checklistAnswers: [{ questionId: 'q1', value: true }],
      checklistIndex: 1,
    };

    await storage.write(CHAT, session);
    const readBack = await storage.read(CHAT);

    check('a written session is read back', readBack !== undefined);
    check(
      'and every field survived the trip',
      readBack?.step === session.step &&
        readBack?.storeId === session.storeId &&
        readBack?.storeCode === session.storeCode &&
        readBack?.activeTaskId === session.activeTaskId &&
        readBack?.location?.latitude === 40.3724 &&
        readBack?.checklistIndex === 1,
      readBack,
    );
    check(
      'the checklist questions and answers survived as arrays',
      Array.isArray(readBack?.checklistQuestions) &&
        readBack?.checklistQuestions.length === 1 &&
        Array.isArray(readBack?.checklistAnswers) &&
        readBack?.checklistAnswers[0]?.value === true,
      { questions: readBack?.checklistQuestions, answers: readBack?.checklistAnswers },
    );
    check(
      'an absent field comes back as undefined, not null',
      readBack?.pendingPhoto === undefined && readBack?.profileId === undefined,
      { pendingPhoto: readBack?.pendingPhoto, profileId: readBack?.profileId },
    );

    // The resting state that must NOT be treated as empty.
    await storage.write(CHAT_BOUND, { step: 'idle', storeId: 'str-bravo-yasamal' });
    const boundRead = await storage.read(CHAT_BOUND);
    check(
      'a chat bound to a store with no task open is kept, not thrown away',
      boundRead?.storeId === 'str-bravo-yasamal' && boundRead?.step === 'idle',
      boundRead,
    );

    // -------------------------------------------------------------------------
    console.log('\nan empty session');
    // -------------------------------------------------------------------------

    await storage.write(CHAT_BLANK, { step: 'idle' });
    check(
      'writing an empty session stores nothing',
      (await storage.read(CHAT_BLANK)) === undefined,
    );

    // A session that is emptied by the handlers must be cleared the same way.
    await storage.write(CHAT, session);
    await storage.write(CHAT, { step: 'idle' });
    check('a session emptied by the handlers is cleared', (await storage.read(CHAT)) === undefined);

    // -------------------------------------------------------------------------
    console.log('\ndeleting');
    // -------------------------------------------------------------------------

    await storage.write(CHAT, session);
    await storage.delete(CHAT);
    check('deleting a session clears it', (await storage.read(CHAT)) === undefined);
    check(
      'deleting one that is already gone does not throw',
      await (async () => {
        await storage.delete(CHAT);
        return true;
      })().catch(() => false),
    );

    // -------------------------------------------------------------------------
    console.log('\nwhen the API is unreachable');
    // -------------------------------------------------------------------------

    await storage.write(CHAT, session);
    await stopApi();

    const readFailure = await storage.read(CHAT).then(
      () => null,
      (error: unknown) => error,
    );
    check(
      'reading throws instead of reporting "this chat has never started"',
      readFailure instanceof FlowStorageError && readFailure.operation === 'read',
      readFailure instanceof Error ? readFailure.message : readFailure,
    );
    check(
      'and the error is tagged as a storage failure, not an ordinary API error',
      readFailure instanceof FlowStorageError,
      readFailure instanceof Error ? readFailure.name : readFailure,
    );

    const writeFailure = await storage.write(CHAT, session).then(
      () => null,
      (error: unknown) => error,
    );
    check(
      'writing throws too, so the chat can be told its progress was not saved',
      writeFailure instanceof FlowStorageError && writeFailure.operation === 'write',
      writeFailure instanceof Error ? writeFailure.message : writeFailure,
    );

    // -------------------------------------------------------------------------
    console.log('\ncleanup');
    // -------------------------------------------------------------------------

    await startApi();
    for (const chatId of [CHAT, CHAT_BLANK, CHAT_BOUND]) {
      await storage.delete(chatId).catch(() => undefined);
    }
    const cleaned = await Promise.all(
      [CHAT, CHAT_BLANK, CHAT_BOUND].map((chatId) => storage.read(chatId)),
    );
    check(
      'no test session is left behind',
      cleaned.every((entry) => entry === undefined),
      cleaned,
    );
  } finally {
    await stopApi().catch(() => undefined);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('\nSuite crashed:', error);
  await stopApi().catch(() => undefined);
  process.exitCode = 1;
});
