import assert from 'node:assert/strict';
import { handleOpenTask, handleDiscardTask } from './tasks';
import type { BotContext } from '../types';
async function main() {
  const answers = [{ questionId: 'q', value: true }];
  const replies: string[] = [];
  const ctx = {
    session: { activeTaskId: 'old', step: 'awaiting_checklist', checklistAnswers: answers },
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as BotContext;
  await handleOpenTask(ctx, 'new', async () => {});
  assert.equal(ctx.session.activeTaskId, 'old');
  assert.deepEqual(ctx.session.checklistAnswers, answers);
  assert.match(replies[0], /Davam edən auditiniz var/);
  await handleDiscardTask(ctx, 'stale', async () => {});
  assert.deepEqual(ctx.session.checklistAnswers, answers);
  await handleDiscardTask(ctx, 'old', async () => {});
  assert.equal(ctx.session.step, 'idle');
  assert.equal(ctx.session.checklistAnswers, undefined);
  console.log(
    'Bot: accidental switch preserves answers; stale discard is ignored; explicit discard clears.',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
