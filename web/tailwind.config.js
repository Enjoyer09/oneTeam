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
        /* Brend qırmızısı — yalnız loqo/nişan detalı */
        coke: {
          DEFAULT: '#F40009',
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

        /* Əsas aksent — bənövşəyi. DEFAULT tema dəyişəninə bağlıdır (işıq/tünd
           avtomatik keçir); rəqəmli pillələr statikdir ki, /opacity modifierləri
           (bg-primary-500/12) düzgün işləsin. */
        primary: {
          DEFAULT: 'var(--primary)',
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
        },
        /* İkinci aksent — sarı */
        accent: {
          DEFAULT: 'var(--accent)',
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
        },
        surface: 'var(--g-card)',
        'surface-2': 'var(--g-panel)',
        page: 'var(--bg)',

        /* Mətn/status/səth rəngləri CSS dəyişənlərinə bağlıdır — işıq/tünd
           tema avtomatik işləyir. */
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

      /* Soft UI kölgələri — yumşaq, inset işıq xətti yoxdur */
      boxShadow: {
        g1: 'var(--sh-1)',
        g2: 'var(--sh-2)',
        g3: 'var(--sh-3)',
        gwin: 'var(--sh-win)',
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
        win: '24px',
        card: '20px',
        in: '14px',
        ctl: '12px',
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

      fontSize: {
        xs: ['13px', '18px'],
        sm: ['15px', '22px'],
        base: ['16px', '24px'],
        lg: ['18px', '26px'],
        xl: ['20px', '28px'],
        '2xl': ['24px', '32px'],
        '3xl': ['30px', '36px'],
        '4xl': ['36px', '40px'],
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
          /* Alt-gündən toast yuxarıdan deyil, aşağıdan qalxır (§10.14 hədəfi). */
          from: { opacity: '0', transform: 'translateY(10px) scale(.97)' },
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
