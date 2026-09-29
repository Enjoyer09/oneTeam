#!/usr/bin/env node
/**
 * Tests that DB-authored text is Markdown-escaped before it is sent.
 * ============================================================================
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * Telegram's legacy Markdown treats `_ * ` [ ]` as formatting, and it rejects
 * the WHOLE message with `400: can't parse entities` when a delimiter never
 * closes. A store code like `IPHONE_TEST` embeds a `_`, so the task-open
 * confirmation
 *
 *     📌 *Seçilmiş tapşırıq:* IPHONE_TEST — raf yoxlamasi
 *
 * opened an italic entity that never closed. `ctx.reply` threw, `handleOpenTask`
 * threw with it, and the guided flow never started — so the task's button
 * "did nothing" when tapped. This was the live symptom on IPHONE_TEST, seen in
 * the production bot logs as a `sendMessage` 400 at `handleOpenTask`.
 *
 * The fix routes every DB-authored value (store name, task title, description,
 * feedback) through `escapeMarkdown` before it lands in a Markdown message.
 * These checks drive `sendTaskDetails` and `handleOpenTask` with a title that
 * contains the exact hazard and assert the emitted text is escaped — neither
 * function touches the network here (the two API calls are stubbed).
 *
 *   npm run test:markdown-escape
 */
import { escapeMarkdown } from '../markdown';
import { portalApi } from '../../services/portalApi';
import { BotContext, TaskRecord } from '../types';
import { sendTaskDetails, handleOpenTask } from './tasks';

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
}

function makeCtx() {
  const replies: Reply[] = [];
  const ctx = {
    session: { step: 'idle', checklistAnswers: [] },
    chat: { id: 42, type: 'private' },
    reply: async (text: string) => {
      replies.push({ text });
      return { message_id: replies.length };
    },
    replyWithPhoto: async (_photo: unknown, options?: any) => {
      replies.push({ text: options?.caption ?? '' });
      return { message_id: replies.length };
    },
  } as unknown as BotContext;
  return { ctx, replies };
}

/** A task shaped like the panel-authored IPHONE_TEST task: `_` in the title. */
function taskWithUnderscore(): TaskRecord {
  return {
    id: 'task-panel-1789826089870-msxtx6',
    title: 'IPHONE_TEST — raf yoxlamasi',
    description: 'Rəf_təlimatı: *diqqətlə* baxın',
    priority: 'high',
    deadline: new Date('2026-10-01T09:00:00Z').toISOString(),
    checklist_schema: [],
    reference_image_url: '',
  } as unknown as TaskRecord;
}

async function main(): Promise<void> {
  console.log('tasks — Markdown escaping of DB-authored text\n');

  // 0. The helper itself neutralises every legacy-Markdown delimiter.
  check(
    'escapeMarkdown escapes the underscore in a store code',
    escapeMarkdown('IPHONE_TEST') === 'IPHONE\\_TEST',
    escapeMarkdown('IPHONE_TEST'),
  );
  check(
    'escapeMarkdown escapes * ` [ ] too',
    escapeMarkdown('a*b`c[d]e') === 'a\\*b\\`c\\[d\\]e',
    escapeMarkdown('a*b`c[d]e'),
  );

  // 1. The task card (sendTaskDetails) — no network, builds the Markdown text.
  const card = makeCtx();
  await sendTaskDetails(card.ctx, taskWithUnderscore());
  const cardText = card.replies.at(-1)!.text;
  check(
    'the card escapes the underscore in the title',
    cardText.includes('IPHONE\\_TEST') && !cardText.includes('IPHONE_TEST'),
    cardText,
  );
  check(
    'the card escapes markdown in the description',
    cardText.includes('Rəf\\_təlimatı') && cardText.includes('\\*diqqətlə\\*'),
    cardText,
  );

  // 2. The task-open confirmation (handleOpenTask) — the exact live crash path.
  //    Stub the two API calls so the handler runs offline; a `_` title used to
  //    make the "Seçilmiş tapşırıq" reply throw with a 400.
  const originalGet = portalApi.getTaskById;
  const originalAck = portalApi.acknowledgeTask;
  (portalApi as any).getTaskById = async () => taskWithUnderscore();
  (portalApi as any).acknowledgeTask = async () => ({
    advanced: false,
    currentState: 'ACKNOWLEDGED',
  });

  try {
    const open = makeCtx();
    let threw = false;
    try {
      await handleOpenTask(open.ctx, 'task-panel-1789826089870-msxtx6', async () => {});
    } catch (error) {
      threw = true;
      console.log(`         handleOpenTask threw: ${(error as Error).message}`);
    }
    check('handleOpenTask does not throw on a `_` title', threw === false);

    const chosen = open.replies.find((r) => r.text.includes('Seçilmiş tapşırıq'));
    check(
      'the "selected task" confirmation is sent',
      Boolean(chosen),
      JSON.stringify(open.replies.map((r) => r.text)),
    );
    check(
      'and its title is escaped, so Telegram will not reject it',
      Boolean(chosen) &&
        chosen!.text.includes('IPHONE\\_TEST') &&
        !chosen!.text.includes('IPHONE_TEST'),
      chosen?.text ?? '(no confirmation sent)',
    );
  } finally {
    (portalApi as any).getTaskById = originalGet;
    (portalApi as any).acknowledgeTask = originalAck;
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The suite could not finish:', error);
  process.exit(1);
});
