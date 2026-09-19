/**
 * oneTeam — device enrolment
 * ============================================================================
 *
 * WHY THIS ENDPOINT HAS NO AUTH GUARD, AND WHY THAT IS NOT AN OVERSIGHT
 * --------------------------------------------------------------------
 * Every other route in this module requires a bearer token. This one cannot:
 * its entire purpose is to hand a credential to a device that does not have one
 * yet. Adding a guard would mean shipping the credential the guard expects
 * inside the app — which is exactly the problem being fixed.
 *
 * So the question is not "how do we authenticate this call", it is "what does a
 * device have to prove before it is given a credential". The answer is the same
 * thing the chat channel already accepts as proof: the store's code. In the
 * Telegram flow, whoever knows the store code is treated as standing in that
 * store and claims its open work. Enrolling a device on the same terms keeps one
 * rule for both channels instead of inventing a second, weaker one.
 *
 * WHAT THAT IS WORTH, HONESTLY
 * ----------------------------
 * A store code is semi-public — it is printed on the merchandiser's briefing and
 * shared between colleagues. Someone who learns one can enrol a device and act
 * as a merchandiser for that store. That is a real exposure, and it is strictly
 * smaller than the one it replaces: the app previously shipped the service
 * credential and defaulted to an *administrator* identity, so extracting one
 * string from a downloadable bundle gave access to every store, every task and
 * every audit.
 *
 * It is also a REPLAYABLE claim, which the first version of this file did not
 * reckon with. A store code does not get used up, so it could be presented again
 * and again with a different `deviceId` — and each presentation produced another
 * user and another live credential. Measured against the running API: five
 * requests, five identities, no limit. The fix is the fourth bullet below.
 *
 * Four things narrow it, and all four are cheap:
 *
 *   - `ONETEAM_ENROLLMENT_SECRET`, when set, must be supplied as well. That
 *     turns the store code into a username and this into the password, and is
 *     the recommended configuration for anything past a pilot.
 *   - Failed enrolments are rate-limited per source address, so a code cannot be
 *     brute-forced by trying store codes in a loop. Only failures count, so a
 *     shop full of colleagues signing in behind one address is unaffected.
 *   - Every enrolment is written to the audit log with the address it came from.
 *     "Which device was enrolled, when, and from where" is the question asked
 *     after an incident, and it is only answerable if it was recorded before one.
 *   - New installations are capped per store, so a code that has leaked yields a
 *     bounded number of identities instead of an unbounded supply. See
 *     `MAX_NEW_DEVICES_PER_STORE` for what is counted and why re-enrolment is not.
 *
 * The token that comes back identifies exactly one user. Unlike the service
 * credential it cannot be used to act as anybody else, so its blast radius is
 * one installation.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { db } from '@oneteam/database';
import { FieldService } from './field.service';

/**
 * Failed enrolment attempts allowed per address per window.
 *
 * WHAT IS COUNTED, AND WHY IT IS NOT WHAT YOU MIGHT EXPECT
 * -------------------------------------------------------
 * Only FAILURES count. A successful enrolment is not an attack, and counting it
 * was a real bug: an entire shop sits behind one NAT address, so a dozen
 * merchandisers signing in at the start of a shift would consume the window and
 * lock out the thirteenth — the limiter would have punished the exact behaviour
 * it exists to allow.
 *
 * Counting failures targets the actual attack instead: guessing store codes in a
 * loop. Correct sign-ins are unlimited *here*; wrong ones are what run out.
 * Unlimited here is not unlimited everywhere — a new installation is capped per
 * store by `MAX_NEW_DEVICES_PER_STORE` below, which is a different control for a
 * different attack and deliberately counts different things.
 *
 * Sized for a person who mistypes a few times, not for a script. Overridable
 * with `ONETEAM_ENROLLMENT_MAX_FAILURES` so a deployment can tighten or relax it
 * without a rebuild.
 *
 * In memory, and therefore per replica. That is a real limitation and is stated
 * rather than hidden: a second API instance would allow a second window's worth
 * of attempts. It is a speed bump on an endpoint that already requires a valid
 * store code, not the control itself.
 */
