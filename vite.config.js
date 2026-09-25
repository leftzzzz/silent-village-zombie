import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: { main: import.meta.dirname + '/index.html' },
    },
  },
});
