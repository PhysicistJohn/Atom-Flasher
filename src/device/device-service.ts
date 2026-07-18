import {
  SCREEN_BYTES,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  TINYSA_USB_PRODUCT_ID,
  TINYSA_USB_VENDOR_ID,
  lookupSupportedZs407OemFirmware,
  portCandidateSchema,
  type DeviceDiagnostics,
  type DeviceIdentity,
  type DeviceSnapshot,
  type PortCandidate,
  type ScreenFrame,
} from '../core/contracts.js';
import { CommandScheduler } from './protocol.js';
import type { ByteTransport, TransportEvent } from './protocol.js';
import { SerialTransport } from './serial-transport.js';

const REQUIRED_COMMANDS = ['version', 'info', 'help', 'mode', 'output', 'vbat', 'deviceid', 'capture'] as const;
type FirmwareMutationCommand = 'output off' | 'mode input';

export interface DeviceTransport extends ByteTransport { list(): Promise<PortCandidate[]>; }
export const MANUAL_POWER_OFF_CONFIRMATION = 'DEVICE IS PHYSICALLY POWERED OFF' as const;

export class Zs407DeviceService {
  #scheduler: CommandScheduler | undefined;
  #snapshot: DeviceSnapshot = { connection: 'disconnected' };
  #versionResponse = '';
  #infoResponse = '';
  #commands: readonly string[] = [];
  #closing = false;
  #outputOffUnconfirmed = false;
  constructor(private readonly transport: DeviceTransport = new SerialTransport()) {
    transport.onEvent((event) => this.#handleTransportEvent(event));
  }

  listDevices(): Promise<PortCandidate[]> { return this.transport.list(); }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }

