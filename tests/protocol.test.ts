import { describe, expect, it } from 'vitest';
import { extractFixedBinaryResponse, extractTextResponse } from '../src/device/protocol.js';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('tinySA serial response framing', () => {
  it('requires the exact command echo and shell prompt', () => {
    const frame = bytes('version\r\ntinySA4_v1.4-224-gc979386\r\nch> ');
    expect(extractTextResponse(frame, 'version')).toEqual({
      value: 'tinySA4_v1.4-224-gc979386',
      consumedBytes: frame.length,
    });
    expect(extractTextResponse(bytes('other\r\nvalue\r\nch> '), 'version')).toBeUndefined();
  });

  it('does not scan through a fixed binary payload for a coincidental prompt', () => {
    const prefix = bytes('capture\r\n');
    const payload = Uint8Array.of(1, 2, 3, 4);
    const prompt = bytes('ch> ');
    const response = new Uint8Array(prefix.length + payload.length + prompt.length);
    response.set(prefix); response.set(payload, prefix.length); response.set(prompt, prefix.length + payload.length);
    expect(extractFixedBinaryResponse(response, 'capture', 4)?.value).toEqual(payload);
    expect(() => extractFixedBinaryResponse(bytes('capture\r\nch> xxxx'), 'capture', 4)).toThrow(/exact shell prompt/);
  });
});
