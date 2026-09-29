#!/usr/bin/env node
/**
 * Tests for the checklist step's handling of a question with NO answer `type`.
 * ============================================================================
 *
 * WHAT THIS GUARDS
 * ----------------
 * `packages/types` declares `ChecklistQuestion.type` as required, but the API
 * never sets it: a legacy question authored before the panel had a type
 * selector is stored as `{ id, label }` with no `type` (`readChecklistSchema`
 * validates `label` and passes the rest through). `answerMode` maps such a
 * type-less question to `boolean` — the SAME default the panel now applies to
 * every new question — so it renders one-tap Hə/Yox buttons instead of a
 * free-text prompt with nothing to tap. This was reported on store IPHONE_TEST,
 * whose three questions are all `{ id, label }` with no type and were showing
 * "Cavabı yazıb göndərin" where an obvious yes/no question wanted buttons.
 *
 * This is safe on submission: `EvidenceService` validates an answer's type only
 * when the stored question HAS a `type`, so a boolean answer to a type-less
 * question is accepted. A question that is really number/text is retyped in the
 * panel, which stamps the real type and takes it off this fallback.
 *
 * WHY THIS SUITE AND NOT `router.test.ts` OR `bot:test`
 * -----------------------------------------------------
 * Both of those build their fixture with an EXPLICIT `type` on every question,
 * so neither ever exercises a type-less question. This one drives
 * `askNextChecklistQuestion`, `handleChecklistAnswer` and `handleChecklistText`
 * directly with a type-less schema, so it needs neither a database nor a
 * running API.
 *
 *   npm run test:checklist-type
 */
import { ChecklistQuestion } from '@oneteam/types';
import { BotContext } from '../types';
import { encodeChecklistAnswer } from '../callbacks';
import { askNextChecklistQuestion, handleChecklistAnswer, handleChecklistText } from './taskFlow';

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
  console.log('taskFlow — a checklist question with no `type` defaults to Hə/Yox\n');

  // Three questions shaped exactly as the API returns a panel-authored task:
  // an id and a label, and no `type`, `required` or `options`.
  const typeless: ChecklistQuestion[] = [
    { id: 'q1', label: 'Raf tam doldurulub?' } as unknown as ChecklistQuestion,
    { id: 'q2', label: 'Qiymət etiketləri düzdür?' } as unknown as ChecklistQuestion,
    { id: 'q3', label: 'Reklam materialı asılıb?' } as unknown as ChecklistQuestion,
  ];

  const { ctx, replies } = makeCtx(typeless);
  // handleChecklistAnswer needs a toast callback; capture what it says.
  const toasts: string[] = [];
  const toast = async (msg?: string) => {
    toasts.push(msg ?? '');
  };

  // 1. The question is ASKED with one-tap Hə/Yox buttons, not a "type it" prompt.
  await askNextChecklistQuestion(ctx);
  const first = replies.at(-1)!;
  check('the type-less question is shown', first.text.includes('Raf tam doldurulub?'), first.text);
  check(
    'it is NOT presented as a free-text question',
    !first.text.includes('Cavabı yazıb göndərin'),
    first.text,
  );
  check(
    'it offers Bəli/Xeyr answer buttons (chk:)',
    inlineData(first.markup).some((data) => data.startsWith('chk:')),
    JSON.stringify(inlineData(first.markup)),
  );
  check(
    'and it still offers a way back to the menu',
    inlineData(first.markup).some((data) => data.startsWith('menu:')),
    JSON.stringify(inlineData(first.markup)),
  );

  // 2. Tapping "Bəli" is ACCEPTED as a boolean and advances the flow.
  await handleChecklistAnswer(ctx, encodeChecklistAnswer(0, true), toast);
  check(
    'the tapped answer is stored as a boolean true',
    ctx.session.checklistAnswers?.some((a) => a.questionId === 'q1' && a.value === true) === true,
    JSON.stringify(ctx.session.checklistAnswers),
  );
  check(
    'and the checklist advances',
    ctx.session.checklistIndex === 1,
    String(ctx.session.checklistIndex),
  );

  // 3. Answering the remaining questions by tapping reaches the photo step.
  await handleChecklistAnswer(ctx, encodeChecklistAnswer(1, false), toast);
  await handleChecklistAnswer(ctx, encodeChecklistAnswer(2, true), toast);

  check(
    'all three answers are recorded',
    ctx.session.checklistAnswers?.length === 3,
    JSON.stringify(ctx.session.checklistAnswers),
  );
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

  // 3b. Typing on a type-less (now boolean) question is redirected to the
  //     buttons rather than filed as free text.
  const typed = makeCtx(typeless);
  await askNextChecklistQuestion(typed.ctx);
  typed.ctx.message!.text = 'Bəli';
  const claimedTyped = await handleChecklistText(typed.ctx);
  check('a typed message is still claimed by the checklist handler', claimedTyped === true);
  check(
    'but typing on a type-less question is redirected to the buttons',
    typed.replies.at(-1)!.text.includes('düymələrdən birini seçin'),
    typed.replies.at(-1)!.text,
  );
  check(
    'and typing does not advance a type-less question',
    typed.ctx.session.checklistIndex === 0,
    String(typed.ctx.session.checklistIndex),
  );

  // 3c. An EXPLICIT `type: 'text'` still means free text — only the ABSENCE of
  //     a type flips to Hə/Yox, so a deliberate text question is untouched.
  const textQ: ChecklistQuestion[] = [
    { id: 't1', label: 'Əlavə qeyd?', type: 'text' } as ChecklistQuestion,
  ];
  const textCtx = makeCtx(textQ);
  await askNextChecklistQuestion(textCtx.ctx);
  check(
    'an explicit text question is still free text',
    textCtx.replies.at(-1)!.text.includes('Cavabı yazıb göndərin') &&
      !inlineData(textCtx.replies.at(-1)!.markup).some((d) => d.startsWith('chk:')),
    textCtx.replies.at(-1)!.text,
  );
  textCtx.ctx.message!.text = 'əlavə məlumat';
  await handleChecklistText(textCtx.ctx);
  check(
    'and a typed answer to a text question is stored verbatim',
    textCtx.ctx.session.checklistAnswers?.some(
      (a) => a.questionId === 't1' && a.value === 'əlavə məlumat',
    ) === true,
    JSON.stringify(textCtx.ctx.session.checklistAnswers),
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