const MAX_FAILURES_PER_WINDOW = Number(process.env.ONETEAM_ENROLLMENT_MAX_FAILURES) || 20;
const WINDOW_MS = 15 * 60 * 1000;

const failures = new Map<string, number[]>();

/** Whether this address has already failed too many times recently. */
function isThrottled(key: string): { throttled: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const recent = (failures.get(key) ?? []).filter((at) => now - at < WINDOW_MS);

  if (recent.length === 0) {
    failures.delete(key);
    return { throttled: false, retryAfterSeconds: 0 };
  }

  failures.set(key, recent);

  if (recent.length >= MAX_FAILURES_PER_WINDOW) {
    return {
      throttled: true,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - recent[0])) / 1000)),
    };
  }

  return { throttled: false, retryAfterSeconds: 0 };
}

/** Records a wrong store code or a wrong enrolment secret. */
function recordFailure(key: string): void {
  const now = Date.now();
  const recent = (failures.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);

  // Bounded so a long-running process cannot accumulate an entry per address it
  // has ever seen. Dropping the oldest half keeps the map proportional to
  // recent traffic.
  if (failures.size > 10_000) {
    const keys = [...failures.keys()].slice(0, 5_000);
    for (const k of keys) failures.delete(k);
  }
}

/**
 * New installations one store may enrol in a window.
 *
 * THE HOLE THIS CLOSES
 * --------------------
 * This endpoint hands out credentials without one, so it is the only place an
 * identity can be created out of nothing. It was bounded only by the failure
 * limiter above, which counts *wrong* store codes — and a correct one is not a
 * failure. So one valid, semi-public store code could be replayed with a fresh
 * `deviceId` for as long as the caller cared to keep going. Measured on the real
 * API: five requests, five new `users` rows, five live device credentials, no
 * limit and no signal. Each of those identities is a merchandiser at that store,
 * and `bind()` also hands each one the store's unassigned open work.
 *
 * WHAT IS COUNTED, AND WHY IT IS NOT THE SAME AS THE LIMITER ABOVE
 * ----------------------------------------------------------------
 * Only enrolments that create a *new* installation. A device that is already
 * known is re-enrolling, not joining, and this is not a theoretical distinction:
 * the mobile client has no storage layer, so it enrols again on every process
 * start. Counting those would make the cap fire on entirely ordinary use, which
 * is how a security control gets switched off.
 *
 * The key is the STORE, not the address. The failure limiter is per-address
 * because guessing store codes is an address-shaped attack; this one is
 * store-shaped, because the resource being consumed is identities at one store.
 * Keying it on the address would have punished a shop behind one NAT — the exact
 * mistake the limiter above already made once and had to be fixed for.
 *
 * A store's real device count is a handful of phones, so the default is set well
 * above any honest onboarding day and well below anything a script would want.
 * It is a bound on the damage, not a barrier to the work.
 *
 * THE TRADE-OFF, STATED
 * ---------------------
 * Someone holding a leaked store code can spend this budget to stop a colleague
 * enrolling that day. That is worse than nothing only if the alternative were
 * unlimited identities — which it was — so the bound is still the better
 * arrangement. It is also visible rather than silent: a refusal is logged, and
 * written to the audit trail with the store and the source address, so an
 * operator can see it happening and raise the limit. `ONETEAM_ENROLLMENT_SECRET`
 * remains the actual answer, and this is what limits the damage until it is set.
 *
 * In memory, and therefore per replica — the same honest limitation as the
 * limiter above. A second API instance would allow a second window's worth.
 */
const MAX_NEW_DEVICES_PER_STORE = Number(process.env.ONETEAM_ENROLLMENT_MAX_NEW_DEVICES) || 30;
const NEW_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const newDevices = new Map<string, number[]>();

