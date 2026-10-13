import assert from 'node:assert/strict';
import { handleTasksPage } from './tasks';
import type { BotContext, TaskRecord } from '../types';
import { portalApi } from '../../services/portalApi';

async function main() {
  const original = portalApi.getTasksForStore;
  const tasks = Array.from({ length: 50 }, (_, i) => ({
    id: `task-${i}`,
    title: `Tapşırıq ${i}`,
    description: 'Yoxlayın',
    deadline: '2026-10-20T12:00:00Z',
    priority: 'MEDIUM',
    reference_image_url: null,
    status: 'PUBLISHED',
  })) as TaskRecord[];
  portalApi.getTasksForStore = async () => tasks;
  let messages: { text: string; options: unknown }[] = [];
  const ctx = {
    session: { storeId: 's', storeName: 'Mağaza' },
    reply: async (text: string, options: unknown) => {
      messages.push({ text, options });
    },
  } as unknown as BotContext;
  try {
    await handleTasksPage(ctx, 0);
    assert.equal(messages.length, 8); // header, six cards, navigation
    assert.match(messages[7].text, /Səhifə 1\/9/);
    assert.match(JSON.stringify(messages[7].options), /tasks:page-1/);
    messages = [];
    await handleTasksPage(ctx, 1);
    assert.match(messages[1].text, /Tapşırıq 6/);
    assert.match(JSON.stringify(messages.at(-1)?.options), /tasks:page-0/);
    messages = [];
    await handleTasksPage(ctx, 999);
    assert.equal(messages.length, 4);
    assert.match(messages.at(-1)!.text, /Səhifə 9\/9/);
    assert.doesNotMatch(JSON.stringify(messages.at(-1)?.options), /tasks:page-9/);
  } finally {
    portalApi.getTasksForStore = original;
  }
  console.log('Bot pagination: bounded pages, navigation and stale page clamping passed.');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
