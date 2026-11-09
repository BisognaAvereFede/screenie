import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { main: 'src/index.html', share: 'src/share.html' },
    },
  },
});
