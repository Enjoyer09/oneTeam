import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UserRole } from '@oneteam/types';
import { AuthenticatedPrincipal, PrincipalSource } from './authenticated-principal';
import { db, isDeviceToken, isPanelToken, matchesPanelBootstrapKey } from '@oneteam/database';

export const PRINCIPAL_REQUEST_KEY = 'principal';

/**
 * Where the guard leaves the panel key it accepted.
 *
 * The logout route has to revoke *this* key, and by the time it runs the only
 * copy is the header the guard has already read. Re-reading the header there
 * would work and would also mean two places parsing a credential, which is one
 * place too many. The guard parses it once and hands the result over.
 */
export const PANEL_TOKEN_REQUEST_KEY = 'panelToken';

/**
 * Who is calling, and on whose behalf.
 *
 * THREE KINDS OF BEARER, AND THE DIFFERENCE MATTERS
 * ------------------------------------------------
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
 * `otp_<random>` — a panel key. It also resolves to exactly one user, and it is
 * what the supervisor panel sends once a key has been issued. Before any key
 * exists the panel sends nothing and the edge supplies the service credential,
 * which is the behaviour this is replacing — see `panelAuthStatus`, which is
 * what tells the panel to ask for a key.
 *
 * The distinction is enforced by shape: a token is routed by its prefix and only
 * ever looked up in the table that prefix belongs to. A `otd_` value is never
 * interpreted as a user id, and never as a panel key.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: AuthenticatedPrincipal; panelToken?: string }>();

    const principal = await this.resolvePrincipal(request);
    if (!principal) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!(await this.mayUseRoute(request, principal))) {
      // 403 rather than 401: the credential is understood, it is simply not
      // enough for this route. The panel distinguishes the two — a 401 means
      // "your key is wrong, sign in again", this means "sign in".
      throw new ForbiddenException({
        error: 'PANEL_KEY_REQUIRED',
        message: 'Bu bölmə üçün panel giriş açarı lazımdır. Zəhmət olmasa daxil olun.',
      });
    }

    request.principal = principal;
    return true;
  }

  /**
   * Whether this credential may be used on this route.
   *
   * WHY A ROUTE-LEVEL RULE EXISTS AT ALL
   * ------------------------------------
   * The supervisor panel has no credential of its own until a key is issued, so
   * the edge injects one (see nginx.conf). That is what makes the panel work out
   * of the box — and it is also what would make the login screen decorative:
   * anyone who reached the panel URL without a key would still be handed the
   * injected administrator by the edge, and the screen would only be hiding the
   * data from the browser, not protecting it.
   *
   * So the injected credential is honoured on the supervisor routes only while
   * the panel is unconfigured. The moment a key exists — or the operator sets a
   * bootstrap key — those routes stop accepting it, and the login screen becomes
   * the only way in. Nothing needs to be redeployed or reconfigured for that to
   * happen: `panelAuthStatus` reads the database.
   *
   * The field API is untouched. The bot and the mobile app reach it with a
   * service or device credential and must keep working exactly as before.
   */
  private async mayUseRoute(request: Request, principal: AuthenticatedPrincipal): Promise<boolean> {
    if (!isSupervisorRoute(request.path)) return true;

    // A panel key is the intended credential for these routes.
    if (principal.via === 'panel') return true;

    // A device credential belongs to one merchandiser's installation. These
    // routes list every store and every submission, and approving an audit is
    // not a field action, so there is nothing here a device should reach. The
    // field API is where a device's work lives, and it has its own scope check.
    if (principal.via === 'device') {
      this.logger.warn(
        `⛔ Refused a device credential on ${request.path}: that is a supervisor route.`,
      );
      return false;
    }

    // A service credential — which on these routes means the one the edge
    // injected — is allowed only while there is nothing to sign in with.
    const status = await db.panelAuthStatus();
    if (!status.required) return true;

    this.logger.warn(
      `⛔ Refused the edge credential on ${request.path}: the panel now requires a key ` +
        `(${status.liveKeys} live).`,
    );
    return false;
  }

  private async resolvePrincipal(
    request: Request & { panelToken?: string },
  ): Promise<AuthenticatedPrincipal | null> {
    const authorization = request.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      return this.resolveBearer(authorization.slice('Bearer '.length).trim(), request);
    }

    if (process.env.NODE_ENV !== 'production' && process.env.ONETEAM_TEST_AUTH === 'true') {
      const testUserId = request.header('x-test-user-id');
      return testUserId ? this.fromUserId(testUserId, 'service') : null;
    }

    return null;
  }

  private async resolveBearer(
    token: string,
    request: Request & { panelToken?: string },
  ): Promise<AuthenticatedPrincipal | null> {
    // Bounded before anything else happens, so a megabyte of "token" cannot
    // reach a hash function or a query.
    if (!token || token.length > 512) return null;

    if (isDeviceToken(token)) {
      return this.fromDeviceToken(token);
    }

    if (isPanelToken(token)) {
      return this.fromPanelToken(token, request);
    }

    // The bootstrap key is a value the operator typed, not a value this system
    // minted, so it has no prefix to be recognised by — it has to be compared.
    //
    // This check was missing at first, and the failure was quiet in the worst
    // way: `/api/panel/auth-status` reported `bootstrapConfigured: true` while
    // every request carrying the key was answered 401, because the bearer fell
    // through the two shape checks and was read as a malformed user id. The
    // panel looked configured and nobody could get in.
    //
    // It runs before the `oneteam-user:` check, and `matchesPanelBootstrapKey`
    // returns immediately when no key is configured, so the ordinary path pays
    // nothing for it.
    if (matchesPanelBootstrapKey(token)) {
      return this.fromPanelToken(token, request);
    }

    const userId = token.startsWith('oneteam-user:') ? token.slice('oneteam-user:'.length) : null;
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
          `⛔ Device token is valid but its user (${device.userId}) no longer exists.`,
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
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  /**
   * Resolves a panel login key.
   *
   * Two things can arrive under this prefix, and they are checked in order of
   * specificity: a minted personal key first, then the bootstrap key.
   *
   * The bootstrap key is the way in before any personal key exists. It resolves
   * to a fixed administrator rather than to a person, because there is no person
   * attached to it — which is exactly why it is meant to be used once, to mint
   * real keys, and then removed from the environment. It is checked against a
   * configured value with a constant-time comparison, and its absence is the
   * normal state of a deployment that has finished setting up.
   */
  private async fromPanelToken(
    token: string,
    request: Request & { panelToken?: string },
  ): Promise<AuthenticatedPrincipal | null> {
    try {
      const found = await db.verifyPanelToken(token);
      if (found) {
        request.panelToken = token;
        const principal = this.fromUserId(found.userId, 'panel');
        if (!principal) {
          this.logger.warn(
            `⛔ Panel key is valid but its user (${found.userId}) no longer exists.`,
          );
          return null;
        }
        return principal;
      }

      if (matchesPanelBootstrapKey(token)) {
        const bootstrapUserId =
          (process.env.ONETEAM_PANEL_BOOTSTRAP_USER || '').trim() || 'usr-admin-001';
        const principal = this.fromUserId(bootstrapUserId, 'panel');
        if (!principal) {
          this.logger.error(
            `⛔ The panel bootstrap key is set but ONETEAM_PANEL_BOOTSTRAP_USER ` +
              `(${bootstrapUserId}) is not a real user, so nobody can sign in.`,
          );
          return null;
        }
        this.logger.log('🔑 Panel bootstrap key accepted; sign in and mint a personal key.');
        return principal;
      }

      this.logger.warn('⛔ Panel key rejected: unknown, revoked, or its user was deleted.');
      return null;
    } catch (error) {
      // Same reasoning as the device path: a database that is unreachable must
      // not authenticate anyone. "Could not check" must never mean "checked and
      // fine", and a panel key is the credential that can approve audits.
      this.logger.error(
        '⛔ Panel key could not be verified: ' +
          (error instanceof Error ? error.message : String(error)),
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
    deviceId?: string,
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

export function getPrincipal(
  request: Request & { principal?: AuthenticatedPrincipal },
): AuthenticatedPrincipal {
  if (!request.principal) throw new UnauthorizedException('Authentication required');
  return request.principal;
}

/** The supervisor API — everything the panel reads and writes, and nothing else. */
const SUPERVISOR_ROUTE_PREFIX = '/api/portal/';

/**
 * The field API, which sits under the same `/api/portal/` prefix but belongs to
 * the bot and the mobile app.
 *
 * Kept as an explicit carve-out rather than by matching the supervisor routes by
 * name, because the direction of the mistake matters: a new field route added
 * later is correctly treated as field, and a new supervisor route is correctly
 * treated as supervisor. Listing the supervisor routes would fail the other way
 * the first time someone added one and forgot to update the list.
 */
const FIELD_ROUTE_PREFIX = '/api/portal/field';

/**
 * Whether a request path belongs to the supervisor panel.
 *
 * Exported because the test suite asserts the boundary directly, and a boundary
 * that is only expressed inside a private method is one nobody can test.
 */
export function isSupervisorRoute(path: string | undefined): boolean {
  if (!path) return false;
  if (!path.startsWith(SUPERVISOR_ROUTE_PREFIX)) return false;
  return !path.startsWith(FIELD_ROUTE_PREFIX);
}
