import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, AlertCircle, Copy, LoaderCircle } from './icons.tsx';
import { errorView } from '../../packages/harness-core/src/index.ts';
import { ApiError } from './host.ts';
import chatArt from './assets/illustrations/chat.webp';
import connectionsArt from './assets/illustrations/connections.webp';
import ideaArt from './assets/illustrations/idea.webp';
import mediaArt from './assets/illustrations/media-couple.webp';
import receiptArt from './assets/illustrations/receipt.webp';
import skillsArt from './assets/illustrations/skills.webp';
import teamworkArt from './assets/illustrations/teamwork.webp';
import workspaceArt from './assets/illustrations/workspace.webp';

// The Desktop app's hand-drawn scenes (see DESIGN.md for their source). Decorative: headings carry the meaning.
const illustrations = {
  chat: chatArt,
  connections: connectionsArt,
  idea: ideaArt,
  media: mediaArt,
  receipt: receiptArt,
  skills: skillsArt,
  teamwork: teamworkArt,
  workspace: workspaceArt,
};
export function Art({ scene, className = '' }: { scene: keyof typeof illustrations; className?: string }) {
  return (
    <img
      className={'illustration ' + className}
      src={illustrations[scene]}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
/** The original symbol artwork: colour on light surfaces, white mono on dark. Never redrawn or recoloured. */
export function BrandSymbol() {
  return (
    <span className="brand-symbol" role="img" aria-label="STeP">
      <img className="on-light" src="/step-symbol-colour.svg" alt="" />
      <img className="on-dark" src="/step-symbol-mono-white.svg" alt="" />
    </span>
  );
}
/** A small set of mutually exclusive filters, announced as tabs. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = 'segmented',
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={className} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
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
  art,
  title,
  detail,
  children,
}: {
  icon?: ReactNode;
  art?: keyof typeof illustrations;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {art ? <Art scene={art} /> : icon && <div className="empty-icon">{icon}</div>}
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
