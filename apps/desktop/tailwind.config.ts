import type { Config } from "tailwindcss";

// Use CommonJS export so Node can load this file under the package's CJS type.
const config: Config = {
  content: ["./src/renderer/**/*.{tsx,ts,jsx,js,html}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

module.exports = config;

