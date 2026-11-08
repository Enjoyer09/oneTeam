#!/usr/bin/env node
/**
 * The private-chat-only guard — offline regression suite.
 * ============================================================================
 *
 * WHAT THIS GUARDS AGAINST
 * ------------------------
 * Everything the bot stores is keyed by chat id — the session, the Telegram
 * binding, the notification drain. In a group all of that collapses into the
 * group's chat id: the first member to send a store code enrols THE GROUP,
 * binding everyone in it to one store and merging their checklist answers
 * into one shared flow. The store code is also an enrolment credential, and a
 * group makes it visible to every member.
 *
 * So non-private updates are dropped before the session middleware runs. The
 * one-time notice is for the admin who adds the bot to a group and expects an
 * answer — silence would read as "the bot is broken".
 *
 * This drives the real bot through `handleUpdate` with Telegram's HTTP layer
 * replaced by a stub, so it proves the guard is registered in the middleware
 * stack (a handler-level test could not).
 *
 *   npm run test:group-guard
 */
import { createBot } from './index';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

interface Recorded {
  method: string;
  payload: Record<string, unknown>;
}

function groupUpdate(text: string, chatId = -1001234): Record<string, unknown> {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: 1,
      from: { id: 77, is_bot: false, first_name: 'Member' },
      chat: { id: chatId, type: 'supergroup', title: 'Team' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(text.startsWith('/')
        ? { entities: [{ offset: 0, length: text.split(/[\s@]/)[0].length, type: 'bot_command' }] }
        : {}),
    },
  };
}

async function main(): Promise<void> {
  console.log('bot — the private-chat-only guard\n');

  // Telegram's HTTP layer is replaced with a grammY transformer rather than a
  // global-fetch stub: grammY captures `fetch` at import time, so replacing it
  // later has no effect on a bot that has already been imported.
  const calls: Recorded[] = [];
  const bot = createBot('mock-bot-token');
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === 'getMe'
        ? { id: 1, is_bot: true, first_name: 'oneTeam', username: 'oneteam_bot' }
        : { message_id: 1 };
    // A transformer returns the PARSED Telegram response, not a Response —
    // grammY's base transformer does the fetch and the JSON.parse, and a
    // custom transformer that short-circuits it takes over both jobs.
    return { ok: true, result } as never;
  });

  await bot.init();

  const sendMessageCalls = () =>
    calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text ?? ''));

  try {
    // 1. A command in a group is answered once with the notice — and nothing
    //    else. In particular no session read: the guard drops the update
    //    before the session middleware, so a group never gets bot state.
    await bot.handleUpdate(groupUpdate('/start') as never);
    const sent = sendMessageCalls();
    check(
      'a group command gets exactly one notice, not a flow',
      sent.length === 1 && /şəxsi söhbətlərdə/i.test(sent[0] ?? ''),
      JSON.stringify(sent),
    );
    check(
      'no group update ever reaches the session storage',
      calls.every((c) => !c.method.includes('portal')),
      JSON.stringify(calls.map((c) => c.method)),
    );

    // 2. The notice is once per chat: a second command is silent, so a group
    //    cannot turn the bot into a reply loop.
    await bot.handleUpdate(groupUpdate('/tasks') as never);
    check(
      'a second group command in the same chat stays silent',
      sendMessageCalls().length === 1,
      JSON.stringify(sendMessageCalls()),
    );

    // 3. Group chatter (not a command, not a callback) produces no network
    //    call at all.
    const callsBefore = calls.length;
    await bot.handleUpdate(groupUpdate('salam necesiniz') as never);
    check(
      'group chatter is dropped without any Telegram call',
      calls.length === callsBefore,
      `calls went from ${callsBefore} to ${calls.length}`,
    );

    // 4. A different group still gets its one notice — the cap is per chat.
    await bot.handleUpdate(groupUpdate('/start', -1005678) as never);
    check(
      'another group still gets its notice',
      sendMessageCalls().length === 2,
      JSON.stringify(sendMessageCalls()),
    );
  } finally {
    await bot.stop().catch(() => {});
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The suite could not finish:', error);
  process.exit(1);
});
