// Cloud Workspace storage banner: amber from 80 %, red from 95 % and when full; hidden otherwise.
import { useEffect, useState } from 'react';
import type { Host } from './host.ts';
import { AlertCircle } from './icons.tsx';
import { parseStorageStatus, storageBanner, type StorageStatus } from './storage.ts';

/** The pool status, re-read every minute, when the tab regains focus and whenever `again` changes (for example
 * after a save was refused). A failed read is shown as unknown: the banner then stays hidden. */
export function useStorageStatus(host: Host, enabled: boolean, again: unknown): StorageStatus | null {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let live = true;
    const read = () =>
      void host
        .call('storage.status')
        .then((value) => live && setStatus(parseStorageStatus(value)))
        .catch(() => live && setStatus({ state: 'unavailable' }));
    read();
    const timer = setInterval(read, 60_000);
    window.addEventListener('focus', read);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [host, enabled, again]);
  return status;
}

export function StorageBanner({ status }: { status: StorageStatus | null }) {
  const view = storageBanner(status);
  if (!view) return null;
  return (
    <div className={'storage-banner ' + view.tone} role={view.tone === 'warning' ? 'status' : 'alert'}>
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        <strong>{view.title}</strong>
        <p>{view.detail}</p>
      </div>
    </div>
  );
}
