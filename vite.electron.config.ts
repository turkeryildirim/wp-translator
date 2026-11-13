import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist/electron',
    emptyOutDir: false,
    lib: {
      entry: 'electron/main.ts',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [
        'electron',
        'better-sqlite3',
        /^node:/,
      ],
    },
  },
});
