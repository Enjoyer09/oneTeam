/**
 * oneTeam — Field API routes
 * ============================================================================
 *
 * Consumed by the Telegram bot and by the mobile field client. Both
 * authenticate with a bearer token; see the note in field.service.ts about why
 * the acting person arrives as a channel key (`chatId` for a chat, `deviceId`
 * for a device) rather than as the caller's own identity.
 *
 * One set of endpoints for both channels is deliberate. A store that looks
 * different in the bot than in the mobile app, or a task that can be submitted
 * from one and not the other, is a bug class rather than a possibility — there is
 * only one code path to keep correct.
 *
 * WHY EVERY ROUTE NOW CHECKS THE ACTOR KEY AGAINST THE CREDENTIAL
 * --------------------------------------------------------------
 * A channel key in the body is how the bot acts on behalf of a chat, and it is
 * safe there because the bot is a server holding the service credential: it
 * derived that chat from the Telegram update it is handling, and a Telegram user
 * cannot call this API directly.
 *
 * The mobile client holds a *device* credential, which resolves to exactly one
 * user. If it were allowed to name an arbitrary `deviceId` in the body it would
 * inherit the bot's ability to act as anyone, and issuing it a narrower
 * credential would have bought nothing. `enforceActorScope` is what stops that:
 * a device credential may only name its own installation, and a service
 * credential may name anyone.
 *
 * The check lives here rather than in `FieldService` because it is a property of
 * the caller, and `FieldService` is deliberately unaware of how the call
 * arrived — it takes a key and acts on it.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { db } from '@oneteam/database';
import { FieldService, FieldActorKey } from './field.service';
import { AuthGuard, getPrincipal } from '../../common/auth/auth.guard';
import {
  AuthenticatedPrincipal,
  mayActAsAnotherUser,
} from '../../common/auth/authenticated-principal';

type AuthedRequest = ExpressRequest & { principal?: AuthenticatedPrincipal };

/** Reads the acting person's channel key off a request body. */
function actorKeyFrom(body: any): FieldActorKey {
  return { chatId: body?.chatId, deviceId: body?.deviceId };
}

/** Reads the acting person's channel key off a query string. */
function actorKeyFromQuery(chatId?: string, deviceId?: string): FieldActorKey {
  return { chatId, deviceId };
}

/**
 * Both endpoints need this, and both must reject the same malformed input.
 */
function requireActorKey(key: FieldActorKey): FieldActorKey {
  const hasChatId = key.chatId !== undefined && key.chatId !== null && key.chatId !== '';
  if (!hasChatId && !key.deviceId) {
    throw new BadRequestException('chatId və ya deviceId tələb olunur');
  }
  return key;
}

/**
 * The flow routes need a chat specifically, not "either channel".
 *
 * `requireActorKey` accepts a device id because the mobile client legitimately
 * identifies itself that way. The guided flow does not exist on that client: the
 * app has its own screens, and the steps here (`awaiting_location`,
 * `awaiting_photo`) are the ones a chat has to be walked through because it has
 * no UI to navigate. Accepting a `deviceId` would store a second, parallel
 * notion of "where the person is" that nothing reads — and a device credential
 * is refused a `chatId` by `enforceActorScope` anyway, so there is no third
 * option left to allow.
 */
function requireChatKey(key: FieldActorKey): FieldActorKey {
  const hasChatId = key.chatId !== undefined && key.chatId !== null && key.chatId !== '';
  if (!hasChatId) {
    throw new BadRequestException({
      error: 'CHAT_ID_REQUIRED',
      message: 'Bu bölmə yalnız Telegram çatları üçündür — chatId tələb olunur.',
    });
  }
  return key;
}

/**
 * Refuses a request whose actor key names someone the credential may not act as.
 *
 * A device credential is bound to one installation, so naming a different
 * `deviceId` — or any `chatId` at all — is refused with 403 rather than quietly
 * ignored. Silently substituting the caller's own device would be worse: the
 * request would succeed while answering about someone else's data, which is the
 * kind of bug that looks like a feature until it is an incident.
 */
