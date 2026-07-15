export function validateDevelopmentServerUrl(value: string): URL {
  const url = new URL(value);
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname) || url.username || url.password) {
    throw new Error('VITE_DEV_SERVER_URL must be an unauthenticated http://localhost, 127.0.0.1, or [::1] URL');
  }
  return url;
}

export function selectDevelopmentServerUrl(value: string | undefined, isPackaged: boolean): URL | undefined {
  if (isPackaged || !value) return undefined;
  return validateDevelopmentServerUrl(value);
}

export type RendererTrust =
  | { mode: 'development'; origin: string }
  | { mode: 'production'; url: string };

export function isTrustedRendererUrl(actual: string, expected: RendererTrust | undefined): boolean {
  try {
    if (!expected) return false;
    const url = new URL(actual);
    if (expected.mode === 'development') return url.origin === expected.origin;
    return url.href === expected.url;
  } catch {
    return false;
  }
}
