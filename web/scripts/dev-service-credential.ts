/**
 * Dev-proxy service credential minting — server-side only, never bundled.
 *
 * The canonical implementation lives in packages/types/src/service-credential.ts
 * (the API verifies with it, the bot mints with it). This mint-only copy exists
 * because the web Docker image builds with web/ as its context, so vite.config
 * cannot reach ../packages — the production build failed on exactly that import.
 * The wire format is pinned from both sides: test:signing covers the canonical
 * module, src/lib/devServiceCredential.test.ts covers this one.
 */
import { createHmac } from 'crypto';

export function mintDevServiceCredential(
  userId: string,
  secret: string,
  ttlSeconds = 300,
  nowMs = Date.now(),
): string {
  if (!userId) throw new Error('mintDevServiceCredential: userId is required');
  if (!secret) throw new Error('mintDevServiceCredential: signing secret is required');
  const exp = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSeconds));
  const payload = Buffer.from(JSON.stringify({ u: userId, e: exp }), 'utf8').toString('base64url');
  const body = `s1.${payload}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `oneteam-user:${body}.${sig}`;
}
