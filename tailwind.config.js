/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./code.html', './popup.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['"Space Mono"', 'monospace'],
      },
      colors: {
        opxy: {
          bg: '#121316',
          card: '#1c1d22',
          surface: '#22242b',
          border: '#2a2d36',
          pad: '#1a1c24',
          padActive: '#587bf8',
          encoderBlue: '#587bf8',
          encoderTeal: '#45c8b2',
          encoderPurple: '#8f65eb',
          encoderPink: '#e94879'
        }
      }
    }
  },
  plugins: [],
};
