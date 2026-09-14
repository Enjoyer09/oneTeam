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
 * Three things narrow it further, and all three are cheap:
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
 *
 * The token that comes back identifies exactly one user. Unlike the service
 * credential it cannot be used to act as anybody else, so its blast radius is
 * one installation.
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
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
 * loop. Correct sign-ins are unlimited; wrong ones are what run out.
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

/** Exposed so a test can start from a clean window. */
export function resetEnrollmentThrottle(): void {
  failures.clear();
}

@Controller('api/portal/field')
export class EnrollmentController {
  private readonly logger = new Logger(EnrollmentController.name);

  constructor(private readonly fieldService: FieldService) {}

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

    // Binding is the same call the chat channel makes: it creates or updates the
    // user for this external key and claims the store's open work. Reusing it
    // rather than writing a second path is what keeps the two channels from
    // drifting on who may claim what.
    const bound = this.fieldService.bind({ deviceId }, fullName, store.id);
    const userId = bound.data.id as string;

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
