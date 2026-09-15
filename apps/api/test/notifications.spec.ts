/**
 * oneTeam — notification suite (Phase 2.3)
 * ============================================================================
 *
 * THE ACCEPTANCE CRITERION, VERBATIM FROM THE PLAN
 * ------------------------------------------------
 *
 *   2.3 Bildiriş: tapşırıq yaradılması / vaxt bitməsi / rədd 15 dəq əvvəl ->
 *       `sendMessage` + inline `Open` düyməsi.
 *   Qəbul: Supervayzer panelində yaradanda bot bildiriş alır.
 *
 * "The bot receives a notification when it is created in the supervisor panel."
 * That sentence is the whole suite, and it is why nothing here stops at "the API
 * returned 200". A `200` is what the old code returned too:
 *
 *     dispatchedTelegramMessages.push(telegramPayload);
 *     return { telegram: true, pushNotification: true };
 *
 * Three assertions in the existing suites passed against that, because they read
 * the same in-memory array the dispatcher had just written. The array was
 * emptied on every deploy. Nothing was ever sent, and the tests agreed with it.
 *
 * SO EVERY CHECK HERE IS ON A THING THAT OUTLIVES THE PROCESS
 * ----------------------------------------------------------
 *   - the row in `notifications`, read over a direct `pg` connection the API
 *     knows nothing about
 *   - the `sendMessage` the REAL bot made, through its own middleware, with only
 *     Telegram's HTTP API replaced by a stub
 *   - the row's state after that send: `delivered_at`, not a return value
 *
 * The API runs in a child process on its own port; the bot runs in this process
 * against that API. If the bot does not send, the check fails — there is no
 * array to read and no boolean to trust.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It does not call `NotificationDispatcherService` directly, and it does not
 * drive `TaskStateService`. Those would prove the dispatcher dispatches, which
 * was never in doubt. The criterion is about the PANEL, so the task is created
 * through `POST /api/portal/tasks` — the route the panel's form posts to — and
 * the rejection through `POST /api/portal/submissions/:id/review`.
 *
 * That choice found a real defect while this suite was being written. See
 * "the panel's own path" below: the explicit-store dispatch that the panel uses
 * queued nothing at all, so the acceptance criterion failed on the only route a
 * supervisor actually takes.
 *
 * WHAT IT CLEANS UP
 * -----------------
 * Every row it creates, in RESTRICT order, and the last check asserts the counts
 * are back where they started. It refuses to run with NODE_ENV=production.
 *
 * Prerequisites: PostgreSQL reachable, and `apps/api/dist/main.js` built
 * (`npm run api:build`).
 *
 *   npm run test:notify
 */

if (process.env.NODE_ENV === 'production') {
  console.error(
    'Refusing to run: this suite starts its own API and writes rows. It is a development suite.',
  );
  process.exit(1);
}

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

// `fetch` honours HTTP_PROXY and this suite talks to 127.0.0.1. Set before the
// first request so undici builds its agent without a proxy.
process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

/** Its own port, so 3111/3121/3131 stay with their suites. */
const PORT = Number(process.env.ONETEAM_TEST_NOTIFY_PORT || 3141);
const API_BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';

/**
 * The service credential — the one the bot holds.
 *
 * It is allowed on the supervisor routes only while the panel has no key of its
 * own (`panelAuthStatus.required === false`). This suite asserts that premise
 * rather than assuming it, because if a panel key were ever minted into this
 * database the suite would start failing with 403s on routes that have nothing
 * to do with the failure.
 */
const SERVICE_TOKEN = process.env.ONETEAM_TEST_ADMIN_TOKEN || 'oneteam-user:usr-admin-001';

const REPO_ROOT = process.cwd();
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');

/** Unique per run, so two runs against one database do not collide. */
const RUN = Date.now().toString(36).toUpperCase();

const STORE_CODE = `NTF${RUN.slice(-4)}`;
const CHAT_BOUND = '998877665'; // the seeded merchandiser's chat
const USER_BOUND = 'usr-merch-003';
const USER_UNBOUND = `usr-notify-null-${RUN}`; // a merchandiser who never opened the bot

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

/**
 * Waits for something to become true.
 *
 * Every check that depends on a timer — the sweep, the drain loop — uses this
 * rather than a fixed sleep, so a suite on a slow machine waits instead of
 * failing, and a suite on a fast one does not idle.
 */
async function waitFor(
  describe: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  console.log(`      (timed out waiting for: ${describe})`);
  return false;
}

// ---------------------------------------------------------------------------
// Direct database access — the API knows nothing about this connection
// ---------------------------------------------------------------------------

let db: Client;

async function query(sql: string, params: unknown[] = []): Promise<any[]> {
  const result = await db.query(sql, params as any[]);
  return result.rows;
}

