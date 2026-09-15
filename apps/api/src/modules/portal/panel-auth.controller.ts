/**
 * oneTeam — Panel authentication
 * ============================================================================
 *
 * The supervisor panel used to have no login at all. nginx attached
 * `oneteam-user:usr-admin-001` to every `/api/portal/` request at the edge,
 * which kept the credential out of the browser bundle but meant the only thing
 * between a stranger and full administrative access was knowing the URL — and
 * every action in `audit_logs` was attributed to the same seeded administrator.
 *
 * This controller is the login. It is mounted at `/api/panel`, deliberately NOT
 * at `/api/portal`, because nginx rewrites the portal prefix and leaves this one
 * alone. That is what lets the panel present a key of its own: see the map at
 * the top of nginx.conf, where a caller-supplied `Authorization` now wins over
 * the injected one.
 *
 * WHY THERE IS NO "LOGIN" ENDPOINT
 * --------------------------------
 * Signing in is: store the key in the browser, then call `GET /api/panel/me`
 * with it. If that answers, the key is good and the answer already contains the
 * name to show in the header. A separate `POST /login` would accept the same
 * credential at a second door and add a second place where "is this key valid"
 * is decided — for no capability the panel needs.
 *
 * WHETHER TO ASK AT ALL IS THE SERVER'S DECISION
 * ---------------------------------------------
 * `GET /api/panel/auth-status` is public, and it is what stops this change from
 * locking anybody out. Until a key exists — or the operator sets
 * `ONETEAM_PANEL_BOOTSTRAP_KEY` — it answers `required: false`, the panel skips
 * the login screen, and nothing about the deployment changes. Turning the login
 * on is then a deliberate act rather than a side effect of deploying.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Request,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { UserRole } from '@oneteam/types';
import { db, hashPanelToken } from '@oneteam/database';
import { AuthGuard, getPrincipal } from '../../common/auth/auth.guard';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';

type AuthedRequest = ExpressRequest & {
  principal?: AuthenticatedPrincipal;
  /** Set by AuthGuard when the bearer was a minted panel key. */
  panelToken?: string;
};

/** How much of a hash is enough to identify a key without printing the whole thing. */
const HASH_PREFIX_LENGTH = 8;

