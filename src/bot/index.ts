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
      bot.start({
        onStart(botInfo) {
          console.log(`✅ oneTeam Bot connected as @${botInfo.username}`);
        },
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
