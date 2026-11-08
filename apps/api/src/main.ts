// Loaded before anything else reads `process.env`.
//
// WHY THIS LINE EXISTS
// --------------------
// The bot loaded `.env` and the API did not, and the difference failed silently.
// `.env` held `DATABASE_URL`; the bot got its token, while the API came up on the
// built-in seed data — `/api/health` reported `persistence: "memory"` and a
// device enrolment answered 503 `ENROLMENT_UNAVAILABLE`, because
// `issueDeviceToken` refuses to mint a credential it cannot persist. No error was
// logged anywhere: the phone simply could not sign in, and the reason was only
// visible to someone who read the health payload.
//
// Real environment variables still win — dotenv does not overwrite what is
// already set, so a container or CI that exports `DATABASE_URL` is unaffected,
// and a missing `.env` is not an error.
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { db } from '@oneteam/database';

/**
 * Origins allowed to call this API from a browser.
 *
 * WHY THIS IS NOT `origin: '*'`
 * -----------------------------
 * The API previously allowed every origin. Combined with a bearer-token
 * authorisation scheme, that means any web page a signed-in user visits can
 * make authenticated calls to this API on their behalf and read the responses.
 * The token does not have to leak for that to happen.
 *
 * FAIL-CLOSED IN PRODUCTION
 * -------------------------
 * If `CORS_ALLOWED_ORIGINS` is unset in production, no cross-origin request is
 * allowed and the reason is logged loudly. An allow-list that silently degrades
 * to "allow everything" when misconfigured is not an allow-list.
 *
 * Configure it as a comma-separated list, for example:
 *
 *     CORS_ALLOWED_ORIGINS=https://portal.oneteam.az,https://admin.oneteam.az
 */
function resolveAllowedOrigins(logger: Logger): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;

  if (raw && raw.trim()) {
    const origins = raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    if (origins.includes('*')) {
      logger.error(
        '⛔ CORS_ALLOWED_ORIGINS contains "*". Refusing to run with a wildcard — ' +
          'list the exact origins instead.',
      );
      return [];
    }
    return origins;
  }

  if (process.env.NODE_ENV === 'production') {
    logger.error(
      '⛔ CORS_ALLOWED_ORIGINS is not set. No cross-origin request will be allowed. ' +
        'Set it to a comma-separated list of the exact origins that may call this API.',
    );
    return [];
  }

  // Development convenience only. Never reachable when NODE_ENV=production.
  logger.warn(
    '⚠️  CORS_ALLOWED_ORIGINS is not set — falling back to local development origins. ' +
      'This fallback does not apply in production.',
  );
  return ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

