import { useEffect, useState, type ReactNode } from 'react';
import {
  OEM_ZS407_SELF_TEST_PROCEDURE,
  type FirmwareUpdatePreflight,
  type FirmwareUpdateState,
} from '../core/contracts.js';
import { AtomicMark } from './AtomicMark.js';
import { useFlasherApplication } from './use-flasher-application.js';

export function App() {
  const controller = useFlasherApplication();
  const [preflight, setPreflight] = useState<Partial<FirmwareUpdatePreflight>>({});
  const { snapshot, busy, error, run, dismissError } = controller;
  const preflightBinding = snapshot
    ? `${snapshot.device.connectedAt ?? snapshot.device.connection}:${JSON.stringify(snapshot.update.target)}`
    : undefined;
  useEffect(() => { setPreflight({}); }, [preflightBinding]);
  if (!snapshot) return <main className="app-shell">
    <AppHeader status="Starting safely"/>
    <div className="app-content"><section className="panel loading-panel"><h2>Preparing Flasher</h2><p>{error ?? 'Initializing the fail-closed firmware evidence boundary…'}</p></section></div>
  </main>;
  const devices = snapshot.discovery.candidates;
  const device = snapshot.device;
  const update = snapshot.update;

  const exactDevices = devices.filter((candidate) => candidate.usbMatch === 'exact-zs407-cdc');
  const unverifiedDevices = devices.filter((candidate) => candidate.usbMatch !== 'exact-zs407-cdc');
  const preflightReady = preflight.selfTestPassed === true
    && preflight.selfTestProcedure === OEM_ZS407_SELF_TEST_PROCEDURE.id
    && preflight.rfPortsDisconnected === true
    && preflight.onlyUsbDeviceConnected === true
    && Boolean(preflight.configurationDisposition);
  const hasPreparedSession = Boolean(update.preparation);
  const connecting = busy === 'connect';
  const deviceFaulted = device.connection === 'faulted';
  const headerStatus = device.connection === 'ready'
    ? 'ZS407 verified'
    : deviceFaulted
      ? 'Serial safety fault'
      : hasPreparedSession
        ? 'Update session active'
        : 'No verified device';

  return <main className="app-shell">
    <AppHeader status={headerStatus} ready={device.connection === 'ready'}/>
    <div className="app-content">

    <section className="safety-strip"><strong>FAIL-CLOSED</strong><span>Exact image · exact USB identity · one DFU target · durable write journal</span></section>

    {error && <div className="error-banner" role="alert"><strong>Operation stopped safely</strong><span>{error}</span><button onClick={dismissError} aria-label="Dismiss error">×</button></div>}

    {deviceFaulted && <section className="panel fault-panel" role="alert">
      <PanelHeading step="!" title="Serial safety fault" detail="The live USB session is no longer trusted, so firmware controls are disabled."/>
      <p>{device.fault ?? 'The serial transport faulted without a diagnostic message.'}</p>
      <div className="danger-note"><strong>RF OUTPUT MAY BE UNCONFIRMED</strong><span>If retry cannot confirm a safe disconnect, power the analyzer off manually before handling RF connections.</span></div>
      <button className="secondary strong" disabled={Boolean(busy)} onClick={() => void run('disconnect', () => window.tinySaFlasher.disconnectDevice())}>{busy === 'disconnect' ? 'Retrying…' : 'Retry safe disconnect'}</button>
      <button className="secondary" disabled={Boolean(busy)} onClick={() => void run('recover', () => window.tinySaFlasher.recoverDevice())}>{busy === 'recover' ? 'Waiting for confirmation…' : 'Resolve after physical power-off…'}</button>
    </section>}

    {!hasPreparedSession && device.connection === 'disconnected' && (snapshot.allowedActions.scanDevices || snapshot.allowedActions.connectDevice) && <section className="panel discovery-panel">
      <PanelHeading step="01" title="Connect the analyzer" detail="Close or disconnect Atomizer first. Only an exact USB 0483:5740 ZS407 can enter this update session."/>
      <div className="device-list">
        {exactDevices.map((candidate) => <article className="device-card exact" key={candidate.id}>
          <div className="usb-icon">USB</div>
          <div><strong>tinySA Ultra+ candidate</strong><span>{candidate.path}</span><small>0483:5740 · {candidate.serialNumber ? `serial ${candidate.serialNumber}` : 'CDC serial unavailable'}</small></div>
          <button disabled={Boolean(busy) || !snapshot.allowedActions.connectDevice} onClick={() => void run('connect', () => window.tinySaFlasher.connectDevice(candidate))}>{connecting ? 'Verifying…' : 'Connect & verify'}</button>
        </article>)}
        {!exactDevices.length && <div className="empty-device"><span>⌁</span><strong>No exact ZS407 found</strong><p>Connect the tinySA Ultra / Ultra+ directly over USB, power it on, then scan again.</p></div>}
        {unverifiedDevices.map((candidate) => <article className="device-card rejected" key={candidate.id}>
          <div className="usb-icon">USB</div><div><strong>Rejected serial device</strong><span>{candidate.path}</span><small>{candidate.vendorId ?? '????'}:{candidate.productId ?? '????'} · not eligible</small></div><em>BLOCKED</em>
        </article>)}
      </div>
      <button className="secondary" disabled={Boolean(busy)} onClick={() => void run('refresh', () => window.tinySaFlasher.scanDevices())}>Scan USB devices</button>
    </section>}

    {device.connection === 'ready' && <section className="connected-bar">
      <div><span className="verified-dot">✓</span><div><strong>{device.identity?.model}</strong><small>{device.identity?.firmwareVersion} · device {device.telemetry?.deviceId} · {device.telemetry?.batteryMillivolts} mV</small></div></div>
      {!hasPreparedSession && <button className="quiet" disabled={Boolean(busy)} onClick={() => void run('disconnect', () => window.tinySaFlasher.disconnectDevice())}>Disconnect</button>}
    </section>}

    {device.connection === 'ready' && !hasPreparedSession && <section className="panel target-panel">
      <PanelHeading step="02" title="Choose the firmware target" detail="OEM restore and manifested local builds use the same preflight, DFU admission, durable evidence, and exact post-reboot verification."/>
      <div className="release-card">
        <div><small>SELECTED TARGET</small><strong>{update.target.kind === 'oem' ? 'Pinned OEM release' : 'Manifested local custom build'}</strong></div>
        <span>·</span>
        <div><small>VERSION</small><strong>{update.target.version}</strong></div>
      </div>
      {update.target.kind === 'local-custom' && <div className="danger-note"><strong>LOCAL CUSTOM FIRMWARE</strong><span>{update.target.hardwareQualification === 'qualified' ? 'The build manifest declares hardware qualification.' : 'The build manifest declares this build hardware-unqualified.'} This is never treated as OEM provenance, and matching device version/revision text does not prove the installed bytes. The manifest and binary are copied into content-addressed app storage and reverified before any write.</span></div>}
      <div className="target-actions">
        <button className="secondary strong" disabled={Boolean(busy) || !snapshot.allowedActions.selectLocalFirmwareTarget} onClick={() => void run('select-custom', () => window.tinySaFlasher.selectLocalFirmwareTarget())}>{busy === 'select-custom' ? 'Verifying manifest…' : 'Select TinySA_Firmware build…'}</button>
        {update.target.kind === 'local-custom' && <button className="secondary" disabled={Boolean(busy) || !snapshot.allowedActions.selectOemTarget} onClick={() => void run('select-oem', () => window.tinySaFlasher.selectOemTarget())}>{busy === 'select-oem' ? 'Selecting…' : 'Use pinned OEM target'}</button>}
      </div>
      <p className="target-boundary-note">Selection uses a native file picker. No filesystem path is accepted from or returned to the renderer.</p>
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
        <div><small>{update.target.kind === 'oem' ? 'PINNED OEM TARGET' : 'LOCAL CUSTOM TARGET'}</small><strong>{update.target.version}</strong></div>
      </div>

      {(update.phase === 'available' || update.phase === 'downloading') && <Stage title={update.phase === 'downloading' ? 'Downloading and verifying' : 'Pinned update available'} icon="↓">
        <p>The OEM host uses HTTP. Flasher retains the image only after both its exact {update.target.sizeBytes.toLocaleString()}-byte length and pinned SHA-256 match.</p>
        <Facts update={update}/>
        <button className="primary" disabled={Boolean(busy) || !snapshot.allowedActions.download} onClick={() => void run('download', () => window.tinySaFlasher.download())}>{busy === 'download' ? 'Downloading…' : 'Download & verify exact image'}</button>
      </Stage>}

      {update.phase === 'verified' && <Stage title="Physical preflight" icon="✓">
        {update.target.kind === 'local-custom' && <div className="danger-note"><strong>Custom target selected</strong><span>Source {update.target.sourceCommit.slice(0, 12)}… · manifest {update.target.manifestSha256.slice(0, 12)}… · {update.target.hardwareQualification === 'qualified' ? 'hardware qualification declared' : 'hardware unqualified'}.</span></div>}
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
        <button className="primary" disabled={Boolean(busy) || !preflightReady || !snapshot.allowedActions.prepare} onClick={() => {
          if (!preflightReady) return;
          const complete = preflight as FirmwareUpdatePreflight;
          void run('prepare', () => window.tinySaFlasher.prepare(complete));
        }}>{busy === 'prepare' ? 'Recording…' : 'Record preflight & disconnect'}</button>
      </Stage>}

      {update.phase === 'awaiting-dfu' && <Stage title="Enter STM32 DFU mode" icon="USB">
        {update.target.kind === 'local-custom' && <button className="secondary" disabled={Boolean(busy) || !snapshot.allowedActions.selectLocalFirmwareTarget} onClick={() => void run('select-custom', () => window.tinySaFlasher.selectLocalFirmwareTarget())}>{busy === 'select-custom' ? 'Reverifying…' : 'Re-admit exact custom build manifest…'}</button>}
        <ol className="instructions"><li>Switch the tinySA Ultra+ off.</li><li>Press and hold the jog button.</li><li>Switch it on; the display must remain black.</li><li>Keep only the update USB connection in place.</li></ol>
        <div className={`prerequisite ${update.dfuUtility.available ? 'good' : ''}`}><strong>{update.dfuUtility.available ? `dfu-util ${update.dfuUtility.version}` : 'dfu-util 0.11 required'}</strong><span>{update.dfuUtility.available ? 'Exact flashing engine ready' : 'Install with: brew install dfu-util'}</span></div>
        {update.continuityWarning && <p className="continuity-note">{update.continuityWarning}</p>}
        {update.dfuUtility.available
          ? <button className="secondary strong" disabled={Boolean(busy) || !snapshot.allowedActions.detectDfu} onClick={() => void run('detect', () => window.tinySaFlasher.detectDfu())}>{busy === 'detect' ? 'Inspecting…' : 'Check exact DFU target'}</button>
          : <button className="secondary strong" disabled={Boolean(busy) || !snapshot.allowedActions.refreshPrerequisites} onClick={() => void run('prerequisites', () => window.tinySaFlasher.refreshPrerequisites())}>{busy === 'prerequisites' ? 'Checking…' : 'Re-check dfu-util installation'}</button>}
      </Stage>}

      {update.phase === 'ready-to-flash' && <Stage title="One exact DFU target is ready" icon="!">
        <p>The target identity is journaled. It will be enumerated again immediately before the write. Flasher binds dfu-util to that exact USB path and serial, and supplies firmware only through the same open descriptor that was verified.</p>
        <div className="identity-proof"><span>DFU PATH <code>{update.dfuDevice.identity?.path}</code></span><span>SERIAL <code>{update.dfuDevice.identity?.serial}</code></span><span>ALT <code>0 · Internal Flash</code></span></div>
        <div className="danger-note"><strong>Final physical boundary</strong><span>A native confirmation appears next. Do not disconnect USB or power until post-reboot verification finishes.</span></div>
        <button className="danger" disabled={Boolean(busy) || !snapshot.allowedActions.flash} onClick={() => {
          const id = update.preparation?.id;
          if (!id) return;
          void run('flash', () => window.tinySaFlasher.flash(id));
        }}>{busy === 'flash' ? 'Writing and verifying…' : writeButtonLabel(update)}</button>
      </Stage>}

      {(update.phase === 'flashing' || update.phase === 'reconnecting') && <Stage title={update.phase === 'flashing' ? 'Writing firmware — do not disconnect' : 'Write complete — verifying reboot'} icon="◌">
        <p>Closing Flasher is blocked. A slow dfu-util process is observed until it exits; the app does not terminate a write at its expected-duration boundary.</p>
        <Progress update={update}/>
      </Stage>}

      {update.phase === 'completed' && <Stage title="Firmware verified after reboot" icon="✓">
        <p>The preflight device returned with matching device identity and reported the exact selected target version and revision. The completed active journal has been archived into the device/preparation ledger.</p>
        <div className="complete-card"><strong>Update complete</strong><span>{update.completedAt}</span></div>
      </Stage>}

      {update.phase === 'up-to-date' && <Stage title="Selected firmware is already installed" icon="✓"><p>The connected ZS407 already reports the exact pinned OEM release. No write is offered. A matching custom version/revision label alone never proves the installed bytes.</p><Facts update={update}/></Stage>}

      {update.phase === 'custom-firmware' && <Stage title="Legacy custom firmware observation" icon="!"><p>{update.warning}</p><p>Select the pinned OEM target to restore OEM firmware, or select an exact manifested TinySA_Firmware build. No provenance is inferred from the device label.</p></Stage>}

      {update.phase === 'failed' && <Stage title={update.writeDisposition === 'not-started' ? 'Update stopped safely' : 'Manual inspection required'} icon="!" danger>
        <p>{update.error}</p>
        {update.writeDisposition !== 'not-started' && <div className="danger-note"><strong>DO NOT FLASH AGAIN</strong><span>The durable record says a write started, completed without verification, or is indeterminate. Inspect the journal and physical device manually.</span></div>}
        {update.writeDisposition === 'not-started' && !update.preparation && update.target.kind === 'local-custom' && device.connection === 'disconnected' && snapshot.allowedActions.selectOemTarget && <button className="secondary strong" disabled={Boolean(busy)} onClick={() => void run('select-oem', () => window.tinySaFlasher.selectOemTarget())}>{busy === 'select-oem' ? 'Selecting…' : 'Abandon custom target and use pinned OEM target'}</button>}
        {update.writeDisposition === 'not-started' && update.preparation && update.target.kind === 'local-custom' && <button className="secondary strong" disabled={Boolean(busy) || !snapshot.allowedActions.selectLocalFirmwareTarget} onClick={() => void run('select-custom', () => window.tinySaFlasher.selectLocalFirmwareTarget())}>{busy === 'select-custom' ? 'Reverifying…' : 'Re-admit exact custom build manifest…'}</button>}
        {update.writeDisposition === 'not-started' && update.preparation && <button className="secondary strong" disabled={Boolean(busy) || !snapshot.allowedActions.detectDfu} onClick={() => void run('detect', () => window.tinySaFlasher.detectDfu())}>Re-check DFU state</button>}
        {update.writeDisposition === 'not-started' && !update.preparation && update.target.kind === 'oem' && update.updateAvailable && <button className="secondary strong" disabled={Boolean(busy) || !snapshot.allowedActions.download} onClick={() => void run('download', () => window.tinySaFlasher.download())}>Retry download & verification</button>}
      </Stage>}
    </section>}

    <footer><span>STANDALONE · NO TINYSA REPOSITORY DEPENDENCY</span><span>NO AUTOMATIC FLASH</span></footer>
    </div>
  </main>;
}

