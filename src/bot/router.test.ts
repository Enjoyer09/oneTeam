/**
 * oneTeam — bot router suite (Phase 2.1)
 * ============================================================================
 *
 * WHY THIS SUITE EXISTS, AND WHY IT IS NOT `bot:test`
 * ---------------------------------------------------
 * `src/bot/test-runner.ts` calls the handlers **directly**:
 *
 *     await handleLocationMessage(ctx)
 *     await handleChecklistCallback(ctx)
 *
 * That proves the handler's own logic. It proves nothing about whether the
 * handler is ever reached, because it does not go through the bot at all.
 *
 * Those are not the same question, and the difference is not academic. When
 * this suite was written, `src/bot/index.ts` imported four handlers and called
 * none of them:
 *
 *   - `handleLocationMessage`  — no `message:location` handler existed at all,
 *     so a shared location was dropped by Telegram's dispatcher and the bot
 *     said nothing. The flow then sat in `awaiting_location` forever.
 *   - `handleLocationSkip`     — never called from the text router.
 *   - `handleChecklistText`    — never called from the text router, so a typed
 *     answer was answered with the help text.
 *   - `handleChecklistCallback`— never called; the single `callback_query:data`
 *     handler accepted only `submit_`, so every checklist button was swallowed
 *     without even an acknowledgement.
 *
 * The net effect in production: a merchandiser could open a task, be asked for
 * a location, share it, be ignored, and then be **refused the photo** because
 * the step had never advanced. The guided field flow was unreachable end to
 * end, and `bot:test` was green throughout.
 *
 * So this suite drives the REAL bot:
 *
 *     bot.handleUpdate(update)
 *
 * through the real middleware stack — session, router, handlers — with only
 * Telegram's HTTP API replaced by a stub. If a route is not wired, nothing
 * happens here either, and the assertion fails.
 *
 * WHAT IT ASSERTS
 * ---------------
 * The whole chain, in the order a merchandiser walks it:
 *
 *   /start -> store code -> /tasks -> open -> location -> checklist -> photo
 *          -> confirm -> filed
 *
 * plus the three properties Phase 2.1 is accepted on:
 *
 *   1. Every inline button's `callback_data` is `action:id`.
 *   2. The photo is NOT filed until the confirm button is tapped.
 *   3. A duplicate tap produces no error and no second audit.
 *
 * and the one property Phase 2.4 is accepted on:
 *
 *   4. `/help` shows the menu, and every text command is a way back to it.
 *
 * ONE CHECK DOES NOT DRIVE THE BOT, ON PURPOSE
 * --------------------------------------------
 * "no callback action is unreachable" reads the source instead. Driving can
 * only reach actions that are already reachable, so no amount of walking can
 * find an action that nothing emits — which is how `menu:home` sat in the
 * router with no button anywhere producing it, exactly the way four handlers
 * sat in `index.ts` with nothing calling them in 2.1. A test that executes the
 * code cannot find unreachable code; only a static reading can.
 *
 * WHY A DUPLICATE TAP CAN BE GUARDED BY SESSION STATE ALONE
 * --------------------------------------------------------
 * The guard is "has the effect already happened?", read from the session. That
 * is only sound if two updates are never handled concurrently, because the
 * session is read and written around each handler:
 *
 *     grammY `bot.js:191`  handleUpdates -> `for (const update of updates)
 *                          await this.handleUpdate(update)`   // sequential
 *     grammY `session.js:67`  `await next(); await propSession.finish();`
 *
 * So the write of update N lands before update N+1 is read. The two line
 * references are in the comment because the property is grammY's, not ours,
 * and a future version that adds a concurrency option would silently remove
 * it. `check()` below is what would notice.
 *
 * WHAT IT DOES NOT ASSERT
 * -----------------------
 * The text of a checklist question. `#73` records that the API stores the
 * question under `label` while the bot reads `question`, so the bot currently
 * prints `undefined`. That is a separate, deliberately unfixed defect — see
 * task #73 — and asserting the text here would make this suite red for a
 * reason that has nothing to do with routing.
 *
 * WHAT IT CLEANS UP
 * -----------------
 * It builds its own store, task, user and audit, and removes every one of them
 * (in RESTRICT order: evidence, task, user, session, store). The final check
 * asserts the row counts are back where they started.
 *
 * Prerequisites: PostgreSQL reachable, and `apps/api/dist/main.js` built
 * (`npm run api:build`). This suite starts its own API on its own port.
 *
 *   npm run test:router
 */

if (process.env.NODE_ENV === 'production') {
  console.error(
    'Refusing to run: this suite starts its own API and writes rows. It is a development suite.',
  );
  process.exit(1);
}

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { CALLBACK_ACTIONS } from './callbacks';