async function bootstrap() {
  const logger = new Logger('oneTeam-API');
  // `bodyParser: false` so we register the JSON/urlencoded parsers ourselves
  // with a raised size limit (below). Express's default JSON limit is 100kb,
  // and a field submission carries the shelf photo INLINE as a base64 `data:`
  // URL — there is no object store yet, so `POST /api/portal/field/submissions`
  // ships the whole image in the body (see `uploadShelfPhoto` in the bot's
  // portalApi). A real photo blew past 100kb and the parser rejected it with
  // `PayloadTooLargeError: request entity too large`, surfacing to the
  // merchandiser as "şəkil qeydə alına bilmədi, daxili server xətası".
  //
  // If Nest's own parsers were left on (the default), they would run FIRST at
  // 100kb and throw before any raised-limit parser we add could see the body —
  // hence `bodyParser: false` here and explicit registration once, below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Honour the reverse proxy's X-Forwarded-For, when one is configured.
  //
  // WHY THIS IS OPT-IN RATHER THAN ALWAYS ON
  // ----------------------------------------
  // The per-address enrolment limiter keys on `request.ip`. Behind the web
  // nginx every caller arrives from the proxy's address, so without trust the
  // whole deployment shares ONE bucket and one abusive origin locks out every
  // honest sign-in (measured as a real DoS, not a hypothetical). But enabling
  // trust while the API port is DIRECTLY reachable would let a client forge
  // X-Forwarded-For and rotate the limiter for free. So the operator declares
  // the topology: "1" (or "true") for one proxy hop, "loopback" for a local
  // proxy, or a number of hops. Unset means the API is reached directly and
  // `request.ip` is the socket address — spoof-proof but NAT-shared.
  const trustProxy = process.env.ONETEAM_TRUST_PROXY?.trim();
  if (trustProxy) {
    app.set(
      'trust proxy',
      trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy,
    );
  }

  // 5mb comfortably covers the bot's own MAX_PHOTO_BYTES cap (~1.5mb for the
  // data URL) plus the checklist answers, metadata and AI verdict sent
  // alongside it, while still bounding the body so an oversized payload is
  // rejected rather than read without limit. The bot's 1.5mb cap is the real
  // gate on photo size; this is the transport ceiling behind it.
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '5mb' });

  // Load persisted state BEFORE the HTTP listener opens.
  //
  // The repository hydrates its working set from PostgreSQL here. Doing it
  // after `listen()` would leave a window in which the first requests are
  // answered from seed data and then silently replaced, which is the kind of
  // race that only shows up as "the task I just created disappeared".
  //
  // init() never throws: if the database is unreachable it logs at error level
  // and the API starts on in-memory seed data. /api/health reports which mode
  // is in use, so this cannot go unnoticed.
  await db.init();

  // One consistent home for unhandled errors, so a raw throw becomes a safe 500
  // instead of a stack trace on the wire. Understood HttpExceptions pass through
  // unchanged — see the filter for why that boundary matters.
  app.useGlobalFilters(new AllExceptionsFilter());

  // A global validation pipe, ready for the DTOs the controllers are migrating
  // to. `whitelist` strips properties a DTO does not declare; it is inert for a
  // body still typed `any` (no class metadata to validate against), so wiring it
  // now changes nothing today and enforces the contract as DTOs land.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidUnknownValues: false,
      transform: false,
    }),
  );

  const allowedOrigins = resolveAllowedOrigins(logger);

  app.enableCors({
    // A function rather than an array: NestJS treats a returned `false` as
    // "no CORS headers", which is what a rejected origin should get.
    //
    // Parameters are annotated explicitly rather than inferred. NestJS's CORS
    // callback types come from `@types/express`, and relying on that inference
    // makes this file fail to compile whenever those types are unavailable —
    // an avoidable coupling between an unrelated dependency and the API's
    // security configuration.
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // No Origin header: a same-origin request, curl, or a server-to-server
      // call. CORS does not apply, so it is not our concern to block.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      logger.warn(`⛔ CORS: rejected request from disallowed origin ${origin}`);
      return callback(null, false);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type,Authorization,X-Telegram-Bot-Api-Secret-Token',
    maxAge: 600,
  });

  // `PORT` first, deliberately.
  //
  // Hosting platforms assign the port the container must listen on through
  // `PORT` and route traffic only to that port. Docker Compose, by contrast,
  // uses `API_PORT` in this project. Reading PORT first means the same image
  // runs unmodified on a platform, while the compose file keeps working.
  const port = process.env.PORT || process.env.API_PORT || 3001;
  await app.listen(port);
  logger.log(`🚀 oneTeam Retail Execution Core API is running on http://localhost:${port}`);
  logger.log(
    allowedOrigins.length
      ? `🌐 CORS allow-list: ${allowedOrigins.join(', ')}`
      : '🌐 CORS allow-list is empty — no browser origin may call this API.',
  );
}

if (require.main === module) {
  // A failed bootstrap must be loud and must set a non-zero exit code.
  //
  // This used to be a bare `bootstrap();`. A rejection inside it — the port
  // already in use, a crash in `NestFactory.create` — then became an unhandled
  // rejection: Node prints the stack and exits 1, which in a hosting platform
  // log is indistinguishable from any other crash. Naming the failure here
  // means the platform shows "the API failed to start" and why.
  void bootstrap().catch((error: unknown) => {
    new Logger('oneTeam-API').error(
      `⛔ The API failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

export { bootstrap };
