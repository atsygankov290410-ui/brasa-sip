import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Relative base so the build works from any folder (file server, school laptop, USB stick).
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
    },
  },
  test: { environment: 'node' },
} as any);
