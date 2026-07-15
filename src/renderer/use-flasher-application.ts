import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApplicationActionResult, ApplicationSnapshot } from '../application/application-contract.js';

const POLL_INTERVAL_MS = 750;

export function useFlasherApplication() {
  const [snapshot, setSnapshot] = useState<ApplicationSnapshot>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const latest = useRef<ApplicationSnapshot | undefined>(undefined);
  const actionInFlight = useRef(false);

  const applySnapshot = useCallback((next: ApplicationSnapshot) => {
    const current = latest.current;
    if (current && current.instanceId === next.instanceId && next.sequence <= current.sequence) return;
    latest.current = next;
    setSnapshot(next);
  }, []);

  const refresh = useCallback(async () => {
    applySnapshot(await window.tinySaFlasher.snapshot());
  }, [applySnapshot]);

  const run = useCallback(async (label: string, operation: () => Promise<ApplicationActionResult>) => {
    // React state is not a synchronous mutex: two clicks in the same event
    // turn can both observe an unset `busy` value. Keep one local action owner
    // so a fast duplicate cannot re-enable the UI while the first is active.
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(label);
    setError(undefined);
    try {
      const result = await operation();
      applySnapshot(result.snapshot);
    } catch (value) {
      setError(message(value));
    } finally {
      try { await refresh(); }
      catch (value) { setError((current) => current ?? message(value)); }
      actionInFlight.current = false;
      setBusy(undefined);
    }
  }, [applySnapshot, refresh]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await window.tinySaFlasher.snapshot();
        if (!disposed) applySnapshot(next);
      } catch (value) {
        if (!disposed) setError(message(value));
      } finally {
        if (!disposed) timer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
      }
    };
    void (async () => {
      try {
        await window.tinySaFlasher.capabilities();
        const initial = await window.tinySaFlasher.snapshot();
        if (disposed) return;
        applySnapshot(initial);
        if (initial.allowedActions.scanDevices) {
          const scanned = await window.tinySaFlasher.scanDevices();
          if (!disposed) applySnapshot(scanned.snapshot);
        }
      } catch (value) {
        if (!disposed) setError(message(value));
      } finally {
        if (!disposed) timer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
      }
    })();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applySnapshot]);

  return {
    snapshot,
    busy,
    error,
    run,
    refresh,
    dismissError: () => setError(undefined),
  };
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