function enforceActorScope(principal: AuthenticatedPrincipal, key: FieldActorKey): FieldActorKey {
  if (mayActAsAnotherUser(principal)) return key;

  const ownsDevice = Boolean(key.deviceId) && key.deviceId === principal.deviceId;
  if (!ownsDevice) {
    throw new ForbiddenException({
      error: 'ACTOR_SCOPE_VIOLATION',
      message:
        'Bu cihaz açarı yalnız öz quraşdırması üçün istifadə oluna bilər. ' +
        'Başqa cihaz və ya çat adı göstərilə bilməz.',
    });
  }

  return key;
}

@Controller('api/portal/field')
@UseGuards(AuthGuard)
export class FieldController {
  constructor(private readonly fieldService: FieldService) {}

  @Get('store')
  getStore(@Query('code') code?: string) {
    if (!code) throw new BadRequestException('code parametri tələb olunur');
    const store = this.fieldService.getStoreByCode(code);
    return { success: true, data: store };
  }

  /**
   * Answers "is my credential accepted, and as whom".
   *
   * This exists because both clients used to prove liveness by calling
   * `/api/portal/stores` — a supervisor route. That worked only because nothing
   * was guarding it, and it meant a field client was reading the full store list
   * of the whole chain to check whether it was online.
   *
   * It takes no actor key: the caller is asking about its own credential, and
   * the answer comes from the credential itself. Requiring an actor key here
   * would make the one route whose purpose is "who am I" depend on the caller
   * already knowing who it is.
   */
  @Get('whoami')
  whoami(@Request() request: AuthedRequest) {
    const principal = getPrincipal(request);
    const user = db.getUser(principal.userId);

    return {
      success: true,
      data: {
        userId: principal.userId,
        fullName: user?.fullName ?? null,
        role: principal.role,
        via: principal.via ?? 'service',
        deviceId: principal.deviceId ?? null,
      },
    };
  }

  @Get('session')
  getSession(
    @Request() request: AuthedRequest,
    @Query('chatId') chatId?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    const key = enforceActorScope(
      getPrincipal(request),
      requireActorKey(actorKeyFromQuery(chatId, deviceId)),
    );
    return this.fieldService.session(key);
  }

  @Post('bind')
  @HttpCode(HttpStatus.OK)
  bind(
    @Request() request: AuthedRequest,
    @Body()
    body: {
      chatId?: string | number;
      deviceId?: string;
      fullName?: string;
      storeId?: string;
    },
  ) {
    const key = enforceActorScope(getPrincipal(request), requireActorKey(actorKeyFrom(body)));
    return this.fieldService.bind(key, body.fullName || 'Sahə işçisi', body.storeId);
  }

  /**
   * Where this chat is in the guided flow — the bot's own working state.
   *
   * NOT `session` ABOVE. That one answers "who is this chat" and lives in the
   * `users` table; this answers "which question were we on" and lives in
   * `bot_sessions`, where it expires. The bot used to keep this in its process
   * memory, which meant every deploy silently dropped a merchandiser's
   * half-finished audit — the bot did not error, it just asked for the store code
   * again.
   *
   * The read refreshes the expiry, so a flow that is being used does not time
   * out under the person using it.
   */
  @Get('flow')
  getFlow(@Request() request: AuthedRequest, @Query('chatId') chatId?: string) {
    const key = enforceActorScope(getPrincipal(request), requireChatKey({ chatId }));
    return this.fieldService.readFlow(key);
  }

  @Put('flow')
  @HttpCode(HttpStatus.OK)
  putFlow(
    @Request() request: AuthedRequest,
    @Body() body: { chatId?: string | number } & Record<string, unknown>,
  ) {
    const key = enforceActorScope(getPrincipal(request), requireChatKey(actorKeyFrom(body)));
    return this.fieldService.saveFlow(key, body);
  }

  @Delete('flow')
  @HttpCode(HttpStatus.OK)
  deleteFlow(@Request() request: AuthedRequest, @Query('chatId') chatId?: string) {
    const key = enforceActorScope(getPrincipal(request), requireChatKey({ chatId }));
    return this.fieldService.clearFlow(key);
  }

