const PROMPT = new TextEncoder().encode('ch> ');
const CRLF = new Uint8Array([0x0d, 0x0a]);
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ByteTransport {
  open(path: string): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onBytes(listener: (bytes: Uint8Array) => void): () => void;
  onEvent(listener: (event: TransportEvent) => void): () => void;
}

export type TransportEvent =
  | { type: 'opened' }
  | { type: 'closed'; reason?: string }
  | { type: 'error'; error: Error };

interface Pending<T = string | Uint8Array> {
  command: string;
  timeoutMs: number;
  payloadBytes?: number;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export class CommandScheduler {
  #queue: Pending[] = [];
  #active: Pending | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #buffer = new Uint8Array();
  #length = 0;
  #fault: Error | undefined;
  #unsubscribe: () => void;

  constructor(private readonly transport: ByteTransport, private readonly maximumBufferedBytes = 4 * 1024 * 1024) {
    this.#unsubscribe = transport.onBytes((bytes) => this.#receive(bytes));
  }

  execute(command: string, timeoutMs = 10_000): Promise<string> {
    return this.#enqueue<string>(command, timeoutMs);
  }

  executeBinary(command: string, payloadBytes: number, timeoutMs = 20_000): Promise<Uint8Array> {
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) return Promise.reject(new RangeError('payloadBytes must be non-negative'));
    return this.#enqueue<Uint8Array>(command, timeoutMs, payloadBytes);
  }

  dispose(): void {
    this.#fail(new Error('Command scheduler disposed'));
    this.#unsubscribe();
  }

  #enqueue<T extends string | Uint8Array>(command: string, timeoutMs: number, payloadBytes?: number): Promise<T> {
    if (!command || new TextEncoder().encode(command).length > 47 || !/^[\x20-\x7e]+$/.test(command)) {
      return Promise.reject(new Error('Command must contain 1..47 printable ASCII characters'));
    }
    if (this.#fault) return Promise.reject(this.#fault);
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ command, timeoutMs, ...(payloadBytes === undefined ? {} : { payloadBytes }), resolve: resolve as (value: string | Uint8Array) => void, reject });
      void this.#startNext();
    });
  }

  async #startNext(): Promise<void> {
    if (this.#active || this.#fault) return;
    const active = this.#queue.shift();
    if (!active) return;
    this.#active = active;
    this.#timer = setTimeout(() => this.#fail(new Error(`Command timed out and the serial protocol is no longer synchronized: ${active.command}`)), active.timeoutMs);
    try {
      await this.transport.write(new TextEncoder().encode(`${active.command}\r`));
      this.#process();
    } catch (value) {
      this.#fail(new Error(`Serial write failed for ${active.command}: ${message(value)}`, { cause: value }));
    }
  }

  #receive(bytes: Uint8Array): void {
    if (this.#fault) return;
    try {
      const required = this.#length + bytes.length;
      if (required > this.maximumBufferedBytes) throw new Error(`Serial response exceeded ${this.maximumBufferedBytes} bytes`);
      if (required > this.#buffer.length) {
        const expanded = new Uint8Array(Math.min(this.maximumBufferedBytes, Math.max(required, Math.max(1_024, this.#buffer.length * 2))));
        expanded.set(this.#buffer.subarray(0, this.#length));
        this.#buffer = expanded;
      }
      this.#buffer.set(bytes, this.#length);
      this.#length = required;
      this.#process();
    } catch (value) {
      this.#fail(new Error(`Serial response parser failed: ${message(value)}`, { cause: value }));
    }
  }

  #process(): void {
    const active = this.#active;
    if (!active) return;
    const bytes = this.#buffer.subarray(0, this.#length);
    const parsed = active.payloadBytes === undefined
      ? extractTextResponse(bytes, active.command)
      : extractFixedBinaryResponse(bytes, active.command, active.payloadBytes);
    if (!parsed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const remaining = this.#length - parsed.consumedBytes;
    if (remaining > 0) this.#buffer.copyWithin(0, parsed.consumedBytes, this.#length);
    this.#length = remaining;
    this.#active = undefined;
    active.resolve(parsed.value);
    void this.#startNext();
  }

  #fail(error: Error): void {
    if (this.#fault) return;
    this.#fault = error;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#active?.reject(error);
    this.#active = undefined;
    for (const pending of this.#queue.splice(0)) pending.reject(error);
    this.#buffer = new Uint8Array();
    this.#length = 0;
  }
}

export function extractTextResponse(buffer: Uint8Array, command: string): { value: string; consumedBytes: number } | undefined {
  const payloadStart = commandPayloadStart(buffer, command);
  if (payloadStart < 0) return undefined;
  const promptIndex = findSequence(buffer, PROMPT, payloadStart);
  if (promptIndex < 0) return undefined;
  let end = promptIndex;
  while (end >= payloadStart + 2 && buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
  try {
    return { value: decoder.decode(buffer.slice(payloadStart, end)), consumedBytes: promptIndex + PROMPT.length };
  } catch (value) {
    throw new Error(`Command ${command} returned invalid UTF-8`, { cause: value });
  }
}

export function extractFixedBinaryResponse(buffer: Uint8Array, command: string, payloadBytes: number): { value: Uint8Array; consumedBytes: number } | undefined {
  const payloadStart = commandPayloadStart(buffer, command);
  if (payloadStart < 0) return undefined;
  const promptStart = payloadStart + payloadBytes;
  if (buffer.length < promptStart + PROMPT.length) return undefined;
  if (findSequence(buffer, PROMPT, promptStart) !== promptStart) throw new Error(`Command ${command} binary payload did not end at the exact shell prompt`);
  return { value: buffer.slice(payloadStart, promptStart), consumedBytes: promptStart + PROMPT.length };
}

function commandPayloadStart(buffer: Uint8Array, command: string): number {
  const echo = new TextEncoder().encode(command);
  let from = 0;
  while (from <= buffer.length - echo.length) {
    const index = findSequence(buffer, echo, from);
    if (index < 0) return -1;
    const lineStart = index === 0 || endsWith(buffer, index, CRLF) || endsWith(buffer, index, PROMPT);
    const lineEnd = index + echo.length;
    if (lineStart && lineEnd + 2 <= buffer.length && buffer[lineEnd] === 0x0d && buffer[lineEnd + 1] === 0x0a) return lineEnd + 2;
    from = index + 1;
  }
  return -1;
}

function findSequence(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let index = from; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) if (haystack[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}

function endsWith(buffer: Uint8Array, end: number, suffix: Uint8Array): boolean {
  if (end < suffix.length) return false;
  for (let index = 0; index < suffix.length; index++) if (buffer[end - suffix.length + index] !== suffix[index]) return false;
  return true;
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