/** Whether this store has already taken as many new installations as it may. */
function newDeviceGate(storeId: string): {
  allowed: boolean;
  used: number;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const recent = (newDevices.get(storeId) ?? []).filter((at) => now - at < NEW_DEVICE_WINDOW_MS);

  if (recent.length === 0) {
    newDevices.delete(storeId);
    return { allowed: true, used: 0, retryAfterSeconds: 0 };
  }

  newDevices.set(storeId, recent);

  if (recent.length >= MAX_NEW_DEVICES_PER_STORE) {
    return {
      allowed: false,
      used: recent.length,
      retryAfterSeconds: Math.max(1, Math.ceil((NEW_DEVICE_WINDOW_MS - (now - recent[0])) / 1000)),
    };
  }

  return { allowed: true, used: recent.length, retryAfterSeconds: 0 };
}

/** Records that a new installation joined this store. */
function recordNewDevice(storeId: string): void {
  const now = Date.now();
  const recent = (newDevices.get(storeId) ?? []).filter((at) => now - at < NEW_DEVICE_WINDOW_MS);
  recent.push(now);
  newDevices.set(storeId, recent);

  if (newDevices.size > 10_000) {
    const keys = [...newDevices.keys()].slice(0, 5_000);
    for (const k of keys) newDevices.delete(k);
  }
}

/** Exposed so a test can start from a clean window. */
export function resetEnrollmentThrottle(): void {
  failures.clear();
  newDevices.clear();
}

/** The configured new-installation cap, for tests and for the refusal message. */
export function enrollmentNewDeviceLimit(): number {
  return MAX_NEW_DEVICES_PER_STORE;
}

@Controller('api/portal/field')
export class EnrollmentController {
  private readonly logger = new Logger(EnrollmentController.name);

  constructor(private readonly fieldService: FieldService) {}

