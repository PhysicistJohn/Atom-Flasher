import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: rendererRoot,
  base: './',
  build: {
    outDir: resolve(rendererRoot, '../../dist/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(rendererRoot, 'index.html') },
  },
});
