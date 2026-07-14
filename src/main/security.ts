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

export function isTrustedRendererUrl(actual: string, expected: { developmentOrigin?: string; productionUrl?: string }): boolean {
  try {
    const url = new URL(actual);
    if (expected.developmentOrigin) return url.origin === expected.developmentOrigin;
    return Boolean(expected.productionUrl && url.href === expected.productionUrl);
  } catch {
    return false;
  }
}
