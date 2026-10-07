/**
 * Write-ordering: a direct write must not beat the queue it depends on.
 *
 * `saveBotSession()` inserts `bot_sessions.user_id`, and that user is created
 * by `bindTelegramUser()` through the write queue — a row that does not exist
 * until the queue runs it. Issuing the session save as a direct pool query
 * while that INSERT is still in flight is a foreign-key violation against a
 * row the caller KNOWS exists. The router suite hit it as
 *
 *     insert or update on table "bot_sessions" violates foreign key
 *     constraint "bot_sessions_user_id_fkey"   → FLOW_NOT_STORED (503)
 *
 * about one run in eight, and the bot answered "your work was not saved" on
 * the person's FIRST exchange with it.
 *
 * The queue's own rule (packages/database/src/index.ts): "if a write can only
 * succeed once another write has landed, it goes through here." This suite
 * pins that rule for the session write: the pool is wrapped so the queued
 * user INSERT is held back for a beat, the session save is issued immediately
 * after it, and the save must wait rather than lose the race.
 *
 * Live suite: needs `DATABASE_URL` and real `bot_sessions_user_id_fkey`
 * enforcement — an in-memory database would make this test vacuous.
 * Standalone: `npm run test:write-order`.
 */

import 'reflect-metadata';
import { db } from '@oneteam/database';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required: this suite drives db.saveBotSession() against\n' +
        '       the real database, whose foreign key is where the race lives.',
    );
  }

  console.log('\n=== the session save waits for the queued user insert ===');
  await db.init();
  db.stopRefreshLoop();
  db.stopBotSessionSweep();

  const chatId = `wo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const anyDb = db as any;
  const realPool = anyDb.pool;

  // Hold back the queued user INSERT specifically — the row the session
  // save's foreign key needs is exactly what will be missing when the save
  // runs as a direct pool query. Matching the statement, not "the first
  // query", matters: the direct save issues its statement synchronously,
  // BEFORE the queued insert's microtask runs, so a first-query delay would
  // hold the save instead and pass for the wrong reason.
  let held = false;
  anyDb.pool = new Proxy(realPool, {
    get(target: any, prop: string) {
      const value = target[prop];
      if (prop === 'query' && typeof value === 'function') {
        return (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '';
          if (!held && sql.includes('INSERT INTO users')) {
            held = true;
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                Promise.resolve(value.apply(target, args)).then(resolve, reject);
              }, 300);
            });
          }
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  let saved: unknown;
  let threw: unknown;
  try {
    const user = db.bindTelegramUser({ telegramChatId: chatId, fullName: 'Write order' });
    saved = await db.saveBotSession({ chatId, userId: user.id, step: 'store_code' });
  } catch (error) {
    threw = error;
  } finally {
    anyDb.pool = realPool;
  }

  // If the held statement never fired, the delay wrapped the wrong query and
  // the result below proves nothing.
  check('the queued user insert was the held statement', held, { held });
  check(
    'the session save waits for the queued user insert instead of racing it',
    threw === undefined && Boolean(saved),
    threw !== undefined
      ? { error: threw instanceof Error ? threw.message : String(threw) }
      : { saved },
  );

  // Clean up whatever landed, then close.
  try {
    await db.clearBotSession(chatId);
  } finally {
    await db.close();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(
    `\n❌ Write-order suite failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
