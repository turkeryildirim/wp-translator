import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    root: '.',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/cli/**',
        'src/po/types.ts',
        'src/translate/types.ts',
      ],
      reporter: ['text', 'json-summary', 'html'],
    },
  },
});
