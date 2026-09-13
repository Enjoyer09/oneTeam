import { UserRole } from '@oneteam/types';

export interface AuthenticatedPrincipal {
  userId: string;
  role: UserRole;
  telegramChatId?: string | null;
}

export const ADMIN_ROLES = new Set<UserRole>([
  UserRole.ADMIN,
  UserRole.SUPERVISOR,
]);

export function isPrivilegedPrincipal(principal: AuthenticatedPrincipal): boolean {
  return ADMIN_ROLES.has(principal.role);
}
