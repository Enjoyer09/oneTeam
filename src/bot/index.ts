import { Bot, session } from 'grammy';
import dotenv from 'dotenv';
import { BotContext, SessionData } from './types';
import { ApiSessionStorage, FlowStorageError } from './sessionStorage';
import { registerRoutes } from './router';

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

  // Session middleware — backed by the API, not by this process's memory.
  //
  // The default store is a `Map` inside this process, and this process is
  // replaced on every deploy. That is not a theoretical worry: a merchandiser who
  // had answered two of three checklist questions would come back to a bot
  // asking for their store code again, with no error and no way to tell whether
  // they had done something wrong. See `sessionStorage.ts` for the whole story.
  bot.use(
    session({
      initial: (): SessionData => ({ step: 'idle' }),

      // Keyed by CHAT. Every other chat-facing call this bot makes addresses a
      // chat — `bindTelegramUser({ telegramChatId })`, the field flow routes,
      // and `users.telegram_chat_id` in the database — so the session key has to
      // be that same value, or the bot would be writing its state under one
      // identity and reading it back under another.
      //
      // grammy's default is the chat id too. It is stated here anyway: a default
      // that happens to agree today is not an agreement, and this is the one line
      // where disagreeing would lose a merchandiser's work.
      getSessionKey: (ctx) => (ctx.chat ? String(ctx.chat.id) : undefined),

      storage: new ApiSessionStorage(),
    }),
  );

  // ROUTES
  //
  // They used to be registered here, inline, and four of the handlers they
  // named were imported and never reached: there was no `message:location`
  // route, the text route never got past the store-code branch, and the single
  // callback route accepted only `submit_`. The guided flow was therefore
  // unreachable in Telegram even though every handler worked — see
  // `router.ts` for the whole account.
  //
  // They live in `registerRoutes` now so that the surface can be read in one
  // place and driven by `router.test.ts`.
  registerRoutes(bot);

  // Global error handler
  bot.catch(async (err) => {
    console.error(`[oneTeam Bot Error] (Update ID: ${err.ctx.update.update_id}):`, err.error);

    // The one failure worth interrupting the chat for.
    //
    // Every other error this bot can hit is already answered in the handlers'
    // own words — a store code that does not exist, a photo that is too large,
    // an API that is down when a task list is asked for. Repeating those here
    // would only add noise.
    //
    // A storage failure has no other voice. The session could not be read or
    // written, which means the flow either did not run or did not get saved, and
    // the person is about to notice something is wrong. Saying so is what stops
    // them from concluding that their work was filed when it was not.
    if (err.error instanceof FlowStorageError) {
      const message =
        err.error.operation === 'read'
          ? '⚠️ *Davam edən işinizi yükləmək alınmadı.*\n\n' +
            'Sistem hazırda cavab vermir. *Heç nə itməyib* — bir az sonra yenidən ' +
            'yazın, işiniz qaldığı yerdən davam edəcək.'
          : '⚠️ *Davam edən işiniz yadda saxlanıla bilmədi.*\n\n' +
            'Sistem hazırda cavab vermir. Son cavabınız qeydə alınmamış ola bilər — ' +
            'zəhmət olmasa bir az sonra yoxlayın.';

      try {
        await err.ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (replyError) {
        // There is nothing left to try: the chat could not be told. Logged so the
        // failure is at least visible to whoever reads the logs.
        console.error(
          '[oneTeam Bot] Could not warn the chat about a flow storage failure:',
          replyError,
        );
      }
    }
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
async function startPollingWithRetry(bot: Bot<BotContext>, maxAttempts = 20): Promise<void> {
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
          `Waiting ${Math.round(delayMs / 1000)}s before retry ${attempt + 1}/${maxAttempts}.`,
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
