import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        output: resolve(__dirname, 'output.html'),
        video: resolve(__dirname, 'video.html'),
        sfx: resolve(__dirname, 'sfx.html'),
        videos: resolve(__dirname, 'videos.html'),
      },
    },
  },
  server: {
    port: 5280,
    proxy: {
      '/api': 'http://127.0.0.1:8780',
      '/media': 'http://127.0.0.1:8780',
      '/ws': { target: 'ws://127.0.0.1:8780', ws: true },
    },
  },
});
