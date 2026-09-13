import { Bot, session } from 'grammy';
import dotenv from 'dotenv';
import { BotContext, SessionData } from './types';
import { handleStart, handleStoreCodeInput } from './handlers/start';
import { handleTasks, handleTaskSelectCallback } from './handlers/tasks';
import { handlePhotoUpload } from './handlers/submission';
import { handleMyStatus } from './handlers/status';

dotenv.config();

/**
 * Creates and configures the oneTeam Grammy Bot instance
 */
export function createBot(token?: string): Bot<BotContext> {
  const botToken = token || process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to initialize the bot.');
  }

  const bot = new Bot<BotContext>(botToken);

  // Session Middleware
  bot.use(
    session({
      initial: (): SessionData => ({
        step: 'idle',
      }),
    })
  );

  // Command handlers
  bot.command('start', handleStart);
  bot.command('tasks', handleTasks);
  bot.command('mystatus', handleMyStatus);

  // Keyboard button text handlers
  bot.hears('📋 Tapşırıqlar', handleTasks);
  bot.hears('📊 Statusum', handleMyStatus);

  // Callback query handler (e.g. "📸 Rəf Şəklini Göndər")
  bot.on('callback_query:data', handleTaskSelectCallback);

  // Photo submission handler
  bot.on('message:photo', handlePhotoUpload);

  // General text message routing (store code input)
  bot.on('message:text', async (ctx) => {
    if (ctx.session.step === 'awaiting_store_code') {
      await handleStoreCodeInput(ctx);
      return;
    }

    const text = ctx.message.text.trim();
    // Auto-detect store codes if user sends e.g. "BRAVO_28MAY_01" anytime
    if (/^[A-Z0-9_]{4,30}$/i.test(text) && text.includes('_')) {
      await handleStoreCodeInput(ctx);
      return;
    }

    await ctx.reply(
      `🤖 *oneTeam Köməkçi:*\n\n` +
        `• /start — Yenidən başlamaq və mağazanı dəyişmək\n` +
        `• /tasks — Aktiv rəf və planogram tapşırıqları\n` +
        `• /mystatus — Göndərilən şəkillərin audit statusu`,
      { parse_mode: 'Markdown' }
    );
  });

  // Global error handler
  bot.catch((err) => {
    console.error(`[oneTeam Bot Error] (Update ID: ${err.ctx.update.update_id}):`, err.error);
  });

  return bot;
}

/**
 * Is this error Telegram telling us another instance is already polling?
 *
 * Checked structurally rather than with `instanceof GrammyError`, so the retry
 * does not depend on a class that grammy could rename or re-export differently.
 * Telegram answers HTTP 409 for a second concurrent `getUpdates`.
 */
function isPollingConflict(error: unknown): boolean {
  const candidate = error as { error_code?: number; message?: string } | null;
  if (candidate?.error_code === 409) return true;
  return /\b409\b/.test(String(candidate?.message ?? ''));
}

/**
 * Starts polling, surviving the overlap with the instance being replaced.
 *
 * WHY THIS IS NOT JUST `bot.start()`
 * ----------------------------------
 * A deployment does not stop the old container before starting the new one;
 * for a short window both are alive. Telegram allows exactly one consumer of
 * `getUpdates`, so the new instance is refused with:
 *
 *     409: Conflict: terminated by other getUpdates request
 *
 * `bot.start()` REJECTS on that error, and the rejection was previously
 * unhandled — `bot.catch()` only covers errors raised inside middleware, not
 * the start promise. Node terminates the process on an unhandled rejection, so
 * the bot crash-looped on every deploy until the old container finally went
 * away, and could stay down if restarts kept landing inside the window.
 *
 * Treating 409 as "the previous instance is still shutting down" and retrying
 * with a widening delay turns a fatal error into a few seconds of waiting.
 * Every other error is still fatal and still exits non-zero, so the platform
 * restarts the container.
 */
async function startPollingWithRetry(
  bot: Bot<BotContext>,
  maxAttempts = 20
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.start({
        onStart(botInfo) {
          console.log(`✅ oneTeam Bot connected as @${botInfo.username}`);
        },
      });
      return;
    } catch (error) {
      if (!isPollingConflict(error) || attempt === maxAttempts) throw error;

      const delayMs = Math.min(30_000, 2_000 * attempt);
      console.warn(
        `⏳ [oneTeam Bot] Another instance is still polling (409). ` +
          `Waiting ${Math.round(delayMs / 1000)}s before retry ${attempt + 1}/${maxAttempts}.`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Standalone entrypoint execution
if (process.env.NODE_ENV !== 'test') {
  const isDirectRun =
    process.argv[1] &&
    (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

  if (isDirectRun) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token.includes('mockBotToken')) {
      console.log('------------------------------------------------------------');
      console.log('oneTeam Telegram Bot ready in Standby/Test mode.');
      console.log('To connect to live Telegram servers, set a valid TELEGRAM_BOT_TOKEN in .env');
      console.log('Run automated end-to-end tests with: npm run bot:test');
      console.log('------------------------------------------------------------');
    } else {
      const bot = createBot(token);
      console.log('🚀 Starting oneTeam Telegram Bot in Polling Mode...');

      startPollingWithRetry(bot).catch((error) => {
        console.error('⛔ [oneTeam Bot] Polling stopped:', error);
        process.exit(1);
      });

      // Graceful shutdown
      const stop = () => {
        console.log('Stopping bot...');
        bot.stop();
        process.exit(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  }
}
