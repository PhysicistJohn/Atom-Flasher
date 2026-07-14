import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  OEM_ZS407_SELF_TEST_PROCEDURE,
  initialFirmwareUpdateState,
  type DeviceSnapshot,
  type FirmwareUpdatePreflight,
  type FirmwareUpdateState,
  type PortCandidate,
} from '../core/contracts.js';

export function App() {
  const [devices, setDevices] = useState<readonly PortCandidate[]>([]);
  const [device, setDevice] = useState<DeviceSnapshot>({ connection: 'disconnected' });
  const [update, setUpdate] = useState<FirmwareUpdateState>(initialFirmwareUpdateState());
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [preflight, setPreflight] = useState<Partial<FirmwareUpdatePreflight>>({});

  const refresh = useCallback(async () => {
    const [nextDevices, nextDevice, nextUpdate] = await Promise.all([
      window.tinySaFlasher.listDevices(),
      window.tinySaFlasher.deviceState(),
      window.tinySaFlasher.updateState(),
    ]);
    setDevices(nextDevices);
    setDevice(nextDevice);
    setUpdate(nextUpdate);
  }, []);

  useEffect(() => {
    void refresh().catch((value) => setError(message(value)));
    const timer = window.setInterval(() => {
      void Promise.all([window.tinySaFlasher.deviceState(), window.tinySaFlasher.updateState()])
        .then(([nextDevice, nextUpdate]) => { setDevice(nextDevice); setUpdate(nextUpdate); })
        .catch((value) => setError(message(value)));
    }, 750);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = useCallback(async <T,>(label: string, operation: () => Promise<T>, apply?: (value: T) => void) => {
    setBusy(label);
    setError(undefined);
    try {
      const value = await operation();
      apply?.(value);
      await refresh();
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  const exactDevices = useMemo(() => devices.filter((candidate) => candidate.usbMatch === 'exact-zs407-cdc'), [devices]);
  const unverifiedDevices = useMemo(() => devices.filter((candidate) => candidate.usbMatch !== 'exact-zs407-cdc'), [devices]);
  const preflightReady = preflight.selfTestPassed === true
    && preflight.selfTestProcedure === OEM_ZS407_SELF_TEST_PROCEDURE.id
    && preflight.rfPortsDisconnected === true
    && preflight.onlyUsbDeviceConnected === true
    && Boolean(preflight.configurationDisposition);
  const hasPreparedSession = Boolean(update.preparation);
  const connecting = busy === 'connect';
  const deviceFaulted = device.connection === 'faulted';

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand-mark" aria-hidden="true"><i/><i/><i/></div>
      <div><span className="eyebrow">PHYSICISTJOHN · DEVICE UTILITY</span><h1>TinySA Flasher</h1></div>
      <span className={`status-chip ${device.connection === 'ready' ? 'ready' : ''}`}><i/>{device.connection === 'ready' ? 'ZS407 verified' : deviceFaulted ? 'Serial safety fault' : hasPreparedSession ? 'Update session active' : 'No verified device'}</span>
    </header>

    <section className="safety-strip"><strong>FAIL-CLOSED</strong><span>Exact image · exact USB identity · one DFU target · durable write journal</span></section>

    {error && <div className="error-banner" role="alert"><strong>Operation stopped safely</strong><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error">×</button></div>}

    {deviceFaulted && <section className="panel fault-panel" role="alert">
      <PanelHeading step="!" title="Serial safety fault" detail="The live USB session is no longer trusted, so firmware controls are disabled."/>
      <p>{device.fault ?? 'The serial transport faulted without a diagnostic message.'}</p>
      <div className="danger-note"><strong>RF OUTPUT MAY BE UNCONFIRMED</strong><span>If retry cannot confirm a safe disconnect, power the analyzer off manually before handling RF connections.</span></div>
      <button className="secondary strong" disabled={Boolean(busy)} onClick={() => void run('disconnect', () => window.tinySaFlasher.disconnectDevice(), setDevice)}>{busy === 'disconnect' ? 'Retrying…' : 'Retry safe disconnect'}</button>
    </section>}

    {!hasPreparedSession && device.connection === 'disconnected' && update.phase !== 'failed' && <section className="panel discovery-panel">
      <PanelHeading step="01" title="Connect the analyzer" detail="Only an exact USB 0483:5740 ZS407 can enter the update workflow."/>
      <div className="device-list">
        {exactDevices.map((candidate) => <article className="device-card exact" key={candidate.id}>
          <div className="usb-icon">USB</div>
          <div><strong>tinySA Ultra+ candidate</strong><span>{candidate.path}</span><small>0483:5740 · {candidate.serialNumber ? `serial ${candidate.serialNumber}` : 'CDC serial unavailable'}</small></div>
          <button disabled={Boolean(busy)} onClick={() => void run('connect', () => window.tinySaFlasher.connectDevice(candidate), setDevice)}>{connecting ? 'Verifying…' : 'Connect & verify'}</button>
        </article>)}
        {!exactDevices.length && <div className="empty-device"><span>⌁</span><strong>No exact ZS407 found</strong><p>Connect the tinySA Ultra / Ultra+ directly over USB, power it on, then scan again.</p></div>}
        {unverifiedDevices.map((candidate) => <article className="device-card rejected" key={candidate.id}>
          <div className="usb-icon">USB</div><div><strong>Rejected serial device</strong><span>{candidate.path}</span><small>{candidate.vendorId ?? '????'}:{candidate.productId ?? '????'} · not eligible</small></div><em>BLOCKED</em>
        </article>)}
      </div>
      <button className="secondary" disabled={Boolean(busy)} onClick={() => void run('refresh', refresh)}>Scan USB devices</button>
    </section>}

    {device.connection === 'ready' && <section className="connected-bar">
      <div><span className="verified-dot">✓</span><div><strong>{device.identity?.model}</strong><small>{device.identity?.firmwareVersion} · device {device.telemetry?.deviceId} · {device.telemetry?.batteryMillivolts} mV</small></div></div>
      {!hasPreparedSession && <button className="quiet" disabled={Boolean(busy)} onClick={() => void run('disconnect', () => window.tinySaFlasher.disconnectDevice(), setDevice)}>Disconnect</button>}
    </section>}

    {(device.connection === 'ready' || hasPreparedSession || update.phase === 'failed') && <section className="panel workflow-panel">
      <div className="route" aria-label="Firmware update progress">
        <RouteStep index="1" label="Verify" active={['available', 'downloading'].includes(update.phase)} complete={Boolean(update.artifact)}/>
        <RouteStep index="2" label="Preflight" active={update.phase === 'verified'} complete={Boolean(update.preparation)}/>
        <RouteStep index="3" label="DFU" active={update.phase === 'awaiting-dfu'} complete={update.dfuDevice.detected}/>
        <RouteStep index="4" label="Flash" active={['ready-to-flash', 'flashing', 'reconnecting'].includes(update.phase)} complete={update.phase === 'completed'}/>
      </div>

      <div className="release-card">
        <div><small>INSTALLED</small><strong>{update.current?.version ?? device.identity?.firmwareVersion ?? 'Recorded at preflight'}</strong></div>
        <span>→</span>
        <div><small>PINNED TARGET</small><strong>{update.target.version}</strong></div>
      </div>

      {(update.phase === 'available' || update.phase === 'downloading') && <Stage title={update.phase === 'downloading' ? 'Downloading and verifying' : 'Pinned update available'} icon="↓">
        <p>The OEM host uses HTTP. TinySA Flasher retains the image only after both its exact {update.target.sizeBytes.toLocaleString()}-byte length and pinned SHA-256 match.</p>
        <Facts update={update}/>
        <button className="primary" disabled={Boolean(busy) || device.connection !== 'ready'} onClick={() => void run('download', () => window.tinySaFlasher.download(), setUpdate)}>{busy === 'download' ? 'Downloading…' : 'Download & verify exact image'}</button>
      </Stage>}

      {update.phase === 'verified' && <Stage title="Physical preflight" icon="✓">
        <p>Run the on-device self-test before disconnecting the analyzer. The ZS407 uses the connectors labeled <code>CAL</code> and <code>RF</code>.</p>
        <ol className="instructions">
          <li>Confirm RF output is off. Connect one short 50 Ω coax cable from <code>CAL</code> to <code>RF</code>.</li>
          <li>Open <code>CONFIG → SELF TEST</code> and let every test finish.</li>
          <li>Confirm it passed, exit, then remove the cable and every RF connection.</li>
        </ol>
        <a href={OEM_ZS407_SELF_TEST_PROCEDURE.guideUrl} target="_blank" rel="noreferrer">Open the OEM Ultra / Ultra+ menu guide ↗</a>
        <div className="checks">
          <Check checked={preflight.selfTestPassed === true} label="CAL↔RF self-test passed" onChange={(checked) => setPreflight((value) => {
            const next = { ...value };
            if (checked) { next.selfTestPassed = true; next.selfTestProcedure = OEM_ZS407_SELF_TEST_PROCEDURE.id; }
            else { delete next.selfTestPassed; delete next.selfTestProcedure; }
            return next;
          })}/>
          <Check checked={preflight.rfPortsDisconnected === true} label="CAL and RF connectors are disconnected" onChange={(checked) => setPreflight((value) => {
            const next = { ...value };
            if (checked) next.rfPortsDisconnected = true; else delete next.rfPortsDisconnected;
            return next;
          })}/>
          <Check checked={preflight.onlyUsbDeviceConnected === true} label="This tinySA is the only device connected for the update" onChange={(checked) => setPreflight((value) => {
            const next = { ...value };
            if (checked) next.onlyUsbDeviceConnected = true; else delete next.onlyUsbDeviceConnected;
            return next;
          })}/>
          <label className="select-field"><span>Configuration disposition</span><select value={preflight.configurationDisposition ?? ''} onChange={(event) => setPreflight((value) => {
            const next = { ...value };
            if (event.target.value) next.configurationDisposition = event.target.value as FirmwareUpdatePreflight['configurationDisposition'];
            else delete next.configurationDisposition;
            return next;
          })}><option value="">Choose…</option><option value="new-device-unchanged">New device · no calibration changes</option><option value="backup-complete-and-recalibration-accepted">Backup complete · recalibration accepted</option></select></label>
        </div>
        <div className="hash-proof"><span>IMAGE VERIFIED</span><code>{update.artifact?.sha256}</code></div>
        <button className="primary" disabled={Boolean(busy) || !preflightReady || device.connection !== 'ready'} onClick={() => {
          if (!preflightReady) return;
          const complete = preflight as FirmwareUpdatePreflight;
          void run('prepare', () => window.tinySaFlasher.prepare(complete), setUpdate);
        }}>{busy === 'prepare' ? 'Recording…' : 'Record preflight & disconnect'}</button>
      </Stage>}

      {update.phase === 'awaiting-dfu' && <Stage title="Enter STM32 DFU mode" icon="USB">
        <ol className="instructions"><li>Switch the tinySA Ultra+ off.</li><li>Press and hold the jog button.</li><li>Switch it on; the display must remain black.</li><li>Keep only the update USB connection in place.</li></ol>
        <div className={`prerequisite ${update.dfuUtility.available ? 'good' : ''}`}><strong>{update.dfuUtility.available ? `dfu-util ${update.dfuUtility.version}` : 'dfu-util 0.11 required'}</strong><span>{update.dfuUtility.available ? 'Exact flashing engine ready' : 'Install with: brew install dfu-util'}</span></div>
        {update.continuityWarning && <p className="continuity-note">{update.continuityWarning}</p>}
        {update.dfuUtility.available
          ? <button className="secondary strong" disabled={Boolean(busy) || deviceFaulted} onClick={() => void run('detect', () => window.tinySaFlasher.detectDfu(), setUpdate)}>{busy === 'detect' ? 'Inspecting…' : 'Check exact DFU target'}</button>
          : <button className="secondary strong" disabled={Boolean(busy)} onClick={() => void run('prerequisites', () => window.tinySaFlasher.refreshPrerequisites(), setUpdate)}>{busy === 'prerequisites' ? 'Checking…' : 'Re-check dfu-util installation'}</button>}
      </Stage>}

      {update.phase === 'ready-to-flash' && <Stage title="One exact DFU target is ready" icon="!">
        <p>The target identity is journaled. It will be enumerated again immediately before the write, and TinySA Flasher will pass its exact path and serial to dfu-util.</p>
        <div className="identity-proof"><span>DFU PATH <code>{update.dfuDevice.identity?.path}</code></span><span>SERIAL <code>{update.dfuDevice.identity?.serial}</code></span><span>ALT <code>0 · Internal Flash</code></span></div>
        <div className="danger-note"><strong>Final physical boundary</strong><span>A native confirmation appears next. Do not disconnect USB or power until post-reboot verification finishes.</span></div>
        <button className="danger" disabled={Boolean(busy) || deviceFaulted} onClick={() => {
          const id = update.preparation?.id;
          if (!id) return;
          void run('flash', () => window.tinySaFlasher.flash(id), (result) => setUpdate(result.state));
        }}>{busy === 'flash' ? 'Writing and verifying…' : 'Flash verified OEM firmware'}</button>
      </Stage>}

      {(update.phase === 'flashing' || update.phase === 'reconnecting') && <Stage title={update.phase === 'flashing' ? 'Writing firmware — do not disconnect' : 'Write complete — verifying reboot'} icon="◌">
        <p>Closing TinySA Flasher is blocked. A slow dfu-util process is observed until it exits; the app does not terminate a write at its expected-duration boundary.</p>
        <Progress update={update}/>
      </Stage>}

      {update.phase === 'completed' && <Stage title="Firmware verified after reboot" icon="✓">
        <p>The preflight device returned with matching device identity and reported the pinned target source revision. The completed active journal has been archived into the device/preparation ledger.</p>
        <div className="complete-card"><strong>Update complete</strong><span>{update.completedAt}</span></div>
      </Stage>}

      {update.phase === 'up-to-date' && <Stage title="Firmware is current" icon="✓"><p>The connected ZS407 already reports the exact pinned OEM release. No write is offered.</p><Facts update={update}/></Stage>}

      {update.phase === 'custom-firmware' && <Stage title="Custom firmware session" icon="!"><p>{update.warning}</p><p>TinySA Flasher will not invent OEM provenance or enable a pinned OEM write from an unqualified build.</p></Stage>}

      {update.phase === 'failed' && <Stage title={update.writeDisposition === 'not-started' ? 'Update stopped safely' : 'Manual inspection required'} icon="!" danger>
        <p>{update.error}</p>
        {update.writeDisposition !== 'not-started' && <div className="danger-note"><strong>DO NOT FLASH AGAIN</strong><span>The durable record says a write started, completed without verification, or is indeterminate. Inspect the journal and physical device manually.</span></div>}
        {update.writeDisposition === 'not-started' && update.preparation && <button className="secondary strong" disabled={Boolean(busy) || deviceFaulted} onClick={() => void run('detect', () => window.tinySaFlasher.detectDfu(), setUpdate)}>Re-check DFU state</button>}
        {update.writeDisposition === 'not-started' && !update.preparation && update.updateAvailable && <button className="secondary strong" disabled={Boolean(busy) || device.connection !== 'ready'} onClick={() => void run('download', () => window.tinySaFlasher.download(), setUpdate)}>Retry download & verification</button>}
      </Stage>}
    </section>}

    <footer><span>STANDALONE · NO TINYSA REPOSITORY DEPENDENCY</span><span>NO AUTOMATIC FLASH</span></footer>
  </main>;
}

function PanelHeading({ step, title, detail }: { step: string; title: string; detail: string }) { return <div className="panel-heading"><span>{step}</span><div><h2>{title}</h2><p>{detail}</p></div></div>; }
function RouteStep({ index, label, active, complete }: { index: string; label: string; active: boolean; complete: boolean }) { return <div className={`${active ? 'active' : ''} ${complete ? 'complete' : ''}`}><i>{complete ? '✓' : index}</i><span>{label}</span></div>; }
function Stage({ title, icon, children, danger = false }: { title: string; icon: string; children: ReactNode; danger?: boolean }) { return <div className={`stage ${danger ? 'stage-danger' : ''}`}><div className="stage-title"><span>{icon}</span><h2>{title}</h2></div>{children}</div>; }
function Check({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) { return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)}/><i>{checked ? '✓' : ''}</i><span>{label}</span></label>; }
function Facts({ update }: { update: FirmwareUpdateState }) { return <div className="facts"><span><small>SIZE</small><strong>{update.target.sizeBytes.toLocaleString()} bytes</strong></span><span><small>REVISION</small><strong>{update.target.revision}</strong></span><span><small>SHA-256</small><strong>{update.target.sha256.slice(0, 14)}…</strong></span></div>; }
function Progress({ update }: { update: FirmwareUpdateState }) { const percent = update.flashProgress?.percent ?? 0; return <div className="progress"><div><strong>{update.flashProgress?.stage.replaceAll('-', ' ') ?? 'starting'}</strong><span>{percent}%</span></div><div role="progressbar" aria-label="Firmware write progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${Math.max(2, percent)}%` }}/></div></div>; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
