import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UserRole } from '@oneteam/types';
import { AuthenticatedPrincipal } from './authenticated-principal';
import { db } from '@oneteam/database';

export const PRINCIPAL_REQUEST_KEY = 'principal';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & {
      principal?: AuthenticatedPrincipal;
    }>();
    const principal = this.resolvePrincipal(request);
    if (!principal) {
      throw new UnauthorizedException('Authentication required');
    }
    request.principal = principal;
    return true;
  }

  private resolvePrincipal(request: Request): AuthenticatedPrincipal | null {
    const authorization = request.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      return this.resolveBearer(authorization.slice('Bearer '.length).trim());
    }

    if (process.env.NODE_ENV !== 'production' && process.env.ONETEAM_TEST_AUTH === 'true') {
      const testUserId = request.header('x-test-user-id');
      return testUserId ? this.fromUserId(testUserId) : null;
    }

    return null;
  }

  private resolveBearer(token: string): AuthenticatedPrincipal | null {
    if (!token || token.length > 512) return null;
    const userId = token.startsWith('oneteam-user:')
      ? token.slice('oneteam-user:'.length)
      : null;
    return userId ? this.fromUserId(userId) : null;
  }

  private fromUserId(userId: string): AuthenticatedPrincipal | null {
    const user = db.getUser(userId);
    if (!user || !Object.values(UserRole).includes(user.role as UserRole)) return null;
    return {
      userId: user.id,
      role: user.role as UserRole,
      telegramChatId: user.telegramChatId ?? null,
    };
  }
}

export function getPrincipal(request: Request & { principal?: AuthenticatedPrincipal }): AuthenticatedPrincipal {
  if (!request.principal) throw new UnauthorizedException('Authentication required');
  return request.principal;
}
