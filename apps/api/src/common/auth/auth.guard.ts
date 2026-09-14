import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UserRole } from '@oneteam/types';
import { AuthenticatedPrincipal, PrincipalSource } from './authenticated-principal';
import { db, isDeviceToken } from '@oneteam/database';

export const PRINCIPAL_REQUEST_KEY = 'principal';

/**
 * Who is calling, and on whose behalf.
 *
 * TWO KINDS OF BEARER, AND THE DIFFERENCE MATTERS
 * ----------------------------------------------
 * `oneteam-user:<userId>` — the service credential. It names the user the caller
 * is acting as, and it can name *any* user. It is a server credential: the
 * Telegram bot holds one, and the bot is entitled to act as whoever a chat
 * belongs to because it derived that chat from the update it is handling. It must
 * never be given to a client that a member of the public can obtain.
 *
 * `otd_<random>` — a device credential. It resolves to exactly one user and
 * cannot name anyone else, so the worst a leaked one gives away is that device's
 * own access. This is what the mobile app holds; see the `device_tokens`
 * migration for why it exists.
 *
 * The distinction is enforced by shape: a token with the device prefix is only
 * ever looked up in `device_tokens`, and never interpreted as a user id.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & { principal?: AuthenticatedPrincipal }
    >();

    const principal = await this.resolvePrincipal(request);
    if (!principal) {
      throw new UnauthorizedException('Authentication required');
    }

    request.principal = principal;
    return true;
  }

  private async resolvePrincipal(request: Request): Promise<AuthenticatedPrincipal | null> {
    const authorization = request.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      return this.resolveBearer(authorization.slice('Bearer '.length).trim());
    }

    if (process.env.NODE_ENV !== 'production' && process.env.ONETEAM_TEST_AUTH === 'true') {
      const testUserId = request.header('x-test-user-id');
      return testUserId ? this.fromUserId(testUserId, 'service') : null;
    }

    return null;
  }

  private async resolveBearer(token: string): Promise<AuthenticatedPrincipal | null> {
    // Bounded before anything else happens, so a megabyte of "token" cannot
    // reach a hash function or a query.
    if (!token || token.length > 512) return null;

    if (isDeviceToken(token)) {
      return this.fromDeviceToken(token);
    }

    const userId = token.startsWith('oneteam-user:')
      ? token.slice('oneteam-user:'.length)
      : null;
    return userId ? this.fromUserId(userId, 'service') : null;
  }

  /**
   * Resolves a device credential.
   *
   * A failure here is logged without the token. The value is a credential, and
   * a log line is a place credentials leak from — the hash prefix is enough to
   * correlate an incident without being enough to reuse.
   */
  private async fromDeviceToken(token: string): Promise<AuthenticatedPrincipal | null> {
    try {
      const device = await db.verifyDeviceToken(token);
      if (!device) {
        this.logger.warn('⛔ Device token rejected: unknown, revoked, or its user was deleted.');
        return null;
      }

      // `via: 'device'` is not decoration — it is the single field that stops
      // this credential from acting as anyone else. An earlier version of this
      // method returned the plain user principal, which defaults to
      // `via: 'service'`, and `enforceActorScope` then waved through a device
      // token naming a foreign device. The parameter is required rather than
      // defaulted so that cannot be reintroduced by omission.
      const principal = this.fromUserId(device.userId, 'device', device.deviceId);
      if (!principal) {
        this.logger.warn(
          `⛔ Device token is valid but its user (${device.userId}) no longer exists.`
        );
        return null;
      }
      return principal;
    } catch (error) {
      // A database that is unreachable must not authenticate anyone. Failing
      // closed here is the only safe direction: the alternative is treating
      // "could not check" as "checked and fine".
      this.logger.error(
        '⛔ Device token could not be verified: ' +
          (error instanceof Error ? error.message : String(error))
      );
      return null;
    }
  }

  /**
   * Builds a principal from a user id.
   *
   * `via` is a required argument on purpose. It used to be defaulted to
   * `'service'` here, which meant any caller that forgot to tag the result
   * silently minted a service-strength principal — the widest authority in the
   * system. Making it required turns that mistake into a compile error.
   */
  private fromUserId(
    userId: string,
    via: PrincipalSource,
    deviceId?: string
  ): AuthenticatedPrincipal | null {
    const user = db.getUser(userId);
    if (!user || !Object.values(UserRole).includes(user.role as UserRole)) return null;
    return {
      userId: user.id,
      role: user.role as UserRole,
      telegramChatId: user.telegramChatId ?? null,
      via,
      ...(deviceId ? { deviceId } : {}),
    };
  }
}

export function getPrincipal(request: Request & { principal?: AuthenticatedPrincipal }): AuthenticatedPrincipal {
  if (!request.principal) throw new UnauthorizedException('Authentication required');
  return request.principal;
}