  @Get('tasks')
  getTasks(@Query('storeId') storeId?: string) {
    if (!storeId) throw new BadRequestException('storeId parametri tələb olunur');
    const data = this.fieldService.getTasksForStore(storeId);
    return { success: true, data, total: data.length };
  }

  @Get('tasks/:id')
  getTaskById(@Param('id') id: string) {
    const task = this.fieldService.getTaskById(id);
    if (!task) {
      return { success: false, data: null, message: `Tapşırıq tapılmadı: ${id}` };
    }
    return { success: true, data: task };
  }

  @Post('tasks/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledge(
    @Request() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { chatId?: string | number; deviceId?: string },
  ) {
    const key = enforceActorScope(getPrincipal(request), requireActorKey(actorKeyFrom(body)));
    return this.fieldService.acknowledgeTask(key, id);
  }

  /**
   * Claims a single store task for the caller standing in the store.
   *
   * The bot calls this when a merchandiser opens a task, so a task the panel
   * pre-assigned to someone else can still be taken on by whoever holds the
   * store code — see `FieldService.claimStoreTask` for why the store code is the
   * authority and what it refuses to take.
   */
  @Post('tasks/:id/claim')
  @HttpCode(HttpStatus.OK)
  claimTask(
    @Request() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { chatId?: string | number; deviceId?: string; storeId?: string },
  ) {
    if (!body.storeId) throw new BadRequestException('storeId tələb olunur');
    const key = enforceActorScope(getPrincipal(request), requireActorKey(actorKeyFrom(body)));
    return this.fieldService.claimStoreTask(key, id, body.storeId);
  }

  @Get('submissions')
  getSubmissions(
    @Request() request: AuthedRequest,
    @Query('chatId') chatId?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
  ) {
    const key = enforceActorScope(
      getPrincipal(request),
      requireActorKey(actorKeyFromQuery(chatId, deviceId)),
    );
    const data = this.fieldService.getSubmissions(key, limit ? Number(limit) : 5);
    return { success: true, data, total: data.length };
  }

  @Post('submissions')
  @HttpCode(HttpStatus.CREATED)
  async submitSubmission(@Request() request: AuthedRequest, @Body() body: any) {
    // The scope check is the point of this line; the key itself already came
    // from the body, so nothing needs merging back into it.
    enforceActorScope(getPrincipal(request), requireActorKey(actorKeyFrom(body)));
    if (!body?.storeTaskId) {
      throw new BadRequestException('storeTaskId tələb olunur');
    }
    if (!body?.photoUrl) {
      throw new BadRequestException('photoUrl tələb olunur');
    }
    return this.fieldService.submitSubmission(body);
  }

  /**
   * Refuses a request that only the bot is entitled to make.
   *
   * The outbox is not a field-worker resource: it is the queue the bot drains,
   * and it is addressed by chat rather than by person. A device credential
   * resolving to one merchandiser has no business reading or clearing another
   * chat's pending messages, and a panel key belongs to a person reviewing
   * audits, not to a delivery loop.
   *
   * Expressed with `mayActAsAnotherUser` rather than a new rule, because that is
   * exactly the same question — "may this caller speak for anyone?" — and a
   * second implementation of it would be a second thing to keep in step.
   */
  private requireServiceActor(principal: AuthenticatedPrincipal): void {
    if (!mayActAsAnotherUser(principal)) {
      throw new ForbiddenException({
        error: 'ACTOR_SCOPE_VIOLATION',
        message: 'Bildiriş növbəsi yalnız botun servis kredensialı üçündür.',
      });
    }
  }

  /**
   * Leases the pending notifications so the bot can send them.
   *
   * Returns them claimed, not merely read — see `claimPendingNotifications`.
   * A caller that takes a message and never reports back does not lose it: the
   * claim expires and the next poll picks it up again.
   */
  @Get('notifications')
  getNotifications(
    @Request() request: AuthedRequest,
    @Query('chatId') chatId?: string,
    @Query('limit') limit?: string,
    @Query('claimedBy') claimedBy?: string,
  ) {
    this.requireServiceActor(getPrincipal(request));
    return this.fieldService.claimPendingNotifications({
      chatId,
      limit: limit ? Number(limit) : undefined,
      claimedBy,
    });
  }