@Controller('api/panel')
export class PanelAuthController {
  private readonly logger = new Logger(PanelAuthController.name);

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  /**
   * Whether the panel should show a login screen.
   *
   * Public on purpose: an unauthenticated visitor is exactly who needs the
   * answer. It discloses nothing an attacker could use — that a login exists,
   * and whether the deployment is still open — and both of those are already
   * true of the deployment they are looking at.
   */
  @Get('auth-status')
  async authStatus() {
    const status = await db.panelAuthStatus();
    return {
      success: true,
      data: {
        ...status,
        // The sentence is built here rather than in the browser so the panel and
        // the health endpoint describe the same situation the same way.
        detail: describePanelAuth(status),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Signed in
  // -------------------------------------------------------------------------

  /** Who the caller is. The panel's "am I signed in" probe. */
  @Get('me')
  @UseGuards(AuthGuard)
  me(@Request() request: AuthedRequest) {
    const principal = getPrincipal(request);
    const user = db.getUser(principal.userId);

    return {
      success: true,
      data: {
        userId: principal.userId,
        fullName: user?.fullName ?? null,
        email: user?.email ?? null,
        role: principal.role,
        via: principal.via ?? 'service',
        canManageKeys: principal.role === UserRole.ADMIN,
        // A bootstrap session has no row behind it: the guard only records
        // `panelToken` when the bearer was a minted key. The panel uses this to
        // tell the operator, once, that they should mint a personal key.
        usingBootstrapKey: principal.via === 'panel' && !request.panelToken,
      },
    };
  }

  /**
   * Signs out.
   *
   * Revokes the key that was presented, rather than the user's keys in general:
   * signing out of one browser must not sign the same person out of another.
   *
   * A bootstrap session has no row to revoke — clearing the browser's copy is
   * the whole of it — so this answers honestly with `revoked: false` instead of
   * pretending something was changed.
   */
  @Post('logout')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Request() request: AuthedRequest) {
    const token = request.panelToken;
    if (!token) {
      return { success: true, data: { revoked: false, bootstrap: true } };
    }

    const revoked = await db.revokePanelToken(token);

    // Recorded here as well as in the admin revoke route, because a revocation
    // is a security event whichever door performed it. Signing out is the
    // ordinary case, and "the key stopped working at 18:04" is exactly the fact
    // an investigation needs — leaving it out would make the ledger answer only
    // for the revocations an administrator did by hand.
    if (revoked) {
      db.logAuditEvent({
        entityType: 'panel_token',
        entityId: hashPanelToken(token).slice(0, HASH_PREFIX_LENGTH),
        action: 'PANEL_KEY_REVOKED',
        actorId: request.principal?.userId,
        payload: { reason: 'signed out' },
      });
    }

    return { success: true, data: { revoked, bootstrap: false } };
  }

  // -------------------------------------------------------------------------
  // Key management — administrators only
  // -------------------------------------------------------------------------

  /**
   * The keys that exist, and who they belong to.
   *
   * Returns the hash prefix, never a key: the panel cannot recover anyone's key
   * because it was only ever shown once, at the moment it was minted. What it
   * can do is identify a row in order to revoke it.
   */
  @Get('keys')
  @UseGuards(AuthGuard)
  async listKeys(@Request() request: AuthedRequest) {
    const principal = requireAdmin(request);
    const rows = await db.listPanelTokens(true);
    const currentHash = request.panelToken ? hashPanelToken(request.panelToken) : null;

    return {
      success: true,
      data: {
        keys: rows.map((row) => ({
          hashPrefix: row.tokenHash.slice(0, HASH_PREFIX_LENGTH),
          userId: row.userId,
          userName: db.getUser(row.userId)?.fullName ?? null,
          label: row.label,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          live: !row.revokedAt,
          // Marks the row the caller is currently signed in with, so nobody
          // revokes their own session by mistake while looking for an old one.
          current: currentHash !== null && row.tokenHash === currentHash,
        })),
        // The people a key can be issued to. Without this the admin would have
        // to know a user id by heart.
        users: db.users.map((user) => ({
          id: user.id,
          fullName: user.fullName,
          email: user.email ?? null,
          role: user.role,
          liveKeys: rows.filter((row) => row.userId === user.id && !row.revokedAt).length,
        })),
      },
    };
  }

  /**
   * Mints a key for one person.
   *
   * The key is in the response and nowhere else — not in the log, not in the
   * audit payload. Only its prefix is recorded, which is enough to correlate a
   * key with an incident and not enough to use it.
   */
  @Post('keys')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async mintKey(
    @Body() body: { userId?: string; label?: string },
    @Request() request: AuthedRequest,
  ) {
    const principal = requireAdmin(request);

    const userId = String(body?.userId ?? '').trim();
    if (!userId) {
      throw new BadRequestException({
        error: 'USER_REQUIRED',
        message: 'Açarın veriləcəyi istifadəçini seçin.',
      });
    }

    const label =
      String(body?.label ?? '')
        .trim()
        .slice(0, 80) || undefined;

    const issued = await db.issuePanelToken({
      userId,
      label,
      createdBy: principal.userId,
    });

    if (!issued) {
      // Refusing is the only honest answer. A key that was not stored would stop
      // working at the next restart, and handing someone a credential that
      // silently expires is worse than making the operator try again.
      throw new ServiceUnavailableException({
        error: 'KEY_NOT_STORED',
        message:
          'Açar yaradıla bilmədi: verilənlər bazasına yazıla bilmədi. ' +
          'Yaddaşda saxlanılan açar yenidən başlatmadan sonra işləməz.',
      });
    }

    db.logAuditEvent({
      entityType: 'panel_token',
      entityId: issued.tokenHash.slice(0, HASH_PREFIX_LENGTH),
      action: 'PANEL_KEY_ISSUED',
      actorId: principal.userId,
      payload: {
        forUser: userId,
        label: label ?? null,
        hashPrefix: issued.tokenHash.slice(0, HASH_PREFIX_LENGTH),
      },
    });

    return {
      success: true,
      data: {
        token: issued.token,
        // The prefix of the HASH, not of the key. It is the identifier the key
        // list shows and the audit log records, so one string means the same row
        // in all three places. A prefix of the key itself would look similar and
        // match nothing.
        hashPrefix: issued.tokenHash.slice(0, HASH_PREFIX_LENGTH),
        userId,
        label: label ?? null,
      },
    };
  }

  /** Cuts off one key. Identified by the hash prefix the list returned. */
  @Post('keys/:prefix/revoke')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async revokeKey(@Param('prefix') prefix: string, @Request() request: AuthedRequest) {
    const principal = requireAdmin(request);
    const wanted = String(prefix ?? '')
      .trim()
      .toLowerCase();

    if (wanted.length < HASH_PREFIX_LENGTH) {
      throw new BadRequestException({
        error: 'PREFIX_TOO_SHORT',
        message: `Açarı tanımaq üçün ən azı ${HASH_PREFIX_LENGTH} simvol lazımdır.`,
      });
    }

    const rows = await db.listPanelTokens(true);
    const matches = rows.filter((row) => !row.revokedAt && row.tokenHash.startsWith(wanted));

    // Ambiguity is refused rather than resolved. Revoking the wrong person's
    // access is not a mistake to make silently, and a prefix collision is the
    // one way this route could do it.
    if (matches.length === 0) {
      throw new NotFoundException({
        error: 'KEY_NOT_FOUND',
        message: 'Bu açar tapılmadı — ola bilsin artıq ləğv edilib.',
      });
    }
    if (matches.length > 1) {
      throw new BadRequestException({
        error: 'PREFIX_AMBIGUOUS',
        message: 'Bu qısa yazı bir neçə açara uyğun gəlir. Daha uzun yazı istifadə edin.',
      });
    }

    const target = matches[0];
    if (request.panelToken && hashPanelToken(request.panelToken) === target.tokenHash) {
      throw new BadRequestException({
        error: 'CANNOT_REVOKE_OWN_SESSION',
        message:
          'Hazırda istifadə etdiyiniz açarı ləğv edə bilməzsiniz. ' +
          'Bunun üçün "Çıxış" düyməsindən istifadə edin.',
      });
    }

    const revoked = await db.revokePanelTokenByHash(target.tokenHash);

    db.logAuditEvent({
      entityType: 'panel_token',
      entityId: target.tokenHash.slice(0, HASH_PREFIX_LENGTH),
      action: 'PANEL_KEY_REVOKED',
      actorId: principal.userId,
      payload: { forUser: target.userId, label: target.label },
    });

    return { success: true, data: { revoked, userId: target.userId } };
  }

  /**
   * Cuts off every key belonging to one person.
   *
   * This is what "they left the company" means, and it is why revocation is a
   * timestamp on a row rather than a delete: the record of what they had access
   * to survives the act of removing it.
   */
  @Post('users/:userId/revoke-keys')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async revokeUserKeys(@Param('userId') userId: string, @Request() request: AuthedRequest) {
    const principal = requireAdmin(request);
    const target = String(userId ?? '').trim();

    if (!target) {
      throw new BadRequestException({
        error: 'USER_REQUIRED',
        message: 'İstifadəçi göstərilməyib.',
      });
    }

    // Self-service lockout is refused. An administrator revoking all of their
    // own keys would end their own session and, with no other administrator
    // holding a key, could leave the panel unreachable until the bootstrap key
    // is set again. Signing out is the action they actually wanted.
    if (target === principal.userId) {
      throw new BadRequestException({
        error: 'CANNOT_REVOKE_OWN_KEYS',
        message:
          'Öz açarlarınızı buradan ləğv edə bilməzsiniz. ' +
          'Cari sessiyanı bitirmək üçün "Çıxış" düyməsindən istifadə edin.',
      });
    }

    const count = await db.revokePanelTokensForUser(target);

    if (count > 0) {
      db.logAuditEvent({
        entityType: 'panel_user',
        entityId: target,
        action: 'PANEL_KEYS_REVOKED_FOR_USER',
        actorId: principal.userId,
        payload: { count },
      });
    }

    return { success: true, data: { revoked: count, userId: target } };
  }

  // -------------------------------------------------------------------------
  // People — administrators only
  // -------------------------------------------------------------------------
  //
  // WHY THIS IS HERE AND NOT UNDER /api/portal
  // ------------------------------------------
  // A store and a briefing are business data, and their writes live under
  // `/api/portal` for that reason. A person is not business data: they are who
  // the deployment lets in. Creating one, changing what they may do and
  // removing them are all access decisions, which is the same category as
  // minting a key — so they belong next to the key routes, behind the same
  // `requireAdmin`, rather than beside the store form.
  //
  // WHAT WAS MISSING BEFORE THIS
  // ---------------------------
  // `GET /api/panel/keys` already returned a `users` array, so the panel could
  // show who a key might be issued to — but nothing could create a person. The
  // three in `db/api-seed.sql` were the entire staff, and that seed is not
  // applied by the migration runner. So "hər adama öz açarı" (a key per person)
  // worked only for the three people who already existed, and the operator had
  // no way to add the fourth.
  //
  // Merchandisers are a partial exception: the bot and the mobile client bind a
  // user on first contact (`bindTelegramUser` / `bindDeviceUser`), so a field
  // worker who enrols with a store code already exists by the time the panel
  // sees them. They arrive as `MERCHANDISER` and cannot be created here as
  // anything else by accident — what this adds for them is the ability to
  // *promote* one, and to remove somebody who left.
  // -------------------------------------------------------------------------

  /**
   * Everybody, with what the panel needs to decide about them.
   *
   * `submissions` and `deletable` are computed here rather than left to the
   * browser. The panel could work out that a person with submissions cannot be
   * deleted, but it would have to know about `ON DELETE RESTRICT` to do it, and
   * a rule that lives in the UI is a rule the next client gets wrong. The
   * server says what is possible; the panel only has to render it.
   */
  @Get('users')
  @UseGuards(AuthGuard)
  async listUsers(@Request() request: AuthedRequest) {
    const principal = requireAdmin(request);

    const [submissions, keys] = await Promise.all([
      db.submissionCountsByUser(),
      db.listPanelTokens(true),
    ]);

    const liveKeyCount = new Map<string, number>();
    for (const row of keys) {
      if (row.revokedAt) continue;
      liveKeyCount.set(row.userId, (liveKeyCount.get(row.userId) ?? 0) + 1);
    }

    const adminCount = db.users.filter((user: any) => user.role === UserRole.ADMIN).length;
    const roles = Object.values(UserRole);

    return {
      success: true,
      data: {
        users: db.users.map((user: any) => {
          const made = submissions.get(user.id);
          const isSelf = user.id === principal.userId;
          const isLastAdmin = user.role === UserRole.ADMIN && adminCount <= 1;

          // Why this person cannot be removed, in the order the operator would
          // hit the reasons. `null` means the delete is expected to work.
          let blockedBy: string | null = null;
          if (isSelf) blockedBy = 'SELF';
          else if (isLastAdmin) blockedBy = 'LAST_ADMIN';
          else if (made === undefined) blockedBy = 'UNKNOWN';
          else if (made > 0) blockedBy = 'HAS_SUBMISSIONS';

          return {
            id: user.id,
            fullName: user.fullName,
            // A synthesised address is reported as absent rather than shown.
            // The row carries `<id>@oneteam.local` only because the column is
            // `NOT NULL`; displaying it would invite somebody to send mail to
            // an address that cannot receive any.
            email: user.email?.endsWith('@oneteam.local') ? null : (user.email ?? null),
            role: user.role,
            phone: user.phone ?? null,
            // How they joined. `null` means the panel created them or the seed
            // did; the other two are the channels that bind a user on first
            // contact and therefore have their own identifier for them.
            joinedVia: user.telegramChatId ? 'telegram' : user.mobileDeviceId ? 'mobile' : null,
            liveKeys: liveKeyCount.get(user.id) ?? 0,
            submissions: made ?? null,
            isSelf,
            deletable: blockedBy === null,
            blockedBy,
          };
        }),
        roles,
        adminCount,
      },
    };
  }

  /**
   * Adds a person.
   *
   * The id is minted by the database layer, not accepted from the browser: an
   * id is what everything else references, and letting a client choose one
   * invites a collision with a row it has not seen.
   */
  @Post('users')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createUser(
    @Body() body: { fullName?: string; email?: string; role?: string; phone?: string },
    @Request() request: AuthedRequest,
  ) {
    const principal = requireAdmin(request);

    const fullName = String(body?.fullName ?? '').trim();
    if (!fullName) {
      throw new BadRequestException({
        error: 'FULL_NAME_REQUIRED',
        message: 'Ad və soyad tələb olunur.',
      });
    }

    const role = requireRole(body?.role);
    const email = String(body?.email ?? '').trim() || undefined;
    const phone = String(body?.phone ?? '').trim() || undefined;

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException({
        error: 'INVALID_EMAIL',
        message: 'E-poçt ünvanı düzgün formatda deyil.',
      });
    }

    const created = await db.createUser({ fullName, email, role, phone });

    if (created.error === 'DUPLICATE_EMAIL') {
      throw new ConflictException({
        error: 'EMAIL_TAKEN',
        message: `Bu e-poçt artıq başqa istifadəçidədir: ${email}`,
      });
    }
    if (created.error === 'NOT_STORED') {
      throw new ServiceUnavailableException({
        error: 'USER_NOT_STORED',
        message:
          'İstifadəçi yaradıla bilmədi: verilənlər bazasına yazıla bilmədi. ' +
          'Yenidən cəhd edin — heç bir dəyişiklik qeydə alınmadı.',
      });
    }

    db.logAuditEvent({
      entityType: 'panel_user',
      entityId: created.user.id,
      action: 'PANEL_USER_CREATED',
      actorId: principal.userId,
      payload: { fullName, role, email: email ?? null },
    });

    return {
      success: true,
      data: {
        id: created.user.id,
        fullName: created.user.fullName,
        email: email ?? null,
        role: created.user.role,
      },
    };
  }

  /**
   * Changes a person's name, role or phone.
   *
   * REFUSES TO CHANGE THE CALLER'S OWN ROLE. Not because it is unsafe in the
   * database — `updateUser` already refuses to demote the last administrator —
   * but because of what it does to the session that is doing the changing: an
   * admin who demotes themselves keeps a valid key and loses every screen that
   * key was for, with no way back except another administrator. The same
   * reasoning as `CANNOT_REVOKE_OWN_KEYS`, and the same answer: have somebody
   * else do it.
   */
  @Patch('users/:userId')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateUser(
    @Param('userId') userId: string,
    @Body() body: { fullName?: string; role?: string; phone?: string },
    @Request() request: AuthedRequest,
  ) {
    const principal = requireAdmin(request);
    const target = String(userId ?? '').trim();

    if (!db.getUser(target)) {
      throw new NotFoundException({
        error: 'USER_NOT_FOUND',
        message: `İstifadəçi tapılmadı: ${target}`,
      });
    }

    const changes: { fullName?: string; role?: string; phone?: string } = {};

    if (body?.fullName !== undefined) {
      const fullName = String(body.fullName).trim();
      if (!fullName) {
        throw new BadRequestException({
          error: 'FULL_NAME_REQUIRED',
          message: 'Ad və soyad boş ola bilməz.',
        });
      }
      changes.fullName = fullName;
    }

    if (body?.role !== undefined) {
      const role = requireRole(body.role);
      if (target === principal.userId && role !== principal.role) {
        throw new BadRequestException({
          error: 'CANNOT_CHANGE_OWN_ROLE',
          message:
            'Öz rolunuzu özünüz dəyişə bilməzsiniz — bunu başqa administrator etməlidir. ' +
            'Səbəb: rolu dəyişən kimi bu ekranlara girişinizi itirirsiniz.',
        });
      }
      changes.role = role;
    }

    if (body?.phone !== undefined) {
      changes.phone = String(body.phone).trim();
    }

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        error: 'NOTHING_TO_CHANGE',
        message: 'Dəyişdiriləcək sahə göstərilməyib.',
      });
    }

    const previousRole = db.getUser(target)!.role;
    const result = await db.updateUser(target, changes);

    if (result.error === 'NOT_FOUND') {
      throw new NotFoundException({
        error: 'USER_NOT_FOUND',
        message: `İstifadəçi tapılmadı: ${target}`,
      });
    }
    if (result.error === 'LAST_ADMIN') {
      throw new ConflictException({
        error: 'LAST_ADMIN',
        message:
          'Bu, sistemdəki son administrator­dur. Rolunu dəyişsəniz paneli idarə edən ' +
          'heç kim qalmayacaq — əvvəlcə başqa bir administrator təyin edin.',
      });
    }
    if (result.error === 'NOT_STORED') {
      throw new ServiceUnavailableException({
        error: 'USER_NOT_STORED',
        message: 'Dəyişiklik yazıla bilmədi. Heç nə dəyişmədi — yenidən cəhd edin.',
      });
    }

    db.logAuditEvent({
      entityType: 'panel_user',
      entityId: target,
      action: changes.role ? 'PANEL_USER_ROLE_CHANGED' : 'PANEL_USER_UPDATED',
      actorId: principal.userId,
      payload: {
        from: { role: previousRole },
        to: changes,
      },
    });

    return {
      success: true,
      data: {
        id: result.user.id,
        fullName: result.user.fullName,
        role: result.user.role,
        phone: result.user.phone ?? null,
      },
    };
  }

  /**
   * Removes a person.
   *
   * Both refusals come back as 409 with the reason and the count, because each
   * one has a different next step: somebody with submissions should have their
   * keys revoked instead, and the last administrator needs a replacement
   * appointed first. A bare "conflict" would leave the operator guessing.
   */
  @Delete('users/:userId')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async deleteUser(@Param('userId') userId: string, @Request() request: AuthedRequest) {
    const principal = requireAdmin(request);
    const target = String(userId ?? '').trim();

    if (!db.getUser(target)) {
      throw new NotFoundException({
        error: 'USER_NOT_FOUND',
        message: `İstifadəçi tapılmadı: ${target}`,
      });
    }

    if (target === principal.userId) {
      throw new BadRequestException({
        error: 'CANNOT_DELETE_SELF',
        message: 'Öz hesabınızı silə bilməzsiniz. Bunu başqa administrator etməlidir.',
      });
    }

    const result = await db.deleteUser(target);

    if (result.reason === 'HAS_SUBMISSIONS') {
      throw new ConflictException({
        error: 'USER_HAS_SUBMISSIONS',
        message:
          `Bu istifadəçinin ${result.submissions} audit təqdimatı var və onlar audit ` +
          'izini təşkil edir. Hesabı silmək əvəzinə açarlarını ləğv edin — ' +
          'belədə işi qeyd olaraq qalır, girişi isə kəsilir.',
        submissions: result.submissions,
      });
    }
    if (result.reason === 'LAST_ADMIN') {
      throw new ConflictException({
        error: 'LAST_ADMIN',
        message:
          'Bu, sistemdəki son administrator­dur və silinə bilməz — əvvəlcə başqa bir ' +
          'administrator təyin edin.',
      });
    }
    if (!result.deleted) {
      throw new ServiceUnavailableException({
        error: 'USER_NOT_DELETED',
        message: 'İstifadəçi silinə bilmədi. Heç nə dəyişmədi — yenidən cəhd edin.',
      });
    }

    db.logAuditEvent({
      entityType: 'panel_user',
      entityId: target,
      action: 'PANEL_USER_DELETED',
      actorId: principal.userId,
      // Named because the row is gone: without the name the audit entry says
      // only that some id was removed, and the id is not a person to a reader.
      payload: { fullName: result.user?.fullName ?? null, role: result.user?.role ?? null },
    });

    return { success: true, data: { deleted: true, userId: target } };
  }
}

