import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**', 'release/**'],
  },
  eslint.configs.recommended,
  {
    rules: {
      // Binary/device output is deliberately sanitized with explicit control ranges.
      'no-control-regex': 'off',
      // These ESLint 10 heuristics produce false positives around fail-closed
      // cleanup/cause aggregation and explicit lock-ownership transitions.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', '*.config.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            'electron',
            'node:*',
            '../device/**',
            '../dfu/**',
            '../core/firmware-updater*',
            '../core/legacy-migration*',
            '../core/persistence/**',
          ],
          message: 'The renderer may use only presentation/domain types and the declared preload API.',
        }],
      }],
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/device/**/*.ts', 'src/dfu/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'electron',
          message: 'Domain, persistence, and device layers must remain independent of Electron.',
        }],
      }],
    },
  },
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
);
