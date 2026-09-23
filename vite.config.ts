import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'panel',
  plugins: [vue()],
  build: { outDir: '../dist/panel', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4173' } },
});