/** Its own port, so the suites that own 3111/3121 are not disturbed. */
const PORT = Number(process.env.ONETEAM_TEST_ROUTER_PORT || 3131);
const API_BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const SERVICE_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || 'oneteam-user:usr-admin-001';

const REPO_ROOT = process.cwd();
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');

/**
 * The bot's own source, read at the end of the suite by the one check that
 * cannot drive the bot. See "no callback action is unreachable" below.
 */
const BOT_SOURCE_DIR = path.join(REPO_ROOT, 'src/bot');

/** Unique per run, so two runs against one database do not collide. */
const RUN = Date.now().toString(36).toUpperCase();

/** A fresh chat, so the flow creates its own user instead of adopting a seeded one. */
const CHAT_ID = 770_000_000 + (Date.now() % 9_000_000);
const STORE_CODE = `ROUTER_${RUN}`;

/**
 * The bot's own API client reads these when its module is evaluated, so they
 * are set before the dynamic import below — not after.
 */
process.env.ONETEAM_API_URL = API_BASE;
process.env.ONETEAM_API_TOKEN = SERVICE_TOKEN;
process.env.TELEGRAM_BOT_TOKEN = 'mockBotToken:router-suite';

/** `fetch` honours HTTP_PROXY; everything here is loopback. */
process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

let pass = 0;
let fail = 0;
let skipped = 0;

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

function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  \u25CB ${name} — SKIPPED: ${why}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The API's lifecycle, owned by this suite
// ---------------------------------------------------------------------------

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
  throw new Error(
    `The API did not become healthy on ${API_BASE} within ${timeoutMs}ms.\n` +
      `Last output:\n${apiLog.join('')}`,
  );
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
      NODE_ENV: 'development',
      ONETEAM_REFRESH_MS: '0',
      ONETEAM_BOT_SWEEP_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    apiLog.push(chunk.toString());
    if (apiLog.length > 400) apiLog.shift();
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
}

// ---------------------------------------------------------------------------
// The supervisor's API calls — provisioning and cleanup only
// ---------------------------------------------------------------------------

async function supervisor(
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API_BASE}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

// ---------------------------------------------------------------------------
// The Telegram stub
// ---------------------------------------------------------------------------

interface SentCall {
  method: string;
  payload: Record<string, any>;
}

const sent: SentCall[] = [];
let nextMessageId = 1000;
let nextQueryId = 1;

function stubResult(method: string, payload: Record<string, any>): unknown {
  switch (method) {
    case 'getMe':
      return {
        id: 424242,
        is_bot: true,
        first_name: 'oneTeam Router Test',
        username: 'oneteam_router_test',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      };
    case 'sendMessage':
    case 'sendPhoto':
      return {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: payload.chat_id, type: 'private' },
        text: payload.text ?? payload.caption ?? '',
      };
    case 'getFile':
      // Deliberately without `file_path`: the bot's mock-token branch never
      // downloads from Telegram, and a path here would invite a real fetch.
      return { file_id: payload.file_id, file_unique_id: 'unique', file_size: 2048 };
    default:
      return true;
  }
}

/**
 * Replaces Telegram's HTTP API. Everything else — middleware, session, router,
 * handlers — is the real thing.
 */
function installTelegramStub(bot: any): void {
  bot.api.config.use(async (_prev: unknown, method: string, payload: Record<string, any>) => {
    sent.push({ method, payload });
    return { ok: true, result: stubResult(method, payload) as any };
  });
}

/** Every `sendMessage`/`sendPhoto` body the bot produced since the last reset. */
function texts(): string[] {
  return sent
    .filter((call) => call.method === 'sendMessage')
    .map((call) => String(call.payload.text ?? ''));
}

function captions(): string[] {
  return sent
    .filter((call) => call.method === 'sendPhoto')
    .map((call) => String(call.payload.caption ?? ''));
}

/** Every inline button the bot offered, across every message it sent. */
function inlineButtons(): Array<{ text: string; data: string }> {
  const buttons: Array<{ text: string; data: string }> = [];
  for (const call of sent) {
    const rows = call.payload?.reply_markup?.inline_keyboard;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      for (const button of row) {
        buttons.push({ text: String(button.text), data: String(button.callback_data ?? '') });
      }
    }
  }
  return buttons;
}

/** Every reply-keyboard button the bot offered. */
function replyButtons(): Array<{ text: string; requestLocation: boolean }> {
  const buttons: Array<{ text: string; requestLocation: boolean }> = [];
  for (const call of sent) {
    const rows = call.payload?.reply_markup?.keyboard;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      for (const button of row) {
        buttons.push({
          text: String(button.text),
          requestLocation: button.request_location === true,
        });
      }
    }
  }
  return buttons;
}

function callbackAnswers(): string[] {
  return sent
    .filter((call) => call.method === 'answerCallbackQuery')
    .map((call) => String(call.payload.text ?? ''));
}