async function countOf(table: string): Promise<number> {
  const rows = await query(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(rows[0]?.n ?? -1);
}

async function notificationByKey(dedupeKey: string): Promise<any | null> {
  const rows = await query('SELECT * FROM notifications WHERE dedupe_key = $1', [dedupeKey]);
  return rows[0] ?? null;
}

async function notificationsForTask(taskId: string): Promise<any[]> {
  return query('SELECT * FROM notifications WHERE store_task_id = $1 ORDER BY created_at', [
    taskId,
  ]);
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
      // ON, not off. The deadline sweep reads the in-memory replica, and this
      // suite writes its deadline fixtures straight to Postgres. With the
      // refresh loop disabled — which the other suites do, and which cost an
      // hour here — the API never learns those rows exist, the sweep finds
      // nothing, and the failure looks like a broken sweep rather than a stale
      // replica. One second, so the fixtures appear within about that long.
      ONETEAM_REFRESH_MS: '1000',
      ONETEAM_BOT_SWEEP_MS: '0',
      // One second instead of the default minute, so the suite can watch the
      // deadline sweep happen rather than waiting for it. The window it sweeps
      // (fifteen minutes) is not configurable and is tested as it ships.
      ONETEAM_NOTIFY_SWEEP_MS: '1000',
      // A panel key would close the supervisor routes to the service
      // credential. This suite needs them open, and asserts that they are.
      ONETEAM_PANEL_BOOTSTRAP_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const collect = (chunk: Buffer) => {
    apiLog.push(chunk.toString());
    if (apiLog.length > 500) apiLog.shift();
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

interface Result {
  status: number;
  body: any;
}

async function call(
  method: string,
  requestPath: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token ?? SERVICE_TOKEN}`,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE}${requestPath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// The Telegram stub — the only thing replaced
// ---------------------------------------------------------------------------

interface SentCall {
  method: string;
  payload: Record<string, any>;
}

const sent: SentCall[] = [];

/**
 * Per-chat behaviour, so a test can make Telegram refuse one message.
 *
 * Set to a function that throws to simulate a terminal refusal (403, blocked
 * bot) or a transient one (a bare network error).
 */
let sendBehaviour: ((payload: Record<string, any>) => void) | null = null;

function installTelegramStub(bot: any): void {
  bot.api.config.use(async (_prev: unknown, method: string, payload: Record<string, any>) => {
    sent.push({ method, payload });

    if (method === 'sendMessage' && sendBehaviour) sendBehaviour(payload);

    if (method === 'getMe') {
      return {
        ok: true,
        result: {
          id: 1,
          is_bot: true,
          first_name: 'oneTeam',
          username: 'oneteam_notify_suite_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        } as any,
      };
    }

    return {
      ok: true,
      result: {
        message_id: 5000 + sent.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(payload?.chat_id) || 0, type: 'private' },
        text: payload?.text ?? '',
      } as any,
    };
  });
}

function sentMessages(): SentCall[] {
  return sent.filter((entry) => entry.method === 'sendMessage');
}

/** Every `sendMessage` whose body contains this text. */
function messagesContaining(text: string): SentCall[] {
  return sentMessages().filter((entry) => String(entry.payload.text ?? '').includes(text));
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  // Fixtures this suite created, for the cleanup and the final count check.
  let storeId: string | undefined;
  /**
   * Every briefing this suite authored, not just the first.
   *
   * `POST /api/portal/tasks` creates a template per call, and this suite calls
   * it four times. Tracking only the first left three orphan templates behind,
   * which the final count check caught.
   */
  const templateIds: string[] = [];
  const taskIds: string[] = [];
  const evidenceIds: string[] = [];
  /** Notifications written directly by the suite, not through the API. */
  const injectedNotificationIds: string[] = [];
  let countBefore: Record<string, number> = {};

  /** Records what a panel dispatch created, so the cleanup can find it again. */
  function track(result: Result): string | undefined {
    const id: string | undefined = result.body?.data?.taskIds?.[0];
    if (id) taskIds.push(id);
    const template: string | undefined = result.body?.data?.templateId;
    if (template) templateIds.push(template);
    return id;
  }

  try {
    await startApi();
    console.log('  · the API is up on its own port');

    // Read the baseline only now: the `notifications` table is created by the
    // migration the API applies at boot, so before this it may not exist.
    countBefore = {
      notifications: await countOf('notifications'),
      store_tasks: await countOf('store_tasks'),
      task_templates: await countOf('task_templates'),
      task_evidences: await countOf('task_evidences'),
      audit_logs: await countOf('audit_logs'),
      stores: await countOf('stores'),
      users: await countOf('users'),
    };

    // -----------------------------------------------------------------------
    console.log('\nthe premise: the supervisor routes are open to the service credential');
    // -----------------------------------------------------------------------

    const authStatus = await call('GET', '/api/panel/auth-status');
    check(
      'the panel has no key of its own, so the service credential can use /api/portal/tasks',
      authStatus.status === 200 && authStatus.body?.data?.required === false,
      authStatus.body,
    );

    // -----------------------------------------------------------------------
    console.log('\nfixtures');
    // -----------------------------------------------------------------------

    // A merchandiser who has never spoken to the bot. Created directly because
    // no endpoint can produce one: binding is what sets a chat id, and that is
    // the thing being absent.
    await query(
      `INSERT INTO users (id, email, full_name, role, telegram_chat_id)
       VALUES ($1, $2, $3, 'MERCHANDISER', NULL)`,
      [USER_UNBOUND, `${USER_UNBOUND}@test.local`, `Bağlanmamış işçi ${RUN}`],
    );
    check(
      'a merchandiser with no Telegram chat exists',
      (await query('SELECT telegram_chat_id FROM users WHERE id = $1', [USER_UNBOUND]))[0]
        ?.telegram_chat_id === null,
    );

    const store = await call('POST', '/api/portal/stores', {
      body: {
        store_code: STORE_CODE,
        name: `Bildiriş Testi Mağazası ${RUN}`,
        address: 'Test ünvanı 2, Bakı',
        latitude: 40.3724,
        longitude: 49.8372,
      },
    });
    storeId = store.body?.data?.id;
    check('the fixture store is created', store.status === 201 && Boolean(storeId), store.body);

    if (!storeId) {
      skip('every check below', 'the fixture store could not be created');
      return;
    }

    // -----------------------------------------------------------------------
    console.log('\nthe panel creates a task — the acceptance criterion');
    // -----------------------------------------------------------------------

    const created = await call('POST', '/api/portal/tasks', {
      body: {
        title: `Rəf yoxlaması ${RUN}`,
        description: 'Bildiriş testi üçün müvəqqəti brifinq.',
        priority: 'HIGH',
        deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        assigned_stores: [storeId],
        assignedUserId: USER_BOUND,
      },
    });

    const taskId = track(created);

    check(
      'the panel dispatch creates the task',
      created.status === 201 && Boolean(taskId),
      created.body,
    );

    if (!taskId) {
      skip('every notification check', 'the fixture task could not be dispatched');
      return;
    }

    check(
      'and reports one notification queued — not "sent"',
      created.body?.data?.notificationsDispatched?.queued === 1,
      created.body?.data?.notificationsDispatched,
    );

    const assigned = await notificationByKey(`TASK_ASSIGNED:${taskId}`);
    check('a row is in the outbox', assigned !== null, assigned);
    check(
      'addressed to the assignee\u2019s chat',
      assigned?.chat_id === CHAT_BOUND,
      assigned?.chat_id,
    );
    check('and to the assignee\u2019s user', assigned?.user_id === USER_BOUND, assigned?.user_id);
    check(
      'tagged with the task it is about',
      assigned?.store_task_id === taskId,
      assigned?.store_task_id,
    );
    check(
      'with the kind the deadline sweep and the rejections share',
      assigned?.kind === 'TASK_ASSIGNED',
      assigned?.kind,
    );
    check(
      'and nothing has been claimed or delivered yet',
      assigned?.claimed_at === null && assigned?.delivered_at === null && assigned?.attempts === 0,
      {
        claimed_at: assigned?.claimed_at,
        delivered_at: assigned?.delivered_at,
        attempts: assigned?.attempts,
      },
    );

    // The body must be built from THIS task, not from a hardcoded sentence.
    // The code this replaced announced every task with "Coca-Cola Classic, Zero
    // Sugar və Fanta" regardless of what the task actually asked for.
    check(
      'the body names the real store',
      typeof assigned?.body === 'string' &&
        assigned.body.includes(`Bildiriş Testi Mağazası ${RUN}`),
      assigned?.body,
    );
    check(
      'and the real briefing title',
      typeof assigned?.body === 'string' && assigned.body.includes(`Rəf yoxlaması ${RUN}`),
      assigned?.body,
    );
    check(
      'and says nothing about products the task never mentioned',
      typeof assigned?.body === 'string' && !/Fanta|Zero Sugar/i.test(assigned.body),
      assigned?.body,
    );

    // -----------------------------------------------------------------------
    console.log('\nan assignee with no chat binding');
    // -----------------------------------------------------------------------

    const orphan = await call('POST', '/api/portal/tasks', {
      body: {
        title: `Bağlanmamış tapşırıq ${RUN}`,
        description: 'Chat bağlaması olmayan işçi üçün.',
        deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        assigned_stores: [storeId],
        assignedUserId: USER_UNBOUND,
      },
    });
    const orphanTaskId = track(orphan);

    check(
      'the dispatch still creates the task',
      orphan.status === 201 && Boolean(orphanTaskId),
      orphan.body,
    );
    check(
      'and counts it as having no destination rather than as queued',
      orphan.body?.data?.notificationsDispatched?.withoutRecipient === 1 &&
        orphan.body?.data?.notificationsDispatched?.queued === 0,
      orphan.body?.data?.notificationsDispatched,
    );

    const orphanRow = orphanTaskId
      ? await notificationByKey(`TASK_ASSIGNED:${orphanTaskId}`)
      : null;
    check(
      'the row is kept with a NULL chat rather than dropped',
      orphanRow !== null && orphanRow.chat_id === null,
      orphanRow,
    );

    // -----------------------------------------------------------------------
    console.log('\nthe claim is a lease, not a read');
    // -----------------------------------------------------------------------

    const firstClaim = await call('GET', `/api/portal/field/notifications?chatId=${CHAT_BOUND}`);
    const claimedIds = (firstClaim.body?.data ?? []).map((row: any) => row.id);
    check(
      'the bot can claim what is waiting for a chat',
      firstClaim.status === 200 && claimedIds.includes(assigned?.id),
      firstClaim.body,
    );
    check(
      'and the row carries the task id the open button needs',
      (firstClaim.body?.data ?? []).some((row: any) => row.taskId === taskId),
      firstClaim.body?.data,
    );
    check(
      'and the row that has nowhere to go is not claimable',
      !(firstClaim.body?.data ?? []).some((row: any) => row.id === orphanRow?.id),
      firstClaim.body?.data,
    );

    /**
     * WHY EVERY "RETURNS NOTHING" CHECK ALSO ASSERTS THE STATUS
     * --------------------------------------------------------
     * "the second claim returns nothing" used to read
     *
     *     (secondClaim.body?.data ?? []).length === 0
     *
     * which is TRUE when the endpoint answers 500, because there is no `data` to
     * be non-empty. Break-the-detector found it: a break that made the claim
     * query throw turned that check green. An assertion that cannot fail is
     * worse than no assertion, because it is counted as evidence.
     */
    const emptyClaim = (result: Result): boolean =>
      result.status === 200 && Array.isArray(result.body?.data) && result.body.data.length === 0;

    const secondClaim = await call('GET', `/api/portal/field/notifications?chatId=${CHAT_BOUND}`);
    check(
      'a second claim returns nothing — the row is leased, so two bot instances cannot both send it',
      emptyClaim(secondClaim),
      secondClaim.body,
    );

    // The lease is a timestamp, so a bot killed mid-send does not strand the
    // row. Moved back directly, because waiting two minutes is not a test.
    await query(
      "UPDATE notifications SET claimed_at = now() - interval '10 minutes' WHERE id = $1",
      [assigned?.id],
    );
    const reClaim = await call('GET', `/api/portal/field/notifications?chatId=${CHAT_BOUND}`);
    check(
      'an expired lease makes the row available again',
      reClaim.status === 200 &&
        (reClaim.body?.data ?? []).some((row: any) => row.id === assigned?.id),
      reClaim.body,
    );
    const attemptsAfter = await query('SELECT attempts FROM notifications WHERE id = $1', [
      assigned?.id,
    ]);
    check(
      'and each claim that actually took the row is counted — the empty one is not',
      Number(attemptsAfter[0]?.attempts) === 2,
      attemptsAfter[0],
    );

    // Put the lease back so the delivery checks below start from a clean claim.
    await query(
      "UPDATE notifications SET claimed_at = now() - interval '10 minutes' WHERE id = $1",
      [assigned?.id],
    );

    // -----------------------------------------------------------------------
    console.log('\nthe bot sends it — the real bot, with only Telegram replaced');
    // -----------------------------------------------------------------------

    const { createBot } = await import('../../../src/bot/index.js');
    const { NotificationDrain } = await import('../../../src/bot/notifications.js');

    const bot = createBot('mockBotToken:notify-suite');
    installTelegramStub(bot);
    await bot.init();
    check('the bot initialises against the stub', bot.isInited());

    // The opt-out rule, before anything starts a loop: `0` disables delivery and
    // says so, rather than looking like a bug the first time nobody is notified.
    const previousPoll = process.env.ONETEAM_NOTIFY_POLL_MS;
    process.env.ONETEAM_NOTIFY_POLL_MS = '0';
    const disabledDrain = new NotificationDrain(bot, {});
    check('ONETEAM_NOTIFY_POLL_MS=0 switches delivery off', disabledDrain.start() === false);
    disabledDrain.stop();
    if (previousPoll === undefined) delete process.env.ONETEAM_NOTIFY_POLL_MS;
    else process.env.ONETEAM_NOTIFY_POLL_MS = previousPoll;

    // The loop, not a direct call: the timer is part of what has to work, and a
    // check that only calls `drainOnce()` would not notice it never starting.
    const drain = new NotificationDrain(bot, { pollMs: 150, claimedBy: 'notify-suite' });
    check('the drain loop starts', drain.start() === true);

    const body = String(assigned?.body ?? '');
    const arrived = await waitFor(
      'the bot to send the task notification',
      async () => messagesContaining(body).length > 0,
    );
    check(
      'the bot sends the notification the panel caused',
      arrived,
      sentMessages().map((m) => m.payload.text),
    );

    const delivery = messagesContaining(body)[0];
    check(
      'to the merchandiser\u2019s chat',
      String(delivery?.payload.chat_id) === CHAT_BOUND,
      delivery?.payload.chat_id,
    );
    check('with the body the API wrote, unchanged', delivery?.payload.text === body, {
      sent: delivery?.payload.text,
      stored: body,
    });
    check(
      'and no parse_mode — a supervisor\u2019s free text cannot break the message',
      delivery?.payload.parse_mode === undefined,
      delivery?.payload.parse_mode,
    );

    const buttons = delivery?.payload?.reply_markup?.inline_keyboard ?? [];
    check(
      'with one inline button that opens the task',
      buttons.length === 1 &&
        buttons[0]?.length === 1 &&
        buttons[0][0]?.callback_data === `open:${taskId}`,
      buttons,
    );
    check(
      'and a label a merchandiser can read, not the callback data',
      typeof buttons[0]?.[0]?.text === 'string' &&
        buttons[0][0].text.includes('Tapşırığ') &&
        buttons[0][0].text !== buttons[0][0].callback_data,
      buttons[0]?.[0]?.text,
    );

    const markedDelivered = await waitFor('the outbox row to be marked delivered', async () => {
      const rows = await query('SELECT delivered_at FROM notifications WHERE id = $1', [
        assigned?.id,
      ]);
      return Boolean(rows[0]?.delivered_at);
    });
    check('and the outbox records that it was delivered', markedDelivered);

    // At-least-once means a duplicate is possible, but not here: the row is
    // delivered, so it is out of the claim predicate entirely.
    const beforeIdle = messagesContaining(body).length;
    await sleep(600); // four poll intervals
    check('a delivered message is not sent again', messagesContaining(body).length === beforeIdle, {
      before: beforeIdle,
      after: messagesContaining(body).length,
    });

    // The button's callback must be one the router answers, or the merchandiser
    // taps it and nothing happens. Read from the router's own vocabulary rather
    // than a second copy of it.
    const { parseCallback } = await import('../../../src/bot/callbacks.js');
    const parsed = parseCallback(buttons[0]?.[0]?.callback_data);
    check(
      'and the button\u2019s callback is one the router understands',
      parsed?.action === 'open' && parsed?.id === taskId,
      parsed,
    );

    drain.stop();

    // -----------------------------------------------------------------------
    console.log('\na chat Telegram refuses');
    // -----------------------------------------------------------------------

    const refusedChat = `refused-${RUN}`;
    const refusedId = `ntf-suite-refused-${RUN}`;
    await query(
      `INSERT INTO notifications (id, kind, chat_id, user_id, title, body, payload, dedupe_key)
       VALUES ($1, 'TASK_ASSIGNED', $2, NULL, 'Rədd edilən çat', 'Bu mesaj getməməlidir.', '{}'::jsonb, $3)`,
      [refusedId, refusedChat, `SUITE:${refusedId}`],
    );
    injectedNotificationIds.push(refusedId);

    sendBehaviour = (payload) => {
      if (String(payload.chat_id) !== refusedChat) return;
      // The shape grammY's GrammyError carries: a numeric code and a
      // description. 403 is "the user blocked the bot" — terminal.
      const error: any = new Error('Forbidden: bot was blocked by the user');
      error.error_code = 403;
      error.description = 'Forbidden: bot was blocked by the user';
      throw error;
    };

    const singlePass = new NotificationDrain(bot, { pollMs: 0, claimedBy: 'notify-suite-refusal' });
    const refusalSummary = await singlePass.drainOnce();

    check(
      'the refusal is reported as a failure, not as sent',
      refusalSummary.failed === 1 && refusalSummary.sent === 0,
      refusalSummary,
    );

    const refusedRow = await query('SELECT * FROM notifications WHERE id = $1', [refusedId]);
    check(
      'and the row records why, rather than being deleted',
      Boolean(refusedRow[0]?.failed_at) && String(refusedRow[0]?.failure ?? '').includes('403'),
      refusedRow[0],
    );

    const afterRefusal = await call('GET', `/api/portal/field/notifications?chatId=${refusedChat}`);
    check(
      'a permanently refused message is not claimed again',
      emptyClaim(afterRefusal),
      afterRefusal.body,
    );

    // -----------------------------------------------------------------------
    console.log('\na send that fails for a reason a retry can fix');
    // -----------------------------------------------------------------------

    const flakyChat = `flaky-${RUN}`;
    const flakyId = `ntf-suite-flaky-${RUN}`;
    await query(
      `INSERT INTO notifications (id, kind, chat_id, user_id, title, body, payload, dedupe_key)
       VALUES ($1, 'TASK_ASSIGNED', $2, NULL, 'Müvəqqəti xəta', 'Bu mesaj sonra getməlidir.', '{}'::jsonb, $3)`,
      [flakyId, flakyChat, `SUITE:${flakyId}`],
    );
    injectedNotificationIds.push(flakyId);

    sendBehaviour = (payload) => {
      if (String(payload.chat_id) !== flakyChat) return;
      // No `error_code`: a network failure, which says nothing about whether the
      // message would work later.
      throw new Error('fetch failed');
    };

    const flakySummary = await singlePass.drainOnce();
    check(
      'a transient failure is counted as deferred, not failed',
      flakySummary.deferred === 1 && flakySummary.failed === 0 && flakySummary.sent === 0,
      flakySummary,
    );

    const flakyRow = await query('SELECT * FROM notifications WHERE id = $1', [flakyId]);
    check(
      'and the row is left alone so the lease can expire',
      flakyRow[0]?.delivered_at === null && flakyRow[0]?.failed_at === null,
      flakyRow[0],
    );

    await query(
      "UPDATE notifications SET claimed_at = now() - interval '10 minutes' WHERE id = $1",
      [flakyId],
    );
    sendBehaviour = null;
    const retrySummary = await singlePass.drainOnce();
    check(
      'once the lease expires and Telegram is well again, the message goes out',
      retrySummary.sent === 1 && retrySummary.claimed === 1,
      retrySummary,
    );

    // -----------------------------------------------------------------------
    console.log('\nthe deadline reminder');
    // -----------------------------------------------------------------------

    /** A task the sweep should look at, written directly so its deadline is ours. */
    async function insertTask(options: {
      id: string;
      status: string;
      minutesFromNow: number;
      assignedUserId?: string | null;
    }): Promise<void> {
      await query(
        `INSERT INTO store_tasks
           (id, template_id, store_id, assigned_user_id, status, deadline, published_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), now(), now(), now())`,
        [
          options.id,
          templateIds[0],
          storeId,
          options.assignedUserId === undefined ? USER_BOUND : options.assignedUserId,
          options.status,
          options.minutesFromNow,
        ],
      );
      taskIds.push(options.id);
    }

    const dueSoonId = `task-due-soon-${RUN}`;
    const dueLaterId = `task-due-later-${RUN}`;
    const overdueId = `task-overdue-${RUN}`;
    const submittedId = `task-submitted-${RUN}`;
    const rejectedId = `task-rejected-${RUN}`;
    const noChatId = `task-due-no-chat-${RUN}`;

    await insertTask({ id: dueSoonId, status: 'PUBLISHED', minutesFromNow: 10 });
    await insertTask({ id: dueLaterId, status: 'PUBLISHED', minutesFromNow: 120 });
    await insertTask({ id: overdueId, status: 'PUBLISHED', minutesFromNow: -5 });
    await insertTask({ id: submittedId, status: 'SUBMITTED', minutesFromNow: 10 });
    await insertTask({ id: rejectedId, status: 'REJECTED', minutesFromNow: 10 });
    await insertTask({
      id: noChatId,
      status: 'PUBLISHED',
      minutesFromNow: 10,
      assignedUserId: null,
    });

    /**
     * The premise the sweep checks rest on: the API can see these tasks at all.
     *
     * The sweep reads the in-memory replica, and these rows were written
     * straight to Postgres, so there is a window in which the task exists and
     * the API has never heard of it. Without this wait the checks below would
     * measure the replica's staleness and call it a broken sweep.
     */
    const replicaCaughtUp = await waitFor(
      'the API replica to see the inserted deadline fixtures',
      async () => {
        const listed = await call('GET', '/api/portal/tasks');
        const ids = (listed.body?.data ?? []).map((task: any) => task.id);
        return ids.includes(dueSoonId) && ids.includes(rejectedId);
      },
      20_000,
    );
    check('the API replica picks up tasks written straight to the database', replicaCaughtUp);

    const reminded = await waitFor(
      'the deadline sweep to enqueue a reminder',
      async () => {
        return (await notificationByKey(`DEADLINE_SOON:${dueSoonId}`)) !== null;
      },
      20_000,
    );
    check('the sweep enqueues a reminder for a task due in ten minutes', reminded);

    const reminder = await notificationByKey(`DEADLINE_SOON:${dueSoonId}`);
    check('addressed to the assignee', reminder?.chat_id === CHAT_BOUND, reminder?.chat_id);
    check(
      'and saying how long is left',
      /\d+\s*dəqiqə/.test(String(reminder?.body ?? '')),
      reminder?.body,
    );

    // The sweep runs every second. Without the dedupe key this would be a
    // reminder per second for fifteen minutes.
    await sleep(2_500);
    const reminderRows = await notificationsForTask(dueSoonId);
    check(
      'and a repeating sweep does not enqueue it again',
      reminderRows.filter((row) => row.kind === 'DEADLINE_SOON').length === 1,
      reminderRows.length,
    );

    check(
      'a task due in two hours is not reminded about yet',
      (await notificationByKey(`DEADLINE_SOON:${dueLaterId}`)) === null,
    );
    check(
      'a task already past its deadline is not reminded about',
      (await notificationByKey(`DEADLINE_SOON:${overdueId}`)) === null,
    );
    check(
      'a task waiting on the supervisor is not reminded about',
      (await notificationByKey(`DEADLINE_SOON:${submittedId}`)) === null,
    );
    // Not "no row": the sweep records the intent and marks it as having nowhere
    // to go, exactly as the assignment path does. Dropping it would leave the
    // situation invisible — a task nobody is working on and no trace of why.
    await waitFor(
      'the sweep to record the destination-less reminder',
      async () => {
        return (await notificationByKey(`DEADLINE_SOON:${noChatId}`)) !== null;
      },
      10_000,
    );
    const noChatReminder = await notificationByKey(`DEADLINE_SOON:${noChatId}`);
    check(
      'a task with no assignee is recorded with no destination rather than skipped',
      noChatReminder !== null && noChatReminder.chat_id === null,
      noChatReminder,
    );

    // REJECTED is deliberately included: it is the merchandiser who has to redo
    // the work, which is exactly who a reminder is for.
    const rejectedReminded = await waitFor(
      'the rejected task to be reminded about',
      async () => {
        return (await notificationByKey(`DEADLINE_SOON:${rejectedId}`)) !== null;
      },
      20_000,
    );
    check(
      'a rejected task is still the merchandiser\u2019s, so it is reminded about',
      rejectedReminded,
    );

    // -----------------------------------------------------------------------
    console.log('\nthe rejection notice');
    // -----------------------------------------------------------------------

    const reviewTask = await call('POST', '/api/portal/tasks', {
      body: {
        title: `Rədd testi ${RUN}`,
        description: 'Rədd bildirişi üçün.',
        deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        assigned_stores: [storeId],
        assignedUserId: USER_BOUND,
      },
    });
    const reviewTaskId = track(reviewTask);

    if (!reviewTaskId) {
      skip('the rejection notice checks', 'the fixture task could not be dispatched');
    } else {
      const ack = await call('POST', `/api/portal/field/tasks/${reviewTaskId}/acknowledge`, {
        body: { chatId: CHAT_BOUND },
      });
      check('the task is acknowledged from the chat', ack.status === 200, ack.body);

      const submission = await call('POST', '/api/portal/field/submissions', {
        body: {
          chatId: CHAT_BOUND,
          storeTaskId: reviewTaskId,
          photoUrl: 'data:image/jpeg;base64,/9j/notify-suite',
          photoType: 'standard',
          // Inside the store's perimeter, so the geofence passes.
          latitude: 40.3724,
          longitude: 49.8372,
          checklistAnswers: [],
        },
      });
      const evidenceId: string | undefined = submission.body?.data?.id;
      if (evidenceId) evidenceIds.push(evidenceId);
      check(
        'the photo is filed',
        submission.status === 201 && Boolean(evidenceId),
        submission.body,
      );

      if (!evidenceId) {
        skip('the rejection notice checks', 'the photo could not be filed');
      } else {
        const feedback = `Rəf səliqəsizdir — ${RUN}`;
        const review = await call('POST', `/api/portal/submissions/${evidenceId}/review`, {
          body: { status: 'rejected', feedback },
        });
        check('the supervisor rejects it', review.status === 200, review.body);

        const rejection = await notificationByKey(`TASK_REJECTED:${evidenceId}`);
        check('and the merchandiser is told', rejection !== null, rejection);
        check(
          'with the supervisor\u2019s own words, not a generic sentence',
          String(rejection?.body ?? '').includes(feedback),
          rejection?.body,
        );
        check(
          'keyed on the submission, so a second rejection of a second photo still arrives',
          rejection?.dedupe_key === `TASK_REJECTED:${evidenceId}`,
          rejection?.dedupe_key,
        );

        // An approval is not a rejection: the merchandiser has nothing left to
        // do, so nothing should be queued.
        const approvedTask = await call('POST', '/api/portal/tasks', {
          body: {
            title: `Təsdiq testi ${RUN}`,
            description: 'Təsdiq bildiriş göndərməməlidir.',
            deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_stores: [storeId],
            assignedUserId: USER_BOUND,
          },
        });
        const approvedTaskId = track(approvedTask);

        if (approvedTaskId) {
          await call('POST', `/api/portal/field/tasks/${approvedTaskId}/acknowledge`, {
            body: { chatId: CHAT_BOUND },
          });
          const okSubmission = await call('POST', '/api/portal/field/submissions', {
            body: {
              chatId: CHAT_BOUND,
              storeTaskId: approvedTaskId,
              photoUrl: 'data:image/jpeg;base64,/9j/notify-suite-ok',
              photoType: 'standard',
              latitude: 40.3724,
              longitude: 49.8372,
              checklistAnswers: [],
            },
          });
          const okEvidenceId: string | undefined = okSubmission.body?.data?.id;
          if (okEvidenceId) evidenceIds.push(okEvidenceId);

          if (okEvidenceId) {
            await call('POST', `/api/portal/submissions/${okEvidenceId}/review`, {
              body: { status: 'approved' },
            });
            check(
              'an approval queues nothing — there is nothing left for the merchandiser to do',
              (await notificationByKey(`TASK_REJECTED:${okEvidenceId}`)) === null &&
                (await notificationsForTask(approvedTaskId)).filter(
                  (row) => row.kind === 'TASK_REJECTED',
                ).length === 0,
            );
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    console.log('\nthe unscoped claim — the one the bot actually makes');
    // -----------------------------------------------------------------------

    /**
     * WHY THIS CHECK EXISTS, AND WHY IT IS LAST
     * -----------------------------------------
     * Break-the-detector found the gap. Removing `chat_id IS NOT NULL` from the
     * claim query — which is the only thing stopping the bot from trying to
     * send a message to "null" — left this suite fully green, because every
     * other claim it makes is scoped to a chat, and a scoped claim excludes a
     * NULL chat id by equality anyway. The guard was untested.
     *
     * It runs last because an unscoped claim takes every pending row for every
     * chat, and the checks above need those rows to still be waiting.
     *
     * Both halves are asserted. "Nothing came back" would satisfy the first half
     * alone, and a check that passes when the endpoint returns nothing is not a
     * check — that is the same defect, one level down.
     */
    const unscoped = await call('GET', '/api/portal/field/notifications?limit=100');
    const unscopedRows: any[] = Array.isArray(unscoped.body?.data) ? unscoped.body.data : [];
    check(
      'an unscoped claim returns the messages that do have a destination',
      unscoped.status === 200 && unscopedRows.length > 0,
      unscoped.body,
    );
    check(
      'and leaves every destination-less row behind, so nothing is sent to a null chat',
      unscopedRows.every((row: any) => typeof row.chatId === 'string' && row.chatId.length > 0) &&
        !unscopedRows.some((row: any) => row.id === orphanRow?.id || row.id === noChatReminder?.id),
      unscopedRows.map((row: any) => ({ id: row.id, chatId: row.chatId })),
    );

    // -----------------------------------------------------------------------
    console.log('\ndeleting a task takes its queued notice with it');
    // -----------------------------------------------------------------------

    /**
     * WHY THIS IS A PRODUCT CHECK, NOT A TIDINESS CHECK
     * -------------------------------------------------
     * `notifications.store_task_id` has no foreign key, deliberately — the same
     * reasoning as `bot_sessions`, so that a supervisor can delete a task
     * without the outbox refusing. The cost is that nothing cascades, so the row
     * has to be removed by the delete path itself.
     *
     * Without that, the sequence is: a supervisor dispatches a task, changes
     * their mind and deletes it — and the bot, polling a moment later, sends the
     * merchandiser "a task has been given to you" with an inline button reading
     * "🔓 Tapşırığı aç" whose callback data is the id of a task the API no longer
     * has. The one channel that is supposed to be authoritative would send
     * someone to do work that does not exist, and the button would open nothing.
     * A queued notice for a task being deleted is not late; it is wrong.
     *
     * The control is asserted first, and it is the point. "The row is gone after
     * the delete" is worthless unless the row was demonstrably there before it:
     * a task that never queued anything, or a delete that silently failed, would
     * both satisfy it.
     */
    const doomed = await call('POST', '/api/portal/tasks', {
      body: {
        title: `Silinəcək tapşırıq ${RUN}`,
        description: 'Silinmə bildirişi testi üçün müvəqqəti brifinq.',
        priority: 'LOW',
        deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        assigned_stores: [storeId],
        assignedUserId: USER_BOUND,
      },
    });
    const doomedId = track(doomed);
    check(
      'a task to delete is dispatched',
      doomed.status === 201 && Boolean(doomedId),
      doomed.body,
    );

    if (doomedId) {
      const queuedBefore = await notificationByKey(`TASK_ASSIGNED:${doomedId}`);
      check(
        'its notice is in the outbox first — the control',
        queuedBefore !== null && queuedBefore.store_task_id === doomedId,
        queuedBefore,
      );

      const deleted = await call('DELETE', `/api/portal/tasks/${doomedId}`);
      check('the supervisor deletes the task', deleted.status === 200, deleted.body);

      const taskRows = await query('SELECT id FROM store_tasks WHERE id = $1', [doomedId]);
      check('and it is really gone from the database', taskRows.length === 0, taskRows);

      const queuedAfter = await notificationByKey(`TASK_ASSIGNED:${doomedId}`);
      check(
        'and its queued notice went with it, so the bot cannot announce work that is gone',
        queuedAfter === null,
        queuedAfter,
      );
    }
  } finally {
    // Audit entries are written with `persist` — fire-and-forget — so the row
    // for the very last transition can still be in flight when the cleanup
    // starts. Deleting first and letting it land afterwards leaves exactly one
    // row behind, which is how this was found. The same wait `bot:test` uses
    // after a queued evidence write.
    await sleep(1_500);
    // Clean up whatever the run left behind, even if a check threw.
    try {
      const allTaskIds = taskIds;
      const allEvidenceIds = evidenceIds;

      await query('DELETE FROM notifications WHERE store_task_id = ANY($1::text[])', [allTaskIds]);
      await query('DELETE FROM notifications WHERE id = ANY($1::text[])', [
        injectedNotificationIds,
      ]);
      await query('DELETE FROM task_evidences WHERE store_task_id = ANY($1::text[])', [allTaskIds]);
      await query('DELETE FROM store_tasks WHERE id = ANY($1::text[])', [allTaskIds]);
      await query('DELETE FROM task_templates WHERE id = ANY($1::text[])', [templateIds]);
      // Audit rows name whatever the event was about — a task, an evidence, a
      // template, a store — so every id this suite produced has to be offered.
      await query('DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])', [
        [...allTaskIds, ...allEvidenceIds, ...templateIds, ...(storeId ? [storeId] : [])],
      ]);
      await query('DELETE FROM audit_logs WHERE actor_id = $1', [USER_UNBOUND]);
      if (storeId) {
        await query('DELETE FROM stores WHERE id = $1', [storeId]);
      }
      await query('DELETE FROM users WHERE id = $1', [USER_UNBOUND]);
    } catch (error) {
      console.error('Could not clean up:', error);
    }

    await stopApi().catch(() => undefined);

    try {
      const countAfter: Record<string, number> = {
        notifications: await countOf('notifications'),
        store_tasks: await countOf('store_tasks'),
        task_templates: await countOf('task_templates'),
        task_evidences: await countOf('task_evidences'),
        audit_logs: await countOf('audit_logs'),
        stores: await countOf('stores'),
        users: await countOf('users'),
      };

      const drifted = Object.keys(countBefore).filter(
        (table) => countAfter[table] !== countBefore[table],
      );
      check('no test row is left behind', drifted.length === 0, {
        drifted,
        before: countBefore,
        after: countAfter,
      });
    } finally {
      await db.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('\nSuite crashed:', error);
  await stopApi().catch(() => undefined);
  process.exitCode = 1;
});
