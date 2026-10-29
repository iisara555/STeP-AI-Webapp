// Cloud Workspace sign-in: Google's own button (Google Identity Services) gives the ID token the Gateway verifies.
// Loaded only in Cloud Workspace mode; the Supabase sign-in is unchanged.
import { useEffect, useRef, useState } from 'react';
import { ApiError } from './host.ts';
import { storeCredential } from './gateway.ts';

type Gis = {
  accounts: {
    id: {
      initialize(options: Record<string, unknown>): void;
      renderButton(element: HTMLElement, options: Record<string, unknown>): void;
      prompt(): void;
      disableAutoSelect(): void;
    };
  };
};
declare global {
  interface Window {
    google?: Gis;
  }
}

const SCRIPT = 'https://accounts.google.com/gsi/client';
let loading: Promise<Gis> | undefined;
function loadGis() {
  loading ??= new Promise<Gis>((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.google ? resolve(window.google) : reject(new ApiError('GOOGLE_LOGIN_FAILED'));
    script.onerror = () => {
      loading = undefined;
      reject(new ApiError('GOOGLE_LOGIN_FAILED'));
    };
    document.head.append(script);
  });
  return loading;
}

/** Signals App that this tab now holds a credential (or lost it). */
export const CREDENTIAL_EVENT = 'step-gateway-credential';

export function signOutOfGoogle() {
  window.google?.accounts.id.disableAutoSelect();
}

export function GoogleSignIn({ clientId, onError }: { clientId: string; onError: (error: unknown) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    loadGis()
      .then((google) => {
        if (!active || !slot.current) return;
        google.accounts.id.initialize({
          client_id: clientId,
          // Returning employees are signed in again without a click while their Google session lasts.
          auto_select: true,
          itp_support: true,
          callback: ({ credential }: { credential?: string }) => {
            try {
              if (!credential) throw new ApiError('GOOGLE_LOGIN_FAILED');
              storeCredential(credential);
              window.dispatchEvent(new Event(CREDENTIAL_EVENT));
            } catch (error) {
              onError(error);
            }
          },
        });
        google.accounts.id.renderButton(slot.current, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
          locale: 'th',
        });
        google.accounts.id.prompt();
        setReady(true);
      })
      .catch((error) => active && onError(error));
    return () => {
      active = false;
    };
  }, [clientId, onError]);
  return (
    <div className="google-sign-in" aria-busy={!ready}>
      <div ref={slot} />
      {!ready && <span className="muted">กำลังเปิดปุ่มลงชื่อเข้าใช้ของ Google…</span>}
    </div>
  );
}
