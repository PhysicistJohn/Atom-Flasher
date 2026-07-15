import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [rendererContentSecurityPolicy(command === 'build'), react()],
  root: rendererRoot,
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(rendererRoot, '../../dist/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(rendererRoot, 'index.html') },
  },
}));

function rendererContentSecurityPolicy(production: boolean): Plugin {
  const placeholder = '__TINysa_CONNECT_SOURCE__';
  const connectSource = production
    ? "'none'"
    : "'self' ws://127.0.0.1:5173";
  return {
    name: 'tinysa-renderer-content-security-policy',
    enforce: 'pre',
    transformIndexHtml(html) {
      if (!html.includes(placeholder)) throw new Error('Renderer CSP connect-source placeholder is missing');
      return html.replace(placeholder, connectSource);
    },
  };
}
