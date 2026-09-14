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
      },
    },
  },
  plugins: [],
};
