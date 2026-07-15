import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main/main.ts',
        'src/main/preload.ts',
        'src/renderer/global.d.ts',
        'src/renderer/main.tsx',
      ],
      reporter: ['text', 'html', 'json-summary'],
      reportOnFailure: true,
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 70,
      },
    },
  },
});