/** The four roles a person may hold, refused with the list when it is not one. */
function requireRole(raw: unknown): string {
  const role = String(raw ?? '').trim();
  const allowed = Object.values(UserRole) as string[];
  if (!allowed.includes(role)) {
    throw new BadRequestException({
      error: 'INVALID_ROLE',
      message: `Rol yanlışdır. Qəbul edilən rollar: ${allowed.join(', ')}`,
    });
  }
  return role;
}

/**
 * Refuses anything below administrator.
 *
 * `SUPERVISOR` is enough to review audits and is deliberately not enough to
 * mint credentials. Issuing a login key is the power to grant access, and it
 * should not travel with the power to approve a shelf photo.
 */
function requireAdmin(request: AuthedRequest): AuthenticatedPrincipal {
  const principal = getPrincipal(request);
  if (principal.role !== UserRole.ADMIN) {
    throw new ForbiddenException({
      error: 'ADMIN_REQUIRED',
      message: 'Bu əməliyyat üçün administrator səlahiyyəti lazımdır.',
    });
  }
  return principal;
}

/** One sentence a person can act on, built from the three status fields. */
function describePanelAuth(status: {
  required: boolean;
  liveKeys: number;
  bootstrapConfigured: boolean;
  bootstrapProblem: string | null;
}): string {
  if (status.bootstrapProblem) {
    return 'Panel girişi qurulub, amma bootstrap açarı qəbul edilmir: ' + status.bootstrapProblem;
  }
  if (!status.required) {
    return (
      'Panel hələ açıqdır: heç bir giriş açarı yaradılmayıb. ' +
      'İlk açar yaradılan kimi giriş ekranı avtomatik qoşulacaq.'
    );
  }
  if (status.liveKeys < 0) {
    return 'Giriş açarlarının sayı oxuna bilmədi — ehtiyatlı olaraq giriş tələb olunur.';
  }
  if (status.liveKeys === 0 && status.bootstrapConfigured) {
    return (
      'Giriş tələb olunur. Hələ şəxsi açar yoxdur — bootstrap açarı ilə daxil olub ' +
      'ilk şəxsi açarı yaradın.'
    );
  }
  return `Giriş tələb olunur. Aktiv açar sayı: ${status.liveKeys}.`;
}
