/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './web/index.html',
    './web/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          red: '#F40009',
          dark: '#111827',
        },
        coke: {
          50: '#fff1f1',
          100: '#ffdfdf',
          200: '#ffc5c5',
          300: '#ff9d9d',
          400: '#ff6464',
          500: '#F40009',
          600: '#D80008',
          700: '#B50007',
          800: '#940006',
          900: '#7A0005',
        },

        /* ── Şüşə dizayn sistemi: hamısı CSS dəyişənlərinə bağlıdır,
              ona görə işıq/tünd tema avtomatik işləyir. ── */
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        hair: 'var(--hair)',
        'hair-2': 'var(--hair-2)',
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        bad: 'var(--bad)',
        info: 'var(--info)',
      },

      /* Prototipdəki kölgə reseptləri — düz kartların "yastı" görünməsinin həlli */
      boxShadow: {
        g1: 'var(--sh-1), inset 0 1px 0 var(--spec)',
        g2: 'var(--sh-2), inset 0 1px 0 var(--spec)',
        g3: 'var(--sh-3), inset 0 1px 0 var(--spec)',
        gwin: 'var(--sh-win), inset 0 1px 0 var(--spec)',
        subtle: 'var(--sh-1)',
      },

      /* h-18 əvvəl mövcud deyildi — Header səssizcə yığılırdı */
      spacing: {
        18: '4.5rem',
      },

      /* Apple hərəkət əyriləri */
      transitionTimingFunction: {
        out: 'cubic-bezier(.22,1,.36,1)',
        apple: 'cubic-bezier(.32,.72,0,1)',
        spring: 'cubic-bezier(.34,1.28,.64,1)',
      },
      transitionDuration: {
        150: '150ms',
        250: '250ms',
        400: '400ms',
      },

      backdropBlur: {
        g: '26px',
        'g-lg': '44px',
      },

      borderRadius: {
        win: '22px',
        card: '18px',
        in: '13px',
        ctl: '11px',
      },

      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"Helvetica Neue"',
          '"Segoe UI"',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', '"SF Mono"', 'Menlo', 'monospace'],
      },

      keyframes: {
        viewIn: {
          from: { opacity: '0', transform: 'translateY(7px)' },
          to: { opacity: '1', transform: 'none' },
        },
        rise: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'none' },
        },
        toastIn: {
          from: { opacity: '0', transform: 'translateY(-10px) scale(.97)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        viewIn: 'viewIn 250ms cubic-bezier(.22,1,.36,1) both',
        rise: 'rise 400ms cubic-bezier(.22,1,.36,1) both',
        toastIn: 'toastIn 250ms cubic-bezier(.32,.72,0,1) both',
      },
    },
  },
  plugins: [],
};
