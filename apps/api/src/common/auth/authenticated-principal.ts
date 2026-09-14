import { UserRole } from '@oneteam/types';

/**
 * How the caller proved who they are.
 *
 * This is not decoration. The two kinds of bearer carry different authority:
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
 */
export type PrincipalSource = 'service' | 'device';

export interface AuthenticatedPrincipal {
  userId: string;
  role: UserRole;
  telegramChatId?: string | null;
  /** Defaults to `service` when absent, matching the credential that predates it. */
  via?: PrincipalSource;
  /** The installation this principal was issued to. Only set when `via` is `device`. */
  deviceId?: string;
}

export const ADMIN_ROLES = new Set<UserRole>([
  UserRole.ADMIN,
  UserRole.SUPERVISOR,
]);

export function isPrivilegedPrincipal(principal: AuthenticatedPrincipal): boolean {
  return ADMIN_ROLES.has(principal.role);
}

/** Whether this caller may name another user in an actor key. */
export function mayActAsAnotherUser(principal: AuthenticatedPrincipal): boolean {
  return (principal.via ?? 'service') === 'service';
}
