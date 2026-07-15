// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App.js';
import { installSafeRendererMock } from '../src/renderer/dev-mock.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'tinySaFlasher');
});

describe('capability-free renderer workflow', () => {
  it('walks every pre-write screen while the synthetic flash remains cancelled', async () => {
    installSafeRendererMock();
    render(<App/>);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect & verify' }));
    expect(await screen.findByText('Pinned update available')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Download & verify exact image' }));
    expect(await screen.findByText('Physical preflight')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('CAL↔RF self-test passed'));
    fireEvent.click(screen.getByLabelText('CAL and RF connectors are disconnected'));
    fireEvent.click(screen.getByLabelText('This tinySA is the only device connected for the update'));
    fireEvent.change(screen.getByLabelText('Configuration disposition'), { target: { value: 'new-device-unchanged' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record preflight & disconnect' }));
    expect(await screen.findByText('Enter STM32 DFU mode')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check exact DFU target' }));
    expect(await screen.findByText('One exact DFU target is ready')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Install verified OEM update' }));
    expect(await screen.findByText('One exact DFU target is ready')).toBeTruthy();
    expect((await window.tinySaFlasher.snapshot()).update.writeDisposition).toBe('not-started');
  });
});
