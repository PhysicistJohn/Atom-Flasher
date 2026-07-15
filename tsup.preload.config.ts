import { defineConfig } from 'tsup';

// A sandboxed Electron preload receives only Electron's limited require
// polyfill. Bundle every non-Electron dependency so the bridge cannot depend
// on ambient node_modules resolution inside the renderer process.
export default defineConfig({
  entry: { preload: 'src/main/preload.ts' },
  format: ['cjs'],
  target: 'node22',
  outDir: 'dist/main',
  external: ['electron'],
  noExternal: ['zod'],
  splitting: false,
  clean: false,
});