/** The `action:id` of the first inline button whose text matches. */
function buttonDataStartingWith(prefix: string): string | undefined {
  return inlineButtons().find((button) => button.data.startsWith(prefix))?.data;
}

function buttonDataWithText(fragment: string): string | undefined {
  return inlineButtons().find((button) => button.text.includes(fragment))?.data;
}

/**
 * The button that opens a task.
 *
 * `open:<id>` is the Phase 2.1 format. The legacy `submit_<id>` is accepted as
 * a fallback so that this suite can still walk the flow — and therefore still
 * report *which* part of it is broken — while the format is being changed.
 *
 * The fallback cannot hide a regression: the format is asserted on its own, and
 * a failure there is reported. It only decides whether the later checks run or
 * are skipped, and a suite that skips twenty checks and says "the button had
 * the wrong name" is much less useful than one that goes on to say "and the
 * location message was ignored".
 */
function openTaskButton(): { data: string; legacy: boolean } | undefined {
  const current = buttonDataStartingWith('open:');
  if (current) return { data: current, legacy: false };
  const legacy = buttonDataStartingWith('submit_');
  return legacy ? { data: legacy, legacy: true } : undefined;
}

// ---------------------------------------------------------------------------
// Update builders — shaped exactly as Telegram delivers them
// ---------------------------------------------------------------------------

let nextUpdateId = 1;

function fromUser() {
  return { id: CHAT_ID, is_bot: false, first_name: 'Router', language_code: 'az' };
}

function privateChat() {
  return { id: CHAT_ID, type: 'private' as const };
}

function textUpdate(text: string): any {
  // Telegram marks a command with a `bot_command` entity, and grammY's
  // `bot.command()` filter requires it:
  //
  //   grammY `context.js:23`  const hasEntities = filterQuery(':entities:bot_command')
  //   grammY `context.js:35`  if (!hasEntities(ctx)) return false
  //
  // A synthetic `/start` without entities therefore does not reach
  // `handleStart` — it falls through to the plain-text router. That was a bug
  // in this suite, not in the bot, and it looked exactly like the bot ignoring
  // `/start`. Building the entity here keeps the update faithful.
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }]
    : undefined;

  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(),
      from: fromUser(),
      text,
      ...(entities ? { entities } : {}),
    },
  };
}

function locationUpdate(latitude: number, longitude: number): any {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(),
      from: fromUser(),
      location: { latitude, longitude },
    },
  };
}

function photoUpdate(fileId: string): any {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(),
      from: fromUser(),
      photo: [
        {
          file_id: `${fileId}-small`,
          file_unique_id: 's',
          width: 320,
          height: 240,
          file_size: 200,
        },
        { file_id: fileId, file_unique_id: 'l', width: 1080, height: 1440, file_size: 2048 },
      ],
    },
  };
}

/**
 * A button tap.
 *
 * `messageId` is the id of the message the button lives on, which is what
 * Telegram reports in `callbackQuery.message.message_id`. Two taps on the same
 * button produce two of these with the same `messageId` and different query
 * ids — which is exactly what a duplicate tap looks like on the wire.
 */
