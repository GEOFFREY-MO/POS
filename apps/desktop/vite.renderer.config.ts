import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    minify: 'esbuild', // Use esbuild (faster and smaller than terser)
    sourcemap: false, // Disable source maps to reduce size
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'query-vendor': ['@tanstack/react-query'],
          'zxing-vendor': ['@zxing/browser', '@zxing/library'],
        },
        // Optimize chunk names for better caching
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    chunkSizeWarningLimit: 1000,
    // Tree-shaking and dead code elimination
    target: 'esnext',
    modulePreload: false,
  },
  publicDir: path.resolve(__dirname, "src/renderer/public"),
  server: {
    port: 5173,
    strictPort: true,
  },
});

