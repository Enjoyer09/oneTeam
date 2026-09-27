/**
 * oneTeam Telegram Bot — the command menu
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The list Telegram shows behind the "/" button and the "Menu" affordance in
 * the message box. Until now the bot answered `/start`, `/tasks`, `/mystatus`
 * and `/help`, but never told Telegram they existed — so a merchandiser had no
 * way to discover them except by being told. `setMyCommands` publishes them, so
 * the client renders a tappable menu.
 *
 * WHY IT IS NOT CALLED FROM `createBot`
 * -------------------------------------
 * `setMyCommands` is a live Telegram API call. `createBot` is what the test
 * suites build a bot with, and a suite that quietly calls Telegram is a suite
 * that talks to Telegram while it runs — the same reason `NotificationDrain` is
 * started from the entrypoint, not from `createBot`. So this is called once from
 * the standalone entrypoint, against a real token, and its failure is logged
 * rather than fatal: a bot that could not publish its menu still works, it is
 * just less discoverable.
 *
 * The command NAMES here must match the `bot.command(...)` routes in
 * `router.ts`. Telegram requires lowercase names of `[a-z0-9_]`, 1–32 chars;
 * descriptions are 1–256 chars. Both are asserted by `commands.test.ts`, where a
 * typo is cheap to find.
 */

import { Bot } from 'grammy';
import { BotContext } from './types';

/** The published command menu, in the order Telegram lists it. */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'bugun', description: '🗓 Bugünkü tapşırıqlar və göndərilənlər' },
  { command: 'tasks', description: '📋 Mağazanın aktiv tapşırıqları' },
  { command: 'mystatus', description: '📊 Göndərdiyiniz şəkillərin statusu' },
  { command: 'start', description: '🏪 Mağazanı dəyişmək / yenidən başlamaq' },
  { command: 'help', description: '❓ Bot necə işləyir' },
];

/**
 * Publishes the command menu to Telegram.
 *
 * Never throws: a failure here is logged and swallowed so it cannot stop the
 * bot from starting to poll. Called from the entrypoint, after a real token is
 * confirmed.
 */
export async function publishCommandMenu(bot: Bot<BotContext>): Promise<void> {
  try {
    await bot.api.setMyCommands([...BOT_COMMANDS]);
    console.log(`[oneTeam Bot] Published ${BOT_COMMANDS.length} commands to the Telegram menu.`);
  } catch (error) {
    console.error('[oneTeam Bot] Could not publish the command menu:', error);
  }
}
