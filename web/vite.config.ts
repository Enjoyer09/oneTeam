import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  server: {
    port: 5173,
    host: true,
    // İstehsalda nginx `/api/portal/*` üzərinə PORTAL_TOKEN bəsləyir
    // (web/nginx.conf — panel hələ konfiqurasiya olunmayıqsa). Dev-də edge
    // yoxdur, ona görə eyni rolü vite proxy oynayır: başlıq bu config-də
    // (server tərəfi) yox, heç vaxt bundle-a düşmür — VITE_ də deyil.
    proxy: {
      '/api/portal': {
        target: process.env.VITE_API_BASE_URL || 'http://localhost:3477',
        changeOrigin: true,
        headers: process.env.ONETEAM_API_TOKEN
          ? { Authorization: `Bearer ${process.env.ONETEAM_API_TOKEN}` }
          : {},
      },
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
});
