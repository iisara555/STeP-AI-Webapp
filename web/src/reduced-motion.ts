import { useSyncExternalStore } from 'react';

const preference =
  typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)');
const subscribe = (onChange: () => void) => {
  preference?.addEventListener('change', onChange);
  return () => preference?.removeEventListener('change', onChange);
};
const snapshot = () => preference?.matches ?? true;
const serverSnapshot = () => true;

/** Follow changes while the app is open, including cancelling an interaction in progress. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
