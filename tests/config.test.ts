import { describe, expect, it } from 'vitest';
import { loadApplicationConfig } from '../src/main/config.js';

describe('application environment contract', () => {
  it('parses local development and explicit DFU configuration once', () => {
    const config = loadApplicationConfig({
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173/app',
      TINYSA_DFU_UTIL: '/opt/homebrew/bin/dfu-util',
      PATH: '/usr/bin',
    }, false);
    expect(config.developmentServerUrl?.href).toBe('http://127.0.0.1:5173/app');
    expect(config).toMatchObject({ dfuUtilPath: '/opt/homebrew/bin/dfu-util', executableSearchPath: '/usr/bin' });
  });

  it('ignores renderer development overrides in packaged builds', () => {
    const config = loadApplicationConfig({ VITE_DEV_SERVER_URL: 'http://attacker.invalid', PATH: '' }, true);
    expect(config.developmentServerUrl).toBeUndefined();
  });

  it('rejects relative executable paths and non-local development origins', () => {
    expect(() => loadApplicationConfig({ TINYSA_DFU_UTIL: './dfu-util', PATH: '' }, false)).toThrow(/absolute/i);
    expect(() => loadApplicationConfig({ VITE_DEV_SERVER_URL: 'https://localhost:5173', PATH: '' }, false)).toThrow(/must be/i);
  });
});
