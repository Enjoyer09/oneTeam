#!/usr/bin/env node
/**
 * Store-code guess throttling — offline regression suite.
 * ============================================================================
 *
 * WHAT THIS GUARDS AGAINST
 * ------------------------
 * A store code is an enrolment credential: presenting a valid one binds the
 * chat to that store's open work. The API-side limiter counts successful
 * enrolments per address, so unbounded WRONG guesses against the lookup
 * endpoint were free — the way to find a code without ever tripping the API.
 *
 * The fix is per-chat, in the bot process: 5 wrong codes inside 10 minutes
 * block further guesses for 10 minutes, and a successful enrol clears the
 * counter. These checks drive the real handler with `validateAndGetStore`
 * stubbed, and assert the block by the API never being asked again.
 *
 *   npm run test:start-throttle
 */
import { portalApi } from '../../services/portalApi';
import { BotContext } from '../types';
import { handleStoreCodeInput } from './start';

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

function makeCtx(chatId: number, text: string) {
  const replies: string[] = [];
  const ctx = {
    session: {},
    chat: { id: chatId, type: 'private' },
    message: { text },
    from: { first_name: 'Test', last_name: 'Merchandiser', username: 'tester' },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
  } as unknown as BotContext;
  return { ctx, replies };
}

async function main(): Promise<void> {
  console.log('start — store-code guess throttling\n');

  const originalValidate = portalApi.validateAndGetStore;
  const originalBind = portalApi.bindTelegramUser;

  let validateCalls = 0;
  let bindCalls = 0;
  (portalApi as any).validateAndGetStore = async (code: string) => {
    validateCalls++;
    return code === 'CHAIN_BAKU_01'
      ? {
          id: 'store-1',
          store_code: code,
          name: 'Baku',
          address: null,
          city: 'Baku',
          is_active: true,
        }
      : null;
  };
  (portalApi as any).bindTelegramUser = async () => {
    bindCalls++;
    return { id: 'profile-1', claimedTaskIds: [] };
  };

  try {
    // 1. Five wrong codes block the sixth guess before it reaches the API.
    const chat = makeCtx(4242, 'WRONG_CODE');
    for (let i = 0; i < 5; i++) {
      await handleStoreCodeInput(chat.ctx);
    }
    const apiCallsAfterFive = validateCalls;
    check(
      'five wrong codes each reach the lookup',
      apiCallsAfterFive === 5,
      `validateAndGetStore called ${validateCalls} times`,
    );

    const repliesBeforeBlock = chat.replies.length;
    await handleStoreCodeInput(chat.ctx);
    check(
      'the sixth guess is refused without asking the API',
      validateCalls === apiCallsAfterFive && chat.replies.length === repliesBeforeBlock + 1,
      `calls: ${validateCalls}, replies: ${chat.replies.length}`,
    );
    check(
      'the refusal says to wait rather than "code not found"',
      /gözləyin/i.test(chat.replies.at(-1) ?? ''),
      chat.replies.at(-1) ?? '(no reply)',
    );

    // 2. Another chat is not punished for the first chat's guessing.
    const other = makeCtx(909, 'CHAIN_BAKU_01');
    await handleStoreCodeInput(other.ctx);
    check(
      'a blocked chat does not block a different chat',
      bindCalls === 1 && /uğurla təsdiqləndi/i.test(other.replies.at(-1) ?? ''),
      `bind calls: ${bindCalls}, last reply: ${other.replies.at(-1) ?? '(none)'}`,
    );

    // 3. A successful enrol clears the counter: the chat that just enrolled is
    //    never one wrong code away from a block.
    const fresh = makeCtx(7171, 'WRONG_CODE');
    for (let i = 0; i < 4; i++) {
      await handleStoreCodeInput(fresh.ctx);
    }
    const ok = makeCtx(7171, 'CHAIN_BAKU_01');
    await handleStoreCodeInput(ok.ctx);
    for (let i = 0; i < 4; i++) {
      await handleStoreCodeInput(fresh.ctx);
    }
    await handleStoreCodeInput(fresh.ctx);
    check(
      'a successful enrol resets the failure counter',
      /gözləyin/i.test(fresh.replies.at(-1) ?? '') === false,
      fresh.replies.at(-1) ?? '(no reply)',
    );

    // 4. The not-found message escapes what the chat typed. The typed text in
    //    the awaiting-store-code step is unfiltered, so a backtick in it used to
    //    produce a Markdown message Telegram rejects entirely.
    const hazard = makeCtx(5150, 'BAD`CODE');
    await handleStoreCodeInput(hazard.ctx);
    const notFound = hazard.replies.at(-1) ?? '';
    check(
      'a backtick in the typed code is escaped in the reply',
      notFound.includes('BAD\\`CODE') && !notFound.includes('`BAD`CODE`'),
      notFound,
    );
  } finally {
    (portalApi as any).validateAndGetStore = originalValidate;
    (portalApi as any).bindTelegramUser = originalBind;
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The suite could not finish:', error);
  process.exit(1);
});
