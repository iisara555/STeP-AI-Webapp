import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, AlertCircle, Copy, LoaderCircle } from 'lucide-react';
import { errorView } from '../../packages/harness-core/src/index.ts';
import { ApiError } from './host.ts';
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const id = useId(),
    ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button className="icon-button" aria-label="ปิด" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function ErrorNotice({
  error,
  onDismiss,
  onAction,
}: {
  error: unknown;
  onDismiss: () => void;
  onAction?: (code: string) => void;
}) {
  const code =
    error instanceof ApiError
      ? error.code
      : error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'NETWORK_ERROR';
  const view = errorView(code);
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={22} />
      <div>
        <strong>{view.title}</strong>
        <p>{view.detail}</p>
        <div className="inline-actions">
          {onAction &&
            /^(UNAUTHENTICATED|ACCESS_DENIED|AI_|HARNESS_|SERVER_NOT_CONFIGURED|GOOGLE_|STORAGE_|DOCUMENT_|FILE_INVALID|UPLOAD_PENDING|NETWORK_ERROR|MEMBER_LIMIT|MEMORY_LIMIT)/.test(
              code,
            ) && <button onClick={() => onAction(code)}>{view.action}</button>}
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(
                  `STeP AI Webapp · ${code}${error instanceof ApiError && error.requestId ? ' · ' + error.requestId : ''}`,
                )
                .catch(() => {})
            }
          >
            <Copy size={14} />
            คัดลอกรหัสปัญหา
          </button>
        </div>
      </div>
      <button className="icon-button" onClick={onDismiss} aria-label="ปิดข้อความแจ้งปัญหา">
        <X size={18} />
      </button>
    </div>
  );
}
export function Empty({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </div>
  );
}
export function Busy({ label = 'กำลังโหลด' }: { label?: string }) {
  return (
    <span className="busy" role="status">
      <LoaderCircle size={16} className="spin" />
      {label}
    </span>
  );
}
export function Visibility({ shared = false }: { shared?: boolean }) {
  return (
    <span className={'badge ' + (shared ? 'shared' : '')}>{shared ? 'แชร์ใน workspace' : 'ส่วนตัว'}</span>
  );
}
export const bytes = (n: number) =>
  new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(n / 1000000) + ' MB';
export const number = (n: number) => new Intl.NumberFormat('th-TH').format(n);