  @Post('notifications/:id/delivered')
  @HttpCode(HttpStatus.OK)
  markNotificationDelivered(@Request() request: AuthedRequest, @Param('id') id: string) {
    this.requireServiceActor(getPrincipal(request));
    return this.fieldService.markNotificationDelivered(id);
  }

  /**
   * Records that Telegram refused the message.
   *
   * The body is the reason, and it is stored on the row. Only failures a retry
   * cannot fix belong here; anything transient should be left alone so the lease
   * expires and the message is tried again.
   */
  @Post('notifications/:id/failed')
  @HttpCode(HttpStatus.OK)
  markNotificationFailed(
    @Request() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { failure?: string },
  ) {
    this.requireServiceActor(getPrincipal(request));
    return this.fieldService.markNotificationFailed(id, body?.failure || 'Göndərilə bilmədi');
  }

  /**
   * Optional direct upload.
   *
   * `POST submissions` already offloads a data URL by itself, so this is for a
   * client that would rather send the bytes once. It takes base64 rather than
   * multipart because the only clients are a Telegram bot and a mobile app, both
   * of which already hold the image as base64 — a multipart parser would be a
   * dependency added for nobody's benefit.
   */
  @Post('photos')
  @HttpCode(HttpStatus.CREATED)
  async uploadPhoto(
    @Body()
    body: {
      base64?: string;
      contentType?: string;
      scope?: string;
    },
  ) {
    if (!body?.base64) {
      throw new BadRequestException('base64 tələb olunur');
    }
    return this.fieldService.uploadPhoto({
      base64: body.base64,
      contentType: body.contentType,
      scope: body.scope,
    });
  }

  /**
   * Presigned direct upload.
   *
   * Returns a short-lived URL the client PUTs the bytes to DIRECTLY, so the
   * image never travels through the API. The client then submits the returned
   * `publicUrl` as its `photoUrl`. Unlike `POST photos` (which proxies base64
   * through the API), this keeps megabytes off the API entirely. See
   * docs/PRESIGNED-UPLOAD-PLAN-AZ.md.
   *
   * OPEN TO ANY AUTHENTICATED FIELD ACTOR — NOT SERVICE-ONLY
   * --------------------------------------------------------
   * The sibling write endpoints above (`ack`, `submissions`, notifications)
   * carry `requireServiceActor`, so it is worth being explicit about why this
   * one deliberately does not: the mobile client authenticates as a DEVICE, not
   * a service, and `mayActAsAnotherUser` is true only for the service `via`, so
   * a `requireServiceActor` here would 403 (`ACTOR_SCOPE_VIOLATION`) every phone
   * — and the whole point of this endpoint is to move the phone's photo off the
   * API body. So the mobile presigned rollout (plan §3.1, step 3) relaxes it.
   *
   * The relaxation is safe on its own terms, and none of the reasons the other
   * endpoints are service-only apply here:
   *   - AuthGuard still runs, so an unauthenticated request is still 401 — this
   *     opens the door to a wider set of *authenticated* actors, not to anyone.
   *   - The body carries NO actor field. `requireServiceActor` guards the
   *     "act as another user" surface; this endpoint has none to guard.
   *   - The object KEY is minted server-side (`StorageService.mintKey`), so the
   *     caller cannot choose a path, overwrite a sibling's object, or traverse.
   *   - A device can ALREADY put bytes in the same bucket two other ways with no
   *     stricter check: `POST submissions` offloads its inline data URL, and
   *     `POST photos` (right above) has no actor check at all. This endpoint is
   *     a cheaper transport for a capability the device already holds, not a new
   *     one — so it does not widen what a compromised device token can reach.
   *
   * No `@Request()` param: with the actor gate gone there is nothing left to
   * read off the principal here.
   */
  @Post('photos/presign')
  @HttpCode(HttpStatus.CREATED)
  presignPhotoUpload(@Body() body: { contentType?: string; scope?: string }) {
    return this.fieldService.createPresignedUpload({
      contentType: body?.contentType,
      scope: body?.scope,
    });
  }
}
