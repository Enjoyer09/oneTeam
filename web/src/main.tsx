import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

/* ────────────────────────────────────────────────────────────────────────────
   Qlobal şəkil ehtiyatı.
   Şəkil yüklənə bilmirsə (şəbəkə kəsilməsi, silinmiş fayl, 404), brauzerin
   "sınıq şəkil" ikonkası yerinə neytral, tema uyğun tutucu göstərilir.
   Beləliklə interfeys heç vaxt pozulmuş görünmür.
   ──────────────────────────────────────────────────────────────────────────── */
const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" fill="none"/>
      <rect x="10" y="16" width="44" height="32" rx="5" fill="none" stroke="#8d9ab0" stroke-width="2.5" opacity=".55"/>
      <circle cx="24" cy="27" r="3.5" fill="#8d9ab0" opacity=".55"/>
      <path d="M14 43l11-11 8 8 6-6 11 11" fill="none" stroke="#8d9ab0" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>
    </svg>`,
  );

document.addEventListener(
  'error',
  (event) => {
    const el = event.target as HTMLElement | null;
    if (!el || el.tagName !== 'IMG') return;
    const img = el as HTMLImageElement;
    if (img.dataset.imgFallback) return; // sonsuz dövrün qarşısını alır
    img.dataset.imgFallback = '1';
    img.src = PLACEHOLDER;
  },
  true, // capture — şəkil xətaları qabarcıq kimi yuxarı çıxmır
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
