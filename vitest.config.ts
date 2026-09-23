import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, which has `root: 'panel'` for the UI build and
// would otherwise send vitest looking for tests inside the panel.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], root: '.' },
});
