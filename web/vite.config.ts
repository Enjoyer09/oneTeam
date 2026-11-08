/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import path from 'path';
import { signServiceCredential } from '../packages/types/src/service-credential';

export default defineConfig(({ mode }) => {
  // Server-side only: read the repo-root .env so the dev proxy can mint the
  // same signed service credential the API expects. Nothing here is VITE_-
  // prefixed, so nothing here reaches the browser bundle.
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const signingSecret = (env.ONETEAM_SERVICE_SIGNING_SECRET || '').trim();
  const serviceUserId = (env.ONETEAM_SERVICE_USER_ID || '').trim();
  const staticToken = (env.ONETEAM_API_TOKEN || '').trim();

  // The edge credential, minted per request when a signing secret exists
  // (signed tokens expire in minutes — a config-time static header would die
  // mid-session). The caller's own panel key always wins, matching nginx.
  const edgeAuthorization = (): string | null => {
    if (signingSecret && serviceUserId) {
      return 'Bearer ' + signServiceCredential(serviceUserId, signingSecret);
    }
    return staticToken ? 'Bearer ' + staticToken : null;
  };

  const edgeProxy = {
    target: env.VITE_API_BASE_URL || 'http://localhost:3477',
    changeOrigin: true,
    configure: (proxy: {
      on: (
        event: 'proxyReq',
        cb: (
          proxyReq: { setHeader: (name: string, value: string) => void },
          req: { headers: { authorization?: string } },
        ) => void,
      ) => void;
    }) => {
      proxy.on('proxyReq', (proxyReq, req) => {
        if (req.headers.authorization) return;
        const auth = edgeAuthorization();
        if (auth) proxyReq.setHeader('Authorization', auth);
      });
    },
  };

  return {
    plugins: [react()],
    // Vitest reads this file too (no separate vitest.config.ts). jsdom is the
    // environment for the component tests under `src/**/*.test.tsx`; the same
    // alias the app build uses keeps a green test a test of the shipped graph.
    test: {
      environment: 'jsdom',
      globals: false,
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['src/test/setup.ts'],
    },
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    root: path.resolve(__dirname),
    server: {
      port: 5173,
      host: true,
      // İstehsalda nginx `/api/portal/*` üzərinə PORTAL_TOKEN bəsləyir
      // (web/nginx.conf — panel hələ konfiqurasiya olunmayıqsa). Dev-də edge
      // yoxdur, ona görə eyni rolü vite proxy oynayır: başlıq bu config-də
      // (server tərəfi) yox, heç vaxt bundle-a düşmür — VITE_ deyil.
      //
      // `/api/panel` də eyni proxy-dən keçməlidir: dev-də SPA fallback onu
      // HTML-lə cavablandırır və panelAuth "gözlənilməz cavab (HTTP 200)" verir
      // (auth-status/me/users/keys hamısı). Edge Bearer başlığı burada da
      // bəslənir — AuthGuard onu panel konfiqurasiya olunmayıb qəbul edir,
      // yəni ilk açar yaratmaq dev-də də işləyir.
      proxy: {
        '/api/portal': edgeProxy,
        '/api/panel': edgeProxy,
      },
    },
    css: {
      postcss: {
        plugins: [
          tailwindcss({
            config: path.resolve(__dirname, 'tailwind.config.js'),
          }),
          autoprefixer(),
        ],
      },
    },
  };
});