  /**
   * The store a code names, for the app's pre-enrolment geofence check.
   *
   * WHY THIS ROUTE HAD TO EXIST
   * ---------------------------
   * The mobile login screen resolves the store, verifies the device is really
   * inside it, and only then enrols. That order is deliberate and documented on
   * `LoginScreenController.authenticateAndVerifyStore`: enrolling claims the
   * store's open work, and un-claiming is a supervisor action, so claiming from
   * a car park hands a merchandiser tasks they cannot do.
   *
   * That order needs the store's coordinates BEFORE any credential exists — and
   * `GET /api/portal/field/store` cannot supply them, because `FieldController`
   * carries `@UseGuards(AuthGuard)` at the class level and answers 401 until the
   * device has a token. A device gets its token by enrolling. Measured on
   * 2026-09-19: the first call of the first sign-in on a fresh installation
   * therefore always failed, the app showed "Sistemə qoşulmaq mümkün olmadı",
   * and it could not be signed into at all. No test caught it because the CI UI
   * test only exercises the REJECTION path, and the full-flow test is skipped
   * without a backend.
   *
   * WHY IT LIVES HERE, AND IS GATED THE SAME WAY AS `enroll`
   * -------------------------------------------------------
   * This controller has no class-level guard, which is what makes `enroll`
   * reachable without a credential. Putting the lookup anywhere else would mean
   * either a second public controller or an exception carved into the guard.
   *
   * It demands the same thing `enroll` demands: when
   * `ONETEAM_ENROLLMENT_SECRET` is set, the caller must supply it. Deliberate,
   * not convenient — a lookup that were easier to reach than the enrolment it
   * precedes would become the cheap way to enumerate store codes, which is the
   * exact attack the secret exists to stop. Failures are counted in the same
   * per-address window as enrolment failures, so guessing codes here costs the
   * same as guessing them there.
   *
   * It returns the authenticated route's shape by calling the same service
   * method. Two shapes for one resource would be two contracts to keep in step,
   * and the app renders this store as soon as it signs in.
   */
  @Get('store-lookup')
  lookupStoreForEnrolment(
    @Query('code') code: string | undefined,
    @Headers('x-enrollment-secret') suppliedSecret: string | undefined,
    @Req() request: Request,
  ) {
    const source = request.ip || request.socket?.remoteAddress || 'unknown';

    const gate = isThrottled(source);
    if (gate.throttled) {
      this.logger.warn(`⛔ Store lookup rate limit reached for ${source}`);
      throw new HttpException(
        {
          error: 'TOO_MANY_ATTEMPTS',
          message: 'Çox cəhd edildi. Zəhmət olmasa bir az sonra yenidən yoxlayın.',
          retryAfterSeconds: gate.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const requiredSecret = process.env.ONETEAM_ENROLLMENT_SECRET?.trim();
    if (requiredSecret && suppliedSecret?.trim() !== requiredSecret) {
      recordFailure(source);
      this.logger.warn(`⛔ Store lookup refused for ${source}: bad or missing enrolment secret.`);
      throw new HttpException(
        {
          error: 'ENROLLMENT_SECRET_REQUIRED',
          message: 'Qeydiyyat açarı yanlışdır və ya göndərilməyib.',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const trimmed = code?.trim();
    if (!trimmed) {
      throw new HttpException(
        { error: 'STORE_CODE_REQUIRED', message: 'Mağaza kodu tələb olunur.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const store = this.fieldService.getStoreByCode(trimmed);
    if (!store) {
      // Counted, for the same reason `enroll` counts it: a code that does not
      // exist is what a loop over candidate codes looks like.
      recordFailure(source);
      throw new HttpException(
        { error: 'STORE_NOT_FOUND', message: `Mağaza kodu tapılmadı: ${trimmed}` },
        HttpStatus.NOT_FOUND,
      );
    }

    return { success: true, data: store };
  }

  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  async enroll(
    @Body()
    body: {
      storeCode?: string;
      fullName?: string;
      deviceId?: string;
      enrollmentSecret?: string;
    },
    @Req() request: Request,
  ) {
    const storeCode = body?.storeCode?.trim();
    const fullName = body?.fullName?.trim();
    const deviceId = body?.deviceId?.trim();

    if (!storeCode) {
      throw new HttpException(
        { error: 'STORE_CODE_REQUIRED', message: 'Mağaza kodu tələb olunur.' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!deviceId) {
      throw new HttpException(
        { error: 'DEVICE_ID_REQUIRED', message: 'Cihaz identifikatoru tələb olunur.' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!fullName) {
      throw new HttpException(
        { error: 'FULL_NAME_REQUIRED', message: 'Ad və soyad tələb olunur.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const source = request.ip || request.socket?.remoteAddress || 'unknown';
    const gate = isThrottled(source);
    if (gate.throttled) {
      this.logger.warn(`⛔ Enrolment rate limit reached for ${source}`);
      throw new HttpException(
        {
          error: 'TOO_MANY_ATTEMPTS',
          message: 'Çox cəhd edildi. Zəhmət olmasa bir az sonra yenidən yoxlayın.',
          retryAfterSeconds: gate.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // The optional second factor. Absent, the store code stands alone — which is
    // stated in the file header rather than presented as equivalent.
    const requiredSecret = process.env.ONETEAM_ENROLLMENT_SECRET?.trim();
    if (requiredSecret && body?.enrollmentSecret !== requiredSecret) {
      recordFailure(source);
      this.logger.warn(`⛔ Enrolment refused for ${source}: bad or missing enrolment secret.`);
      throw new HttpException(
        {
          error: 'ENROLLMENT_SECRET_REQUIRED',
          message: 'Qeydiyyat açarı yanlışdır və ya göndərilməyib.',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const store = db.getStoreByCode(storeCode);
    if (!store) {
      // The one failure worth counting: a code that does not exist is what a
      // loop over candidate codes looks like.
      recordFailure(source);
      throw new HttpException(
        {
          error: 'STORE_NOT_FOUND',
          message: `Mağaza kodu tapılmadı: ${storeCode}`,
        },
        HttpStatus.NOT_FOUND,
      );
    }
    if (!store.isActive) {
      throw new HttpException(
        {
          error: 'STORE_INACTIVE',
          message: `Bu mağaza aktiv deyil: ${storeCode}`,
        },
        HttpStatus.CONFLICT,
      );
    }

    // A device that is already known is re-enrolling, not joining. The mobile
    // client has no storage layer, so it does this on every process start, and
    // counting those would make the cap below fire on ordinary use — see
    // `MAX_NEW_DEVICES_PER_STORE`.
    const knownDevice = db.getUserByMobileDeviceId(deviceId);

    if (!knownDevice) {
      const gate = newDeviceGate(store.id);
      if (!gate.allowed) {
        // Written before the refusal is returned, because this is the signal an
        // operator needs: a store that suddenly starts asking for more
        // installations than it has phones is either a rollout or an incident,
        // and only the trail can tell them apart afterwards.
        db.logAuditEvent({
          entityType: 'store',
          entityId: store.id,
          action: 'DEVICE_ENROLMENT_LIMIT_REACHED',
          // No actorId: no identity was established, which is the whole point.
          payload: {
            storeId: store.id,
            storeCode: store.storeCode,
            deviceId,
            source,
            used: gate.used,
            cap: MAX_NEW_DEVICES_PER_STORE,
          },
        });
        this.logger.warn(
          `⛔ Enrolment refused for ${source}: ${store.storeCode} has already enrolled ` +
            `${gate.used} new device(s) (cap ${MAX_NEW_DEVICES_PER_STORE}).`,
        );
        throw new HttpException(
          {
            error: 'ENROLMENT_LIMIT_REACHED',
            message:
              `Bu mağaza üçün yeni cihaz limiti dolub ` +
              `(${gate.used}/${MAX_NEW_DEVICES_PER_STORE}). ` +
              'Zəhmət olmasa administratorla əlaqə saxlayın.',
            retryAfterSeconds: gate.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // Binding is the same call the chat channel makes: it creates or updates the
    // user for this external key and claims the store's open work. Reusing it
    // rather than writing a second path is what keeps the two channels from
    // drifting on who may claim what.
    const bound = this.fieldService.bind({ deviceId }, fullName, store.id);
    const userId = bound.data.id as string;

    // Counted only once the identity actually exists, so a failure further down
    // does not spend the store's budget on an installation that never joined.
    if (!knownDevice) recordNewDevice(store.id);

    const issued = await db.issueDeviceToken({
      userId,
      deviceId,
      label: `${fullName} @ ${store.storeCode}`,
    });

    if (!issued) {
      // Only reachable with no database connection. Refusing is the right
      // answer: a token that lives in memory would be gone after the next
      // restart, and the device would have been told it was enrolled.
      throw new HttpException(
        {
          error: 'ENROLMENT_UNAVAILABLE',
          message:
            'Cihaz açarı yaradıla bilmədi — server bazaya qoşulmayıb. ' +
            'Zəhmət olmasa administratorla əlaqə saxlayın.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    db.logAuditEvent({
      entityType: 'user',
      entityId: userId,
      action: 'DEVICE_ENROLLED',
      actorId: userId,
      payload: {
        deviceId,
        storeId: store.id,
        storeCode: store.storeCode,
        claimedTaskIds: bound.data.claimedTaskIds,
        source,
        secondFactor: Boolean(requiredSecret),
        tokenPrefix: issued.token.slice(0, 8),
      },
    });

    this.logger.log(`🔐 [ENROL] device ${deviceId} -> ${userId} at ${store.storeCode} (${source})`);

    return {
      success: true,
      data: {
        // Returned exactly once. Only its hash is stored, so it cannot be
        // recovered afterwards — a lost token means re-enrolling.
        token: issued.token,
        userId,
        fullName,
        role: bound.data.role,
        store: {
          id: store.id,
          storeCode: store.storeCode,
          name: store.name,
          latitude: store.latitude,
          longitude: store.longitude,
        },
        claimedTaskIds: bound.data.claimedTaskIds,
      },
    };
  }
}