function AppHeader({ status, ready = false }: { status: string; ready?: boolean }) {
  return <header className="app-header">
    <div className="brand-lockup">
      <div className="brand-symbol"><AtomicMark size={29}/></div>
      <div><small>AtomOS</small><strong>Flasher</strong></div>
    </div>
    <span className={`status-chip ${ready ? 'ready' : ''}`}><i/>{status}</span>
  </header>;
}

function PanelHeading({ step, title, detail }: { step: string; title: string; detail: string }) { return <div className="panel-heading"><span>{step}</span><div><h2>{title}</h2><p>{detail}</p></div></div>; }
function RouteStep({ index, label, active, complete }: { index: string; label: string; active: boolean; complete: boolean }) { return <div className={`${active ? 'active' : ''} ${complete ? 'complete' : ''}`}><i>{complete ? '✓' : index}</i><span>{label}</span></div>; }
function Stage({ title, icon, children, danger = false }: { title: string; icon: string; children: ReactNode; danger?: boolean }) { return <div className={`stage ${danger ? 'stage-danger' : ''}`}><div className="stage-title"><span>{icon}</span><h2>{title}</h2></div>{children}</div>; }
function Check({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) { return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)}/><i>{checked ? '✓' : ''}</i><span>{label}</span></label>; }
function Facts({ update }: { update: FirmwareUpdateState }) { return <div className="facts"><span><small>SIZE</small><strong>{update.target.sizeBytes.toLocaleString()} bytes</strong></span><span><small>REVISION</small><strong>{update.target.revision}</strong></span><span><small>SHA-256</small><strong>{update.target.sha256.slice(0, 14)}…</strong></span></div>; }
function Progress({ update }: { update: FirmwareUpdateState }) { const percent = update.flashProgress?.percent ?? 0; return <div className="progress"><div><strong>{update.flashProgress?.stage.replaceAll('-', ' ') ?? 'starting'}</strong><span>{percent}%</span></div><div role="progressbar" aria-label="Firmware write progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${Math.max(2, percent)}%` }}/></div></div>; }
function writeButtonLabel(update: FirmwareUpdateState): string {
  if (update.writeIntent === 'install-custom') return 'Install verified custom firmware';
  if (update.writeIntent === 'restore-oem') return 'Restore verified OEM firmware';
  return 'Install verified OEM update';
}