  async connect(candidate: PortCandidate): Promise<DeviceSnapshot> {
    if (this.#snapshot.connection !== 'disconnected') throw new Error('A device session is already active');
    const selected = portCandidateSchema.parse(candidate);
    const liveCandidate = bindCurrentExactCandidate(selected, await this.transport.list());
    this.#snapshot = { connection: 'connecting' };
    try {
      await this.transport.open(liveCandidate.path);
      if (this.#snapshot.connection === 'faulted') {
        throw new Error(`Serial transport faulted during connection: ${this.#snapshot.fault ?? 'unknown transport fault'}`);
      }
      this.#outputOffUnconfirmed = true;
      this.#scheduler = new CommandScheduler(this.transport);
      this.#snapshot = { connection: 'identifying' };
      await this.#executeMutation('output off');
      this.#versionResponse = await this.#scheduler.execute('version');
      this.#infoResponse = await this.#scheduler.execute('info');
      this.#commands = parseHelpCommands(await this.#scheduler.execute('help'));
      requireCommands(this.#commands);
      const identity = parseIdentity(this.#versionResponse, this.#infoResponse, liveCandidate);
      await this.#executeMutation('output off');
      await this.#executeMutation('mode input');
      const telemetry = await this.#readTelemetry();
      this.#snapshot = { connection: 'ready', identity, telemetry, connectedAt: new Date().toISOString() };
      return this.snapshot();
    } catch (value) {
      this.#scheduler?.dispose();
      this.#scheduler = undefined;
      let closeFailure: unknown;
      this.#closing = true;
      try { await this.transport.close(); } catch (cleanupValue) { closeFailure = cleanupValue; }
      finally { this.#closing = false; }
      if (closeFailure) {
        const failures = [asError(value), asError(closeFailure)];
        if (this.#outputOffUnconfirmed) failures.push(new Error('RF output off was not confirmed; power the analyzer off manually before handling RF connections'));
        const aggregate = new AggregateError(failures, 'Device connection failed and serial cleanup also failed');
        this.#snapshot = { connection: 'faulted', fault: aggregate.message };
        throw aggregate;
      }
      if (this.#outputOffUnconfirmed) {
        const error = new Error(`Device connection failed before RF output off was confirmed. Power the analyzer off manually before handling RF connections: ${message(value)}`, { cause: value });
        this.#snapshot = { connection: 'faulted', fault: error.message };
        throw error;
      }
      this.#snapshot = { connection: 'disconnected', fault: message(value) };
      throw value;
    }
  }

  async disconnect(): Promise<void> {
    if (this.#snapshot.connection === 'disconnected' && !this.#outputOffUnconfirmed) return;
    this.#snapshot = { ...this.#snapshot, connection: 'disconnecting' };
    let outputFailure: unknown;
    try { if (this.#scheduler) await this.#executeMutation('output off'); } catch (value) { outputFailure = value; }
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    let closeFailure: unknown;
    this.#closing = true;
    try { await this.transport.close(); } catch (value) { closeFailure = value; }
    finally { this.#closing = false; }
    const failures: Error[] = [];
    if (outputFailure) failures.push(asError(outputFailure));
    if (closeFailure) failures.push(asError(closeFailure));
    if (this.#outputOffUnconfirmed) failures.push(new Error('RF output off remains unconfirmed; reconnect and verify it if possible, or power the analyzer off manually before handling RF connections'));
    if (failures.length) {
      const cause = failures.length === 1 ? failures[0]! : new AggregateError(failures, 'Multiple safe-disconnect operations failed');
      const error = new Error(`Safe disconnect failed: ${failures.map((failure) => failure.message).join('; ')}`, { cause });
      this.#snapshot = { connection: 'faulted', fault: error.message };
      throw error;
    }
    this.#outputOffUnconfirmed = false;
    this.#snapshot = { connection: 'disconnected' };
  }

  /**
   * Clears an otherwise unrecoverable RF-off uncertainty only after the main
   * process obtains an explicit physical power-off confirmation. This never
   * admits a device or resumes an update; a later session must start from a
   * fresh exact USB enumeration and run `output off` again.
   */
  async recoverAfterManualPowerOff(confirmation: typeof MANUAL_POWER_OFF_CONFIRMATION): Promise<DeviceSnapshot> {
    if (confirmation !== MANUAL_POWER_OFF_CONFIRMATION) throw new Error('Exact manual power-off confirmation is required');
    if (this.#snapshot.connection !== 'faulted' || !this.#outputOffUnconfirmed) {
      throw new Error('Manual power-off recovery is available only for an unconfirmed RF-off fault');
    }
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    this.#closing = true;
    try { await this.transport.close(); }
    catch (value) {
      const error = new Error(`Manual power-off was acknowledged, but the host serial port still could not close: ${message(value)}`, { cause: value });
      this.#snapshot = { connection: 'faulted', fault: error.message };
      throw error;
    } finally {
      this.#closing = false;
    }
    this.#outputOffUnconfirmed = false;
    this.#snapshot = { connection: 'disconnected', fault: 'Previous RF-off state was resolved by a local physical power-off confirmation' };
    return this.snapshot();
  }

  async readDiagnostics(): Promise<DeviceDiagnostics> {
    const identity = this.#requireReadyIdentity();
    await this.#executeMutation('output off');
    const version = await this.#ready().execute('version');
    const info = await this.#ready().execute('info');
    const commands = parseHelpCommands(await this.#ready().execute('help'));
    requireCommands(commands);
    const refreshed = parseIdentity(version, info, identity.port);
    if (refreshed.firmwareVersion !== identity.firmwareVersion) throw new Error('Firmware identity changed during the connected preflight session');
    const telemetry = await this.#readTelemetry();
    this.#snapshot = { ...this.#snapshot, identity: refreshed, telemetry };
    return {
      identity: refreshed,
      firmwareVersionResponse: version,
      infoLines: nonEmptyLines(info),
      commands,
      telemetry,
      capturedAt: new Date().toISOString(),
    };
  }

  async captureScreen(): Promise<ScreenFrame> {
    this.#requireReadyIdentity();
    if (!this.#commands.includes('capture')) throw new Error('Connected firmware does not expose screen capture');
    await this.#executeMutation('output off');
    const wirePixels = await this.#ready().executeBinary('capture', SCREEN_BYTES, 20_000);
    const pixels = new Uint8Array(wirePixels.length);
    for (let offset = 0; offset < wirePixels.length; offset += 2) {
      pixels[offset] = wirePixels[offset + 1]!;
      pixels[offset + 1] = wirePixels[offset]!;
    }
    return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, format: 'rgb565le', pixels, capturedAt: new Date().toISOString() };
  }

  async #readTelemetry() {
    const batteryMillivolts = parseBattery(await this.#ready().execute('vbat'));
    const deviceId = parseDeviceId(await this.#ready().execute('deviceid'));
    return { batteryMillivolts, deviceId, capturedAt: new Date().toISOString() };
  }

  async #executeMutation(command: FirmwareMutationCommand): Promise<void> {
    if (command === 'output off') this.#outputOffUnconfirmed = true;
    const response = await this.#ready().execute(command);
    assertMutationAcknowledged(response, command);
    if (command === 'output off') this.#outputOffUnconfirmed = false;
  }

  #ready(): CommandScheduler {
    if (!this.#scheduler) throw new Error('Device is not connected');
    return this.#scheduler;
  }

  #requireReadyIdentity(): DeviceIdentity {
    if (this.#snapshot.connection !== 'ready' || !this.#snapshot.identity) throw new Error('A ready exact ZS407 connection is required');
    return this.#snapshot.identity;
  }

  #handleTransportEvent(event: TransportEvent): void {
    if (event.type === 'opened' || this.#closing || this.#snapshot.connection === 'disconnected') return;
    const reason = event.type === 'error' ? event.error.message : event.reason ?? 'USB serial transport closed unexpectedly';
    this.#scheduler?.dispose();
    this.#scheduler = undefined;
    this.#outputOffUnconfirmed = true;
    this.#snapshot = { connection: 'faulted', fault: reason };
  }
}

export function bindCurrentExactCandidate(selected: PortCandidate, current: readonly PortCandidate[]): PortCandidate {
  if (selected.usbMatch !== 'exact-zs407-cdc'
    || selected.vendorId?.toLowerCase() !== TINYSA_USB_VENDOR_ID
    || selected.productId?.toLowerCase() !== TINYSA_USB_PRODUCT_ID) {
    throw new Error('Firmware operations require exact USB 0483:5740 admission');
  }
  const pathMatches = current.filter((candidate) => candidate.path === selected.path);
  if (pathMatches.length !== 1) throw new Error(`Selected USB path is stale or ambiguous: ${selected.path}`);
  const live = pathMatches[0]!;
  if (live.usbMatch !== 'exact-zs407-cdc'
    || live.vendorId?.toLowerCase() !== TINYSA_USB_VENDOR_ID
    || live.productId?.toLowerCase() !== TINYSA_USB_PRODUCT_ID) {
    throw new Error('Selected USB path no longer exposes exact 0483:5740 identity');
  }
  if (selected.serialNumber && live.serialNumber !== selected.serialNumber) throw new Error('Selected USB serial no longer matches the current device');
  if (selected.id !== live.id) throw new Error('Selected device token is stale; scan USB devices again');
  return live;
}

export function parseIdentity(versionResponse: string, infoResponse: string, port: PortCandidate): DeviceIdentity {
  const versionLines = nonEmptyLines(versionResponse);
  const infoLines = nonEmptyLines(infoResponse);
  const firmwareVersion = versionLines[0];
  const hardwareLine = versionLines.find((line) => /^HW Version:/i.test(line));
  if (!firmwareVersion || !/^tinySA4_/i.test(firmwareVersion)) throw new Error('Connected serial device did not identify as tinySA4 firmware');
  if (!infoLines.some((line) => /tinySA/i.test(line))) throw new Error('tinySA info response is incomplete');
  const infoIdentifiesZs407 = infoLines.some((line) => /^tinySA\s+ULTRA\+\s+ZS407$/i.test(line));
  if (!hardwareLine || (!/ZS407/i.test(hardwareLine) && !infoIdentifiesZs407)) throw new Error(`Connected tinySA4 is not a ZS407: ${hardwareLine ?? 'hardware line missing'}`);
  if (port.usbMatch !== 'exact-zs407-cdc') throw new Error('Physical sessions require exact 0483:5740 USB identity');
  const revision = firmwareVersion.match(/-g([0-9a-f]{7,40})$/i)?.[1]?.toLowerCase();
  if (!revision) throw new Error(`Firmware ${firmwareVersion} did not report a source revision`);
  const recognizedOemFirmware = lookupSupportedZs407OemFirmware(firmwareVersion);
  const firmwareSourceCommit = recognizedOemFirmware?.revision === revision ? recognizedOemFirmware.sourceCommit : undefined;
  return {
    model: 'tinySA Ultra+ ZS407',
    hardwareVersion: hardwareLine.replace(/^HW Version:\s*/i, '').trim(),
    firmwareVersion,
    firmwareReportedRevision: revision,
    ...(firmwareSourceCommit ? { firmwareSourceCommit } : {}),
    firmwareQualification: firmwareSourceCommit ? 'supported-oem' : 'custom-unqualified',
    ...(!firmwareSourceCommit ? { firmwareWarning: `Custom firmware revision ${revision} is admitted only as device identity. Flasher has not qualified or recovered the installed bytes, so this identity cannot prove an exact installed image or serve as a flash artifact. A separately admitted OEM release or manifested local build may still start an update transaction.` } : {}),
    port,
    usbIdentityVerified: true,
  };
}

export function parseHelpCommands(response: string): readonly string[] {
  const lines = nonEmptyLines(response);
  if (lines.length !== 2) {
    throw new Error('Malformed help catalog: expected exactly commands and Other commands lines');
  }
  const primary = parseHelpCatalogLine(lines[0]!, 'commands');
  const secondary = parseHelpCatalogLine(lines[1]!, 'Other commands');
  const commands = [...primary, ...secondary];
  if (!commands.length) throw new Error('help response contained no command catalog');
  if (new Set(commands).size !== commands.length) {
    throw new Error('Malformed help catalog: a command was declared more than once');
  }
  return commands.sort();
}

function parseHelpCatalogLine(line: string, header: 'commands' | 'Other commands'): readonly string[] {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.match(new RegExp(`^${escapedHeader}:((?: [a-z][a-z0-9_]*)*)$`));
  if (!match) throw new Error(`Malformed help catalog ${header} line`);
  return match[1] ? match[1].slice(1).split(' ') : [];
}

function requireCommands(commands: readonly string[]): void {
  const missing = REQUIRED_COMMANDS.filter((command) => !commands.includes(command));
  if (missing.length) throw new Error(`ZS407 firmware is missing required commands: ${missing.join(', ')}`);
}

export function parseBattery(response: string): number {
  const value = Number(response.trim().match(/^(\d+)\s*mV$/i)?.[1]);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`Malformed battery readback: ${response}`);
  return value;
}

export function parseDeviceId(response: string): number {
  const value = Number(response.trim().match(/^deviceid\s+(\d+)$/i)?.[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Malformed device ID readback: ${response}`);
  return value;
}

function assertMutationAcknowledged(response: string, command: string): void {
  if (response.length === 0) return;
  const firstLine = response.replaceAll('\r', '').split('\n')[0]!.slice(0, 160);
  throw new Error(`Firmware rejected command ${command}: mutating commands require an empty reply, received ${JSON.stringify(firstLine)}`);
}

function nonEmptyLines(value: string): string[] { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
