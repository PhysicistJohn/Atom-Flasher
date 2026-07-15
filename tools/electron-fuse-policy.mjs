import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire,
} from '@electron/fuses';

const settings = Object.freeze([
  Object.freeze({ option: FuseV1Options.RunAsNode, enabled: false }),
  Object.freeze({ option: FuseV1Options.EnableCookieEncryption, enabled: true }),
  Object.freeze({ option: FuseV1Options.EnableNodeOptionsEnvironmentVariable, enabled: false }),
  Object.freeze({ option: FuseV1Options.EnableNodeCliInspectArguments, enabled: false }),
  Object.freeze({ option: FuseV1Options.EnableEmbeddedAsarIntegrityValidation, enabled: true }),
  Object.freeze({ option: FuseV1Options.OnlyLoadAppFromAsar, enabled: true }),
  // Electron's stock distribution does not include browser_v8_context_snapshot.bin.
  // Enabling this fuse without that separately generated asset aborts at startup.
  Object.freeze({ option: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, enabled: false }),
  // Production deliberately loads its renderer from file:// inside app.asar.
  // Electron documents this fuse as required for file:// pages to load their
  // local assets. The exact URL gate, renderer sandbox, and CSP bound that
  // necessary privilege; disable it only after migrating to a custom scheme.
  Object.freeze({ option: FuseV1Options.GrantFileProtocolExtraPrivileges, enabled: true }),
  Object.freeze({ option: FuseV1Options.WasmTrapHandlers, enabled: true }),
]);

export const electronFuseConfiguration = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  ...Object.fromEntries(settings.map(({ option, enabled }) => [option, enabled])),
});

export async function applyElectronFusePolicy(application, resetAdHocDarwinSignature) {
  await flipFuses(application, {
    ...electronFuseConfiguration,
    resetAdHocDarwinSignature,
  });
  return assertElectronFusePolicy(application);
}

export async function assertElectronFusePolicy(application) {
  const wire = await getCurrentFuseWire(application);
  if (wire.version !== electronFuseConfiguration.version) {
    throw new Error(`Unexpected Electron fuse schema ${wire.version}`);
  }

  const wireOptions = Object.keys(wire).filter((key) => /^\d+$/.test(key));
  if (wireOptions.length !== settings.length) {
    throw new Error(`Electron exposes ${wireOptions.length} fuses but the policy defines ${settings.length}`);
  }

  const states = {};
  for (const { option, enabled } of settings) {
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    const actual = wire[option];
    const name = FuseV1Options[option];
    if (actual !== expected) {
      throw new Error(`${name} is ${describeState(actual)}; expected ${enabled ? 'enabled' : 'disabled'}`);
    }
    states[name] = enabled ? 'enabled' : 'disabled';
  }
  return Object.freeze(states);
}

function describeState(state) {
  if (state === FuseState.ENABLE) return 'enabled';
  if (state === FuseState.DISABLE) return 'disabled';
  if (state === FuseState.REMOVED) return 'removed';
  if (state === FuseState.INHERIT) return 'inherited';
  return `unknown (${String(state)})`;
}