function callbackUpdate(data: string, messageId: number): any {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq-${nextQueryId++}`,
      from: fromUser(),
      chat_instance: 'router-suite',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: privateChat(),
        text: 'suite',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The main flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== oneTeam bot router suite — run ${RUN} ===`);

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  const countOf = async (table: string): Promise<number> => {
    const result = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0].n;
  };

  const evidenceCount = async (ofTaskId: string): Promise<number> => {
    const result = await db.query(
      'SELECT count(*)::int AS n FROM task_evidences WHERE store_task_id = $1',
      [ofTaskId],
    );
    return result.rows[0].n;
  };

  /**
   * Waits for the audit row to appear.
   *
   * The API answers `POST /api/portal/field/submissions` BEFORE the row is
   * written — `createEvidence` is queued with `persist`, not `enqueue`, so that
   * a merchandiser's photo is never rejected because the database was slow at
   * that moment. That is the right behaviour and it means a read straight after
   * the response can legitimately see nothing.
   *
   * Without this poll the suite failed with "confirming files exactly one
   * audit — got 0" while the API log said the audit had been filed. The failure
   * was the test's, not the product's, and it is worth a helper rather than a
   * `sleep`: polling also makes the duplicate check below meaningful, because
   * it establishes that the first write has definitely landed before the second
   * tap is measured against it.
   */
  const waitForEvidenceCount = async (
    ofTaskId: string,
    expected: number,
    timeoutMs = 8_000,
  ): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
      last = await evidenceCount(ofTaskId);
      if (last === expected) return last;
      await sleep(150);
    }
    return last;
  };

  const before = {
    stores: await countOf('stores'),
    storeTasks: await countOf('store_tasks'),
    templates: await countOf('task_templates'),
    evidences: await countOf('task_evidences'),
    users: await countOf('users'),
    sessions: await countOf('bot_sessions'),
    audits: await countOf('audit_logs'),
    notifications: await countOf('notifications'),
  };

  let storeId: string | undefined;
  let taskId: string | undefined;
  let templateId: string | undefined;
  let userId: string | undefined;
  /** Audit rows name the evidence, so their ids are collected before deletion. */
  let evidenceIds: string[] = [];

  // The bot's own error channel. `createBot` installs a `bot.catch` that
  // swallows handler errors after logging them under this prefix, so a
  // swallowed error is invisible unless it is captured here.
  const realError = console.error;
  const botErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    const line = args.map((arg) => String(arg)).join(' ');
    if (line.includes('[oneTeam Bot Error]')) {
      botErrors.push(line);
      return; // Kept quiet so the suite's own output stays readable.
    }
    realError(...args);
  };

  try {
    await startApi();
    console.log('  · the API is up on its own port');

    // -----------------------------------------------------------------------
    console.log('\nfixtures');
    // -----------------------------------------------------------------------

    const store = await supervisor('POST', '/api/portal/stores', {
      store_code: STORE_CODE,
      name: `Router Test Mağazası ${RUN}`,
      address: 'Test ünvanı 1, Bakı',
      latitude: 40.3724,
      longitude: 49.8372,
    });
    storeId = store.body?.data?.id;
    check('the fixture store is created', store.status === 201 && Boolean(storeId), store.body);

    if (!storeId) {
      skip('every flow check', 'the fixture store could not be created');
      return;
    }

    const task = await supervisor('POST', '/api/portal/tasks', {
      title: `Router suite tapşırığı ${RUN}`,
      description: 'Suite tərəfindən yaradılmış müvəqqəti tapşırıq.',
      priority: 'HIGH',
      deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      assigned_stores: [storeId],
      // `label`, not `question`: that is what the API accepts. See #73.
      checklist_schema: [
        { label: 'Rəfdə Coca-Cola Classic var?', type: 'boolean', required: true },
        { label: 'Neçə sıra düzülüb?', type: 'number', required: false, minValue: 0, maxValue: 10 },
      ],
    });
    taskId = task.body?.data?.taskIds?.[0];
    templateId = task.body?.data?.templateId;
    check('the fixture task is dispatched', task.status === 201 && Boolean(taskId), task.body);

    if (!taskId) {
      skip('every flow check', 'the fixture task could not be dispatched');
      return;
    }

    // -----------------------------------------------------------------------
    console.log('\nthe bot, with only Telegram replaced');
    // -----------------------------------------------------------------------

    const { createBot } = await import('./index.js');
    const bot = createBot('mockBotToken:router-suite');
    installTelegramStub(bot);
    await bot.init();
    check('the bot initialises against the stub', bot.isInited());

    const reset = () => {
      sent.length = 0;
    };

    /** Feeds one update through the whole stack and reports the calls it made. */
    const feed = async (update: any): Promise<void> => {
      reset();
      await bot.handleUpdate(update);
    };

    // -----------------------------------------------------------------------
    console.log('\n/start');
    // -----------------------------------------------------------------------

    await feed(textUpdate('/start'));
    check('/start replies', texts().length > 0, texts());
    check(
      'and asks for the store code',
      texts().some((text) => /mağaza kod/i.test(text)),
      texts(),
    );
    check(
      'and offers no store catalogue — the code is the enrolment gate',
      inlineButtons().length === 0,
      inlineButtons(),
    );

    // -----------------------------------------------------------------------
    console.log('\nthe store code');
    // -----------------------------------------------------------------------

    await feed(textUpdate(STORE_CODE));
    check(
      'a valid store code is accepted',
      texts().some((t) => /təsdiqləndi/i.test(t)),
      texts(),
    );
    check(
      'and the main menu comes back',
      replyButtons().some((button) => button.text.includes('Tapşırıqlar')),
      replyButtons(),
    );

    // The claim happened on the way in, which is what makes the task assignable.
    const claimed = await db.query('SELECT assigned_user_id FROM store_tasks WHERE id = $1', [
      taskId,
    ]);
    const assignedTo = claimed.rows[0]?.assigned_user_id;
    check('and the store code claimed the open task', typeof assignedTo === 'string', assignedTo);
    if (typeof assignedTo === 'string') userId = assignedTo;

    // -----------------------------------------------------------------------
    console.log('\n/tasks and the task list');
    // -----------------------------------------------------------------------

    await feed(textUpdate('/tasks'));
    check(
      'the task list is sent',
      texts().some((t) => t.includes(`Router suite`)),
      texts(),
    );
    const openButton = openTaskButton();
    check(
      'every task carries an `open:` button',
      openButton?.data === `open:${taskId}`,
      inlineButtons(),
    );

    if (!openButton) {
      skip('every check after the task list', 'the task list offered no button that opens a task');
      return;
    }
    if (openButton.legacy) {
      console.log('      · walking the flow with the legacy `submit_` button');
    }

    // -----------------------------------------------------------------------
    console.log('\nopening the task — the location step');
    // -----------------------------------------------------------------------

    const taskCardMessageId = nextMessageId - 1;
    await feed(callbackUpdate(openButton.data, taskCardMessageId));

    check('tapping the task is acknowledged', callbackAnswers().length > 0, {
      answers: callbackAnswers(),
    });
    check(
      'and the location is requested',
      texts().some((t) => /Lokasiya/.test(t)),
      texts(),
    );
    check(
      'with a button that can actually send a location',
      replyButtons().some((button) => button.requestLocation),
      replyButtons(),
    );

    // -----------------------------------------------------------------------
    console.log('\nthe location — the route that did not exist');
    // -----------------------------------------------------------------------

    await feed(locationUpdate(40.3724, 49.8372));
    check(
      'a shared location is answered at all',
      texts().length > 0,
      'the bot said nothing — no `message:location` route',
    );
    check(
      'and it is confirmed to the merchandiser',
      texts().some((text) => /Lokasiya qeydə alındı/i.test(text)),
      texts(),
    );
    check(
      'and the first checklist question follows',
      inlineButtons().some((button) => button.data.startsWith('chk:')),
      inlineButtons(),
    );
    // #73: the API stores the question under `label` and the bot used to read
    // only `question`, so every question rendered as the word "undefined". The
    // bridge in `questionText` reads both; this keeps the symptom from coming
    // back quietly. The contract decision itself is still open — see #73.
    check(
      'and the question text is the real question, not "undefined"',
      texts().some((text) => text.includes('Coca-Cola Classic')) &&
        !texts().some((text) => text.includes('undefined')),
      texts(),
    );

    // -----------------------------------------------------------------------
    console.log('\nthe checklist');
    // -----------------------------------------------------------------------

    const yesData = buttonDataWithText('Bəli');
    check('the boolean question offers answer buttons', Boolean(yesData), inlineButtons());

    // The home button has to be SENT, not merely produced somewhere in the
    // source. The static check at the end of this suite can only see that
    // `encodeCallback('menu'` appears in a file, which is equally true of a
    // helper that nothing calls — and an unused helper is precisely how
    // `menu:home` came to be unreachable in the first place. This is the check
    // that fails if the flow stops attaching it.
    check(
      'and the flow offers a way back to the menu',
      Boolean(buttonDataStartingWith('menu:')),
      inlineButtons(),
    );

    if (!yesData) {
      skip('the rest of the checklist', 'the boolean question had no buttons');
    } else {
      await feed(callbackUpdate(yesData, nextMessageId - 1));
      check('tapping an answer is acknowledged', callbackAnswers().length > 0, {
        answers: callbackAnswers(),
      });
      check(
        'and the next question is asked',
        texts().some((text) => /2\/2/.test(text)),
        texts(),
      );
    }

    // The number question has no buttons: the answer is typed.
    await feed(textUpdate('4'));
    check(
      'a typed number answer moves the flow on',
      texts().some((text) => /Addım 3\/3|Şəkil/.test(text)),
      texts(),
    );

    // -----------------------------------------------------------------------
    console.log('\nthe photo — and the confirm step');
    // -----------------------------------------------------------------------

    await feed(photoUpdate(`file-router-${RUN}-A`));
    check(
      'the photo is shown back to the merchandiser',
      sent.some((call) => call.method === 'sendPhoto'),
      sent.map((call) => call.method),
    );
    check(
      'and nothing is filed yet',
      (await evidenceCount(taskId)) === 0,
      'a submission exists before the confirm button was tapped',
    );

    const confirmData = buttonDataStartingWith('confirm:');
    const retakeData = buttonDataStartingWith('retake:');
    check('and a confirm button is offered', confirmData === `confirm:${taskId}`, inlineButtons());
    check('and a re-shoot button is offered', retakeData === `retake:${taskId}`, inlineButtons());
    check(
      'and the home button is offered here too',
      Boolean(buttonDataStartingWith('menu:')),
      inlineButtons(),
    );

    // -----------------------------------------------------------------------
    console.log('\nre-shooting');
    // -----------------------------------------------------------------------

    if (retakeData) {
      const confirmMessageId = nextMessageId - 1;
      await feed(callbackUpdate(retakeData, confirmMessageId));
      check('re-shooting is acknowledged', callbackAnswers().length > 0, {
        answers: callbackAnswers(),
      });
      check(
        'and the photo is asked for again',
        texts().some((text) => /foto|şəkil/i.test(text)),
        texts(),
      );
      check('and still nothing is filed', (await evidenceCount(taskId)) === 0);
    } else {
      skip('re-shooting', 'no retake button was offered');
    }

    // -----------------------------------------------------------------------
    console.log('\nconfirming — the audit is filed exactly once');
    // -----------------------------------------------------------------------

    await feed(photoUpdate(`file-router-${RUN}-B`));
    const finalConfirmData = buttonDataStartingWith('confirm:');
    const confirmMessageId = nextMessageId - 1;

    if (!finalConfirmData) {
      skip('confirming', 'no confirm button was offered after the second photo');
    } else {
      await feed(callbackUpdate(finalConfirmData, confirmMessageId));

      const filedCount = await waitForEvidenceCount(taskId, 1);
      check('confirming files exactly one audit', filedCount === 1, { filed: filedCount });
      check(
        'and the merchandiser is told it was received',
        texts().some((text) => /qeydə alındı|Təşəkkür/i.test(text)),
        texts(),
      );

      const taskRow = await db.query('SELECT status FROM store_tasks WHERE id = $1', [taskId]);
      check(
        'and the task moved to SUBMITTED',
        taskRow.rows[0]?.status === 'SUBMITTED',
        taskRow.rows[0],
      );

      // ---------------------------------------------------------------------
      console.log('\na duplicate tap on confirm');
      // ---------------------------------------------------------------------

      const errorsBefore = botErrors.length;

      await feed(callbackUpdate(finalConfirmData, confirmMessageId));

      check(
        'the duplicate tap is answered, so the button stops spinning',
        callbackAnswers().length > 0,
        { answers: callbackAnswers() },
      );

      // The wait is the point, not padding. `createEvidence` is queued, so a
      // second write triggered by a broken guard would land a moment later —
      // and a check that read the count immediately would pass while the second
      // audit was still on its way.
      await sleep(1_500);
      const evidenceAfter = await evidenceCount(taskId);
      check('and it does not file a second audit', evidenceAfter === filedCount, {
        before: filedCount,
        after: evidenceAfter,
      });
      check(
        'and it raises no error',
        botErrors.length === errorsBefore,
        botErrors.slice(errorsBefore),
      );
      check(
        'and it does not re-send the receipt',
        !texts().some((text) => /Təşəkkür/i.test(text)),
        texts(),
      );

      // ---------------------------------------------------------------------
      console.log('\nthe session afterwards');
      // ---------------------------------------------------------------------

      const sessionRow = await db.query(
        'SELECT step, active_task_id, pending_photo FROM bot_sessions WHERE chat_id = $1',
        [String(CHAT_ID)],
      );
      check('the flow is back to idle', sessionRow.rows[0]?.step === 'idle', sessionRow.rows[0]);
      check(
        'and the task is released',
        sessionRow.rows[0]?.active_task_id === null,
        sessionRow.rows[0],
      );
      check(
        'and the unconfirmed photo is gone',
        sessionRow.rows[0]?.pending_photo === null,
        sessionRow.rows[0],
      );
    }

    // -----------------------------------------------------------------------
    console.log('\nthe text fallback — phase 2.4');
    // -----------------------------------------------------------------------

    // 2.4 is accepted on "/help shows the menu". Which menu is the whole
    // question, because a message carries one `reply_markup` and never both: a
    // reply keyboard and an inline keyboard cannot be sent together. For a
    // message that answers a TYPED command the reply keyboard is the one that
    // helps — it survives being scrolled past, and it is the only kind that can
    // be brought back by typing. That last part is the actual requirement: the
    // location step sends a `oneTime()` reply keyboard, so using it dismisses
    // the menu, and before 2.4 nothing in the bot put it back.
    const menuLabels = (): string[] => replyButtons().map((button) => button.text);
    const menuIsOffered = (): boolean =>
      menuLabels().some((label) => label.includes('Tapşırıqlar')) &&
      menuLabels().some((label) => label.includes('Statusum'));

    await feed(textUpdate('/help'));
    check(
      '/help answers',
      texts().some((text) => text.includes('Köməkçi')),
      texts(),
    );
    check('and shows the menu', menuIsOffered(), menuLabels());
    check(
      'and explains the six steps before it lists any command',
      texts().some((text) => text.includes('6 addım')),
      texts(),
    );

    await feed(textUpdate('/mystatus'));
    check('/mystatus answers', texts().length > 0, texts());
    check('and restores the menu too', menuIsOffered(), menuLabels());

    await feed(textUpdate('/tasks'));
    check('/tasks restores the menu as well', menuIsOffered(), menuLabels());

    // `/start` is the most-typed command in Telegram — the client sends it when
    // the chat is opened from the chat list, and people type it when they are
    // lost. For a chat that is already enrolled it must mean "take me home".
    await feed(textUpdate('/start'));
    // Matched on the welcome line, not on the phrase "mağaza kodunu göndərin".
    // That phrase was the first attempt and it could never match: the real text
    // is "təmsil etdiyiniz *Mağaza Kodunu* göndərin", with capitals and a `*`
    // between the words. The check passed while the behaviour was broken, which
    // is what break-the-detector caught — an assertion that cannot fail is
    // worse than no assertion, because it is counted as evidence.
    check(
      '/start on an enrolled chat does not send the enrolment prompt again',
      !texts().some((text) => /Xoş Gəlmisiniz/i.test(text)),
      texts(),
    );
    check(
      'and it answers with the home screen, naming the store',
      texts().some((text) => text.includes('Router Test Mağazası')),
      texts(),
    );
    check('and offers the menu', menuIsOffered(), menuLabels());

    const afterStart = await db.query('SELECT step FROM bot_sessions WHERE chat_id = $1', [
      String(CHAT_ID),
    ]);
    check(
      'and it did not write `awaiting_store_code` over the session',
      afterStart.rows[0]?.step !== 'awaiting_store_code',
      afterStart.rows[0],
    );

    // The same command mid-flow. This is the derailment 2.4 fixes: `/start`
    // used to overwrite `step`, so a merchandiser half way through a checklist
    // who typed it was sent back to enrolment with their flow broken.
    await feed(textUpdate('/tasks'));
    const reopen = openTaskButton();
    if (!reopen) {
      skip('the mid-flow /start check', 'the task list offered no button that opens a task');
    } else {
      await feed(callbackUpdate(reopen.data, nextMessageId - 1));
      const midFlow = await db.query('SELECT step FROM bot_sessions WHERE chat_id = $1', [
        String(CHAT_ID),
      ]);
      check(
        're-opening the task puts the flow back on the location step',
        midFlow.rows[0]?.step === 'awaiting_location',
        midFlow.rows[0],
      );

      await feed(textUpdate('/start'));
      const stillThere = await db.query('SELECT step FROM bot_sessions WHERE chat_id = $1', [
        String(CHAT_ID),
      ]);
      check(
        'and /start mid-flow leaves the step alone',
        stillThere.rows[0]?.step === 'awaiting_location',
        stillThere.rows[0],
      );
    }

    // -----------------------------------------------------------------------
    console.log('\nno callback action is unreachable');
    // -----------------------------------------------------------------------

    // THE ONE CHECK IN THIS SUITE THAT DOES NOT DRIVE THE BOT, and that is the
    // point of it. Driving can only reach actions that are already reachable,
    // so no amount of walking can find an action that nothing emits. That is
    // exactly how `menu:home` sat in the router — handled, implemented in
    // `handleMenuHome`, and produced by no button anywhere. It is the same
    // defect Phase 2.1 found one level up (four handlers imported into
    // `index.ts` and called by nothing), but the 2.1 fix does not work here:
    // there the route was missing and the caller existed; here the caller is
    // what is missing, and only a static reading can see that.
    // WHAT THIS CHECK CAN AND CANNOT SEE
    // -----------------------------------
    // It sees that a file produces the action name. It does NOT see whether the
    // helper producing it is ever called — `encodeCallback('menu', 'home')` in
    // an unused helper would satisfy it. That gap is covered from the other
    // side by the driven checks ("and the flow offers a way back to the menu",
    // "and the home button is offered here too"), which assert the button is
    // actually SENT. One check for "nothing produces it", one for "the producer
    // is not wired".
    const emittedActions = new Set<string>();
    for (const file of readdirSync(BOT_SOURCE_DIR, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = readFileSync(path.join(BOT_SOURCE_DIR, file), 'utf8');
      for (const match of source.matchAll(/encodeCallback\(\s*'([a-z_]+)'/g)) {
        emittedActions.add(match[1]);
      }
    }
    for (const action of CALLBACK_ACTIONS) {
      check(
        `\`${action}:\` is produced by a button somewhere`,
        emittedActions.has(action),
        [...emittedActions].sort(),
      );
    }

    // -----------------------------------------------------------------------
    console.log('\nthe callback format');
    // -----------------------------------------------------------------------

    await feed(textUpdate('/tasks'));
    const all = inlineButtons();
    check('the task list offers at least one button', all.length > 0, all);
    check(
      'every button is `action:id`',
      all.every((button) => /^[a-z]+:.+/.test(button.data)),
      all.map((button) => button.data),
    );
    check(
      'and no button uses the old ad-hoc prefixes',
      all.every(
        (button) =>
          !button.data.startsWith('submit_') &&
          !button.data.startsWith('chk_') &&
          !button.data.startsWith('opt_'),
      ),
      all.map((button) => button.data),
    );

    // -----------------------------------------------------------------------
    console.log('\nno error was swallowed anywhere in the walk');
    // -----------------------------------------------------------------------

    check('the bot logged no middleware error', botErrors.length === 0, botErrors);
  } finally {
    console.error = realError;

    // -----------------------------------------------------------------------
    // Cleanup, in RESTRICT order.
    //
    // Every statement is guarded. An unguarded cleanup that throws on its first
    // line leaves the whole fixture behind — which is exactly what happened
    // while this suite was being written: one wrong column name stranded a
    // store, a task, a template and a user in the database, and the next run
    // reported a "baseline" that was not the baseline. A suite that can leave
    // garbage behind is worse than no suite, because it makes every later
    // measurement a little wrong.
    // -----------------------------------------------------------------------
    console.log('\ncleanup');

    const attempt = async (label: string, sql: string, params: unknown[]): Promise<void> => {
      try {
        await db.query(sql, params);
      } catch (error) {
        console.error(`  ! cleanup step "${label}" failed:`, (error as Error).message);
      }
    };

    if (taskId) {
      // The audit trail's evidence rows name the EVIDENCE, not the task, and
      // carry no actor — so their ids have to be collected before the rows they
      // describe are deleted, or they become unreachable garbage.
      const evidenceRows = await db.query(
        'SELECT id FROM task_evidences WHERE store_task_id = $1',
        [taskId],
      );
      evidenceIds = evidenceRows.rows.map((row: { id: string }) => row.id);

      await attempt('audits', 'DELETE FROM task_evidences WHERE store_task_id = $1', [taskId]);
      // The outbox is the third thing that names the task, and it is the one
      // that does not cascade: `notifications.store_task_id` has no foreign key,
      // deliberately, so that a supervisor can delete a task without the outbox
      // refusing. The price is that this has to be said explicitly. Measured
      // before this line existed: every run left exactly one `TASK_ASSIGNED` row
      // whose task no longer existed, while the suite reported itself clean.
      await attempt('the queued notice', 'DELETE FROM notifications WHERE store_task_id = $1', [
        taskId,
      ]);
      await attempt('the task', 'DELETE FROM store_tasks WHERE id = $1', [taskId]);
    }
    if (userId) {
      await attempt('the session by user', 'DELETE FROM bot_sessions WHERE user_id = $1', [userId]);
    }
    await attempt('the session by chat', 'DELETE FROM bot_sessions WHERE chat_id = $1', [
      String(CHAT_ID),
    ]);
    if (userId) {
      // `task_evidences.submitted_by_id` is RESTRICT, so the audit had to go
      // first; `panel_tokens`/`device_tokens` cascade.
      await attempt('the user', 'DELETE FROM users WHERE id = $1', [userId]);
    }
    if (storeId) {
      await attempt('the store', 'DELETE FROM stores WHERE id = $1', [storeId]);
    }
    // The template has no store task left, so it is an orphan now — deleted
    // directly, because no endpoint lists or deletes one. That gap is recorded
    // as the "orphan templates" debt.
    if (templateId) {
      await attempt('the template', 'DELETE FROM task_templates WHERE id = $1', [templateId]);
    }
    // The audit trail is append-only in production and this suite writes to it
    // through the API — binding a chat, claiming a task, filing an audit. Those
    // rows are keyed by the actor and by the entity, so they can be removed
    // without touching anything the seed created.
    if (userId || taskId || storeId) {
      await attempt(
        'the audit trail',
        'DELETE FROM audit_logs WHERE actor_id = $1 OR entity_id = ANY($2::text[])',
        [userId ?? null, [taskId, storeId, ...evidenceIds].filter(Boolean)],
      );
    }

    // The API is stopped BEFORE the final count, not after the assertion.
    //
    // It runs the deadline sweep on a timer, and that sweep reads the in-memory
    // replica, which still holds a deleted fixture for up to one refresh
    // interval. A tick landing between the cleanup and the count could therefore
    // write one more row — and the "clean" check would go red for a reason that
    // has nothing to do with this suite's cleanup, or worse, would have to be
    // loosened to tolerate it. A writer that is still running cannot be used to
    // prove that nothing more will be written. `stopApi` is idempotent, so the
    // call in the `finally` stays as the safety net.
    await stopApi();

    const after = {
      stores: await countOf('stores'),
      storeTasks: await countOf('store_tasks'),
      templates: await countOf('task_templates'),
      evidences: await countOf('task_evidences'),
      users: await countOf('users'),
      sessions: await countOf('bot_sessions'),
      audits: await countOf('audit_logs'),
      notifications: await countOf('notifications'),
    };
    console.log(`  · rows before: ${JSON.stringify(before)}`);
    console.log(`  · rows after:  ${JSON.stringify(after)}`);

    // A suite that leaves rows behind makes the NEXT suite's measurements
    // wrong, so its own cleanliness is asserted rather than assumed.
    check(
      'every fixture row this suite created is gone again',
      JSON.stringify(before) === JSON.stringify(after),
      { before, after },
    );

    await db.end();
    await stopApi();
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('\nThe suite could not finish:', error);
    process.exit(1);
  });
