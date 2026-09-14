import { UserRole } from '@oneteam/types';

/**
 * How the caller proved who they are.
 *
 * This is not decoration. The three kinds of bearer carry different authority:
 *
 *   `service` — the shared server credential. It names the user the caller is
 *   acting as, and it may name *any* user. That is what lets the Telegram bot
 *   read and write on behalf of whichever chat an update came from, and it is
 *   safe only because the bot is a server and the credential never reaches a
 *   chat.
 *
 *   `device` — a credential issued to one mobile installation. It resolves to
 *   exactly one user, and it must not be able to name anyone else. Without this
 *   field the field API cannot tell the two apart, and a device token would
 *   inherit the service credential's ability to act as any user — which would
 *   make issuing it pointless.
 *
 *   `panel` — a login key held by one person in a browser. It resolves to
 *   exactly one user and, like a device credential, cannot name anyone else:
 *   a supervisor signing in to review audits has no business addressing the
 *   field API on another person's behalf. The difference from `device` is
 *   purely who holds it — a person, not an installation — and it is recorded
 *   separately so the audit trail can say which door was used.
 */
export type PrincipalSource = 'service' | 'device' | 'panel';

export interface AuthenticatedPrincipal {
  userId: string;
  role: UserRole;
  telegramChatId?: string | null;
  /** Defaults to `service` when absent, matching the credential that predates it. */
  via?: PrincipalSource;
  /** The installation this principal was issued to. Only set when `via` is `device`. */
  deviceId?: string;
}

export const ADMIN_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.SUPERVISOR]);

export function isPrivilegedPrincipal(principal: AuthenticatedPrincipal): boolean {
  return ADMIN_ROLES.has(principal.role);
}

/**
 * Whether this caller may name another user in an actor key.
 *
 * Only the service credential may. `device` and `panel` credentials both
 * resolve to one person and are refused if they try to speak for someone else —
 * which is the whole reason `via` is carried rather than assumed. Note that the
 * comparison is explicit about all three values rather than `!== 'device'`:
 * a future credential type added without thought must fail closed.
 */
export function mayActAsAnotherUser(principal: AuthenticatedPrincipal): boolean {
  return (principal.via ?? 'service') === 'service';
}
