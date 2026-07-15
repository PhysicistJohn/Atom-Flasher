import { SerialPort } from 'serialport';
import { TINYSA_USB_PRODUCT_ID, TINYSA_USB_VENDOR_ID, portCandidateSchema, type PortCandidate } from '../core/contracts.js';
import type { ByteTransport, TransportEvent } from './protocol.js';

export class SerialTransport implements ByteTransport {
  #port: SerialPort | undefined;
  #listeners = new Set<(bytes: Uint8Array) => void>();
  #eventListeners = new Set<(event: TransportEvent) => void>();

  constructor(
    private readonly createPort: (options: ConstructorParameters<typeof SerialPort>[0]) => SerialPort = (options) => new SerialPort(options),
    private readonly listPorts: typeof SerialPort.list = () => SerialPort.list(),
  ) {}

  async list(): Promise<PortCandidate[]> {
    const candidates = (await this.listPorts()).map((port) => {
      const vendorId = normalizeUsbId(port.vendorId);
      const productId = normalizeUsbId(port.productId);
      const exact = vendorId === TINYSA_USB_VENDOR_ID && productId === TINYSA_USB_PRODUCT_ID;
      return portCandidateSchema.parse({
        id: [port.path, port.serialNumber, vendorId, productId].filter(Boolean).join(':'),
        path: port.path,
        ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
        ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
        ...(vendorId ? { vendorId } : {}),
        ...(productId ? { productId } : {}),
        usbMatch: exact ? 'exact-zs407-cdc' : 'unverified-serial',
      });
    });
    return candidates.sort((left, right) => Number(right.usbMatch === 'exact-zs407-cdc') - Number(left.usbMatch === 'exact-zs407-cdc') || left.path.localeCompare(right.path));
  }

  async open(path: string): Promise<void> {
    if (this.#port) throw new Error('A serial port is already open');
    const port = this.createPort({ path, baudRate: 115_200, autoOpen: false, lock: true });
    let openingComplete = false;
    let openingFailure: Error | undefined;
    this.#port = port;
    port.on('data', (data: Buffer) => {
      const copy = Uint8Array.from(data);
      for (const listener of this.#listeners) listener(copy);
    });
    port.on('error', (error: Error) => {
      if (!openingComplete) openingFailure ??= error;
      for (const listener of this.#eventListeners) listener({ type: 'error', error });
    });
    port.on('close', () => {
      if (!openingComplete) openingFailure ??= new Error('Serial port closed while opening');
      if (this.#port === port) this.#port = undefined;
      for (const listener of this.#eventListeners) listener({ type: 'closed', reason: 'Serial port closed' });
    });
    try {
      await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
      if (openingFailure) throw openingFailure;
      if (this.#port !== port || !port.isOpen) throw new Error('Serial port did not remain open');
      openingComplete = true;
    } catch (value) {
      if (port.isOpen) {
        try {
          await new Promise<void>((resolve, reject) => port.close((error) => error ? reject(error) : resolve()));
        } catch (closeFailure) {
          // Preserve ownership and listeners so the caller can retry close;
          // forgetting an open native handle would make a second admission unsafe.
          throw new AggregateError(
            [asError(value), asError(closeFailure)],
            'Serial port failed while opening and could not close',
          );
        }
      }
      if (this.#port === port) this.#port = undefined;
      port.removeAllListeners();
      throw value;
    }
    for (const listener of this.#eventListeners) listener({ type: 'opened' });
  }

  async close(): Promise<void> {
    const port = this.#port;
    if (!port) return;
    if (!port.isOpen) {
      if (this.#port === port) this.#port = undefined;
      port.removeAllListeners();
      return;
    }
    await new Promise<void>((resolve, reject) => port.close((error) => error ? reject(error) : resolve()));
    if (this.#port === port) this.#port = undefined;
    port.removeAllListeners();
  }

  async write(bytes: Uint8Array): Promise<void> {
    const port = this.#port;
    if (!port?.isOpen) throw new Error('Serial port is not open');
    await new Promise<void>((resolve, reject) => port.write(bytes, (error) => error
      ? reject(error)
      : port.drain((drainError) => drainError ? reject(drainError) : resolve())));
  }

  async discardInput(): Promise<void> {
    const port = this.#port;
    if (!port?.isOpen) throw new Error('Serial port is not open');
    await new Promise<void>((resolve, reject) => port.flush((error) => error ? reject(error) : resolve()));
  }

  onBytes(listener: (bytes: Uint8Array) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }
}

export function normalizeUsbId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^0x/i, '').padStart(4, '0').toLowerCase();
  if (!/^[a-f0-9]{4}$/.test(normalized)) throw new Error(`Serial subsystem returned malformed USB identifier: ${value}`);
  return normalized;
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
