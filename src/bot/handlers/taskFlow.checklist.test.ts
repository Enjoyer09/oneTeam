#!/usr/bin/env node
/**
 * Tests for the checklist step's handling of a question with NO answer `type`.
 * ============================================================================
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * `packages/types` declares `ChecklistQuestion.type` as required, but the API
 * never sets it: a question authored in the panel is stored as `{ id, label }`
 * with no `type` (`PortalService.readChecklistSchema` validates `label` and
 * passes the rest through). The two functions in `taskFlow.ts` then DISAGREED
 * about such a question — `askNextChecklistQuestion` printed "type a number"
 * with no buttons, while `handleChecklistText` answered "use the buttons above"
 * for anything that was not a number, and there were no buttons. The result was
 * a checklist step that could not be passed at all: nothing to tap, and every
 * typed answer refused. To a merchandiser that is a task whose button "does
 * nothing" — reported on store IPHONE_TEST, whose three questions are all
 * `{ id, label }` with no type.
 *
 * WHY THIS SUITE AND NOT `router.test.ts` OR `bot:test`
 * -----------------------------------------------------
 * Both of those build their fixture with an EXPLICIT `type` on every question
 * (`type: 'boolean'`, `type: 'number'`), so neither ever exercised a type-less
 * question — which is precisely how the deadlock reached production while the
 * suites were green. This one drives `askNextChecklistQuestion` and
 * `handleChecklistText` directly with a type-less schema, so it needs neither a
 * database nor a running API.
 *
 *   npm run test:checklist-type
 */
import { ChecklistQuestion } from '@oneteam/types';
import { BotContext } from '../types';
import {
  askNextChecklistQuestion,
  handleChecklistText,
} from './taskFlow';

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

interface Reply {
  text: string;
  markup: any;
}

/**
 * A BotContext just real enough for the checklist functions: a session, a
 * capturing `reply`, and a `message` slot the caller sets before a typed turn.
 * None of the functions under test touch the API or the network.
 */
function makeCtx(questions: ChecklistQuestion[]) {
  const replies: Reply[] = [];
  const ctx = {
    session: {
      step: 'awaiting_checklist',
      activeTaskId: 'task-checklist-test',
      checklistQuestions: questions,
      checklistIndex: 0,
      checklistAnswers: [],
    },
    chat: { id: 42, type: 'private' },
    message: { text: '' } as { text: string },
    reply: async (text: string, options?: any) => {
      replies.push({ text, markup: options?.reply_markup });
      return { message_id: replies.length };
    },
  } as unknown as BotContext;
  return { ctx, replies };
}

/** The `callback_data` of every inline button on a reply's keyboard. */
function inlineData(markup: any): string[] {
  const rows = markup?.inline_keyboard ?? [];
  return rows.flat().map((button: any) => String(button?.callback_data ?? ''));
}

async function main(): Promise<void> {
  console.log('taskFlow — a checklist question with no `type`\n');

  // Three questions shaped exactly as the API returns a panel-authored task:
  // an id and a label, and no `type`, `required` or `options`.
  const typeless: ChecklistQuestion[] = [
    { id: 'q1', label: 'Raf tam doldurulub?' } as unknown as ChecklistQuestion,
    { id: 'q2', label: 'Qiymət etiketləri düzdür?' } as unknown as ChecklistQuestion,
    { id: 'q3', label: 'Reklam materialı asılıb?' } as unknown as ChecklistQuestion,
  ];

  const { ctx, replies } = makeCtx(typeless);

  // 1. The question is ASKED — and as a typed-answer question, not a dead end.
  await askNextChecklistQuestion(ctx);
  const first = replies.at(-1)!;
  check('the type-less question is shown', first.text.includes('Raf tam doldurulub?'), first.text);
  check(
    'it is presented as a typed answer, not "type a number"',
    first.text.includes('Cavabı yazıb göndərin') && !first.text.includes('rəqəmlə'),
    first.text,
  );
  check(
    'it offers no chk: answer buttons (there is no fixed set of answers)',
    !inlineData(first.markup).some((data) => data.startsWith('chk:')),
    JSON.stringify(inlineData(first.markup)),
  );
  check(
    'but it still offers a way back to the menu',
    inlineData(first.markup).some((data) => data.startsWith('menu:')),
    JSON.stringify(inlineData(first.markup)),
  );

  // 2. A typed answer is ACCEPTED and advances the flow — the deadlock is gone.
  //    "Bəli" is a word, not a number: before the fix this was refused.
  ctx.message!.text = 'Bəli';
  const claimed1 = await handleChecklistText(ctx);
  check('a typed answer is claimed by the checklist handler', claimed1 === true);
  check(
    'the typed answer is stored verbatim',
    ctx.session.checklistAnswers?.some((a) => a.questionId === 'q1' && a.value === 'Bəli') === true,
    JSON.stringify(ctx.session.checklistAnswers),
  );
  check('and the checklist advances', ctx.session.checklistIndex === 1, String(ctx.session.checklistIndex));

  // 3. Answering the remaining questions reaches the photo step rather than
  //    stalling — the whole point: a type-less checklist can be completed.
  ctx.message!.text = 'Xeyr';
  await handleChecklistText(ctx);
  ctx.message!.text = 'Bəli';
  await handleChecklistText(ctx);

  check('all three answers are recorded', ctx.session.checklistAnswers?.length === 3, JSON.stringify(ctx.session.checklistAnswers));
  check(
    'the flow advances to the photo step',
    ctx.session.step === 'awaiting_photo',
    String(ctx.session.step),
  );
  check(
    'and the photo prompt is shown',
    replies.at(-1)!.text.includes('Addım 3/3'),
    replies.at(-1)!.text,
  );

  // 4. Regression guard: an explicit `boolean` still uses buttons and refuses a
  //    typed answer, so the type-less fallback did not weaken the typed cases.
  const boolQ: ChecklistQuestion[] = [
    { id: 'b1', label: 'Rəf təmizdir?', type: 'boolean', required: true } as ChecklistQuestion,
  ];
  const bool = makeCtx(boolQ);
  await askNextChecklistQuestion(bool.ctx);
  check(
    'a boolean question still offers Bəli/Xeyr buttons',
    inlineData(bool.replies.at(-1)!.markup).some((data) => data.startsWith('chk:')),
    JSON.stringify(inlineData(bool.replies.at(-1)!.markup)),
  );
  bool.ctx.message!.text = 'filan-filan';
  await handleChecklistText(bool.ctx);
  check(
    'and typing on a boolean question is redirected to the buttons',
    bool.replies.at(-1)!.text.includes('düymələrdən birini seçin'),
    bool.replies.at(-1)!.text,
  );
  check(
    'and the typed text does not advance a boolean question',
    bool.ctx.session.checklistIndex === 0,
    String(bool.ctx.session.checklistIndex),
  );

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The suite could not finish:', error);
  process.exit(1);
});
