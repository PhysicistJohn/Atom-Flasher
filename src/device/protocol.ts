const PROMPT = new TextEncoder().encode('ch> ');
const CRLF = new Uint8Array([0x0d, 0x0a]);
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ByteTransport {
  open(path: string): Promise<void>;
  close(): Promise<void>;
  /** Discards bytes received before the next command write begins. */
  discardInput(): Promise<void>;
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
  #responseWindowOpen = false;
  #unsubscribeBytes: () => void;
  #unsubscribeEvents: () => void;

  constructor(
    private readonly transport: ByteTransport,
    private readonly maximumBufferedBytes = 4 * 1024 * 1024,
    private readonly maximumQueuedCommands = 32,
  ) {
    if (!Number.isSafeInteger(maximumBufferedBytes) || maximumBufferedBytes <= 0) {
      throw new RangeError('maximumBufferedBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maximumQueuedCommands) || maximumQueuedCommands <= 0) {
      throw new RangeError('maximumQueuedCommands must be a positive safe integer');
    }
    this.#unsubscribeBytes = transport.onBytes((bytes) => this.#receive(bytes));
    this.#unsubscribeEvents = transport.onEvent((event) => {
      if (event.type === 'opened') return;
      const detail = event.type === 'error' ? event.error.message : event.reason ?? 'transport closed';
      this.#fail(new Error(`Serial transport terminated: ${detail}`, { cause: event.type === 'error' ? event.error : undefined }));
    });
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
    this.#unsubscribeBytes();
    this.#unsubscribeEvents();
  }

  #enqueue<T extends string | Uint8Array>(command: string, timeoutMs: number, payloadBytes?: number): Promise<T> {
    if (!command || new TextEncoder().encode(command).length > 47 || !/^[\x20-\x7e]+$/.test(command)) {
      return Promise.reject(new Error('Command must contain 1..47 printable ASCII characters'));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return Promise.reject(new RangeError('timeoutMs must be an integer from 1 through 2147483647'));
    }
    if (this.#fault) return Promise.reject(this.#fault);
    if (this.#queue.length >= this.maximumQueuedCommands) return Promise.reject(new Error(`Command queue is limited to ${this.maximumQueuedCommands} waiting commands`));
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
    this.#responseWindowOpen = false;
    this.#timer = setTimeout(() => this.#fail(new Error(`Command timed out and the serial protocol is no longer synchronized: ${active.command}`)), active.timeoutMs);
    try {
      // Bytes from an earlier command must never prove that a newly issued
      // safety command succeeded. Clear the host input queue, then open the
      // response window immediately before writing the new command.
      await this.transport.discardInput();
      if (this.#fault || this.#active !== active) return;
      this.#responseWindowOpen = true;
      await this.transport.write(new TextEncoder().encode(`${active.command}\r`));
      if (this.#fault || this.#active !== active) return;
      this.#process();
    } catch (value) {
      this.#fail(new Error(`Serial write failed for ${active.command}: ${message(value)}`, { cause: value }));
    }
  }

  #receive(bytes: Uint8Array): void {
    if (this.#fault) return;
    if (!this.#active || !this.#responseWindowOpen) {
      this.#fail(new Error('Unsolicited serial bytes arrived outside the active command response window'));
      return;
    }
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
    const remaining = this.#length - parsed.consumedBytes;
    if (remaining > 0) {
      this.#fail(new Error(`Command ${active.command} returned trailing bytes after the exact shell prompt`));
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#length = 0;
    this.#responseWindowOpen = false;
    this.#active = undefined;
    active.resolve(parsed.value);
    void this.#startNext();
  }

  #fail(error: Error): void {
    if (this.#fault) return;
    this.#fault = error;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#responseWindowOpen = false;
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
