import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

document.documentElement.dataset.platform = navigator.platform.startsWith('Mac') ? 'darwin' : 'other';

void startRenderer();

async function startRenderer(): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.VITE_SAFE_MOCK === '1') {
    const { installSafeRendererMock } = await import('./dev-mock.js');
    installSafeRendererMock();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('Renderer root is missing');
  createRoot(root).render(<StrictMode><App/></StrictMode>);
}
