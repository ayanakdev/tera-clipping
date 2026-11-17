import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@web': fileURLToPath(new URL('./web', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8484',
      '/media': 'http://127.0.0.1:8484',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
