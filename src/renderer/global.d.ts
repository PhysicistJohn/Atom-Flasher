import type { TinySaFlasherApi } from '../main/ipc-contract.js';

declare global {
  interface Window { tinySaFlasher: TinySaFlasherApi; }
}

export {};
