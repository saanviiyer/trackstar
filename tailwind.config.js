/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Five-color brand palette.
        yellow: "#ffd400",
        orange: "#ff9f1c",
        magenta: "#d000ff",
        purple: "#8a12ff",
        ink: "#2c0f4b",
      },
      fontFamily: {
        // Times New Roman style serif everywhere.
        sans: ["'Times New Roman'", "Times", "Georgia", "serif"],
        serif: ["'Times New Roman'", "Times", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
