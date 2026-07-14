import { describe, expect, it } from 'vitest';
import { isTrustedRendererUrl, selectDevelopmentServerUrl, validateDevelopmentServerUrl } from '../src/main/security.js';

describe('renderer trust boundary', () => {
  it('allows only local unauthenticated HTTP development origins', () => {
    expect(validateDevelopmentServerUrl('http://localhost:5173').origin).toBe('http://localhost:5173');
    expect(validateDevelopmentServerUrl('http://127.0.0.1:5173/path').hostname).toBe('127.0.0.1');
    expect(() => validateDevelopmentServerUrl('https://localhost:5173')).toThrow(/must be/);
    expect(() => validateDevelopmentServerUrl('http://example.com:5173')).toThrow(/must be/);
    expect(() => validateDevelopmentServerUrl('http://user@localhost:5173')).toThrow(/must be/);
  });

  it('requires exact production URL or exact development origin', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/page', { developmentOrigin: 'http://localhost:5173' })).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/page', { developmentOrigin: 'http://localhost:5173' })).toBe(false);
    expect(isTrustedRendererUrl('file:///app/dist/renderer/index.html', { productionUrl: 'file:///app/dist/renderer/index.html' })).toBe(true);
    expect(isTrustedRendererUrl('file:///tmp/other.html', { productionUrl: 'file:///app/dist/renderer/index.html' })).toBe(false);
  });

  it('never honors a development-server environment override in a packaged app', () => {
    expect(selectDevelopmentServerUrl('http://localhost:5173', false)?.origin).toBe('http://localhost:5173');
    expect(selectDevelopmentServerUrl('http://localhost:5173', true)).toBeUndefined();
    expect(selectDevelopmentServerUrl('http://attacker.example', true)).toBeUndefined();
  });
});
