import { useEffect, useRef, useState, type ForwardRefExoticComponent, type RefAttributes } from 'react';
import { MotionConfig } from 'motion/react';
import {
  Blocks,
  Brain,
  ChevronDown,
  ChevronUp,
  FileText,
  FolderOpen,
  History as HistoryStill,
  Megaphone,
  MessageSquare,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from './icons.tsx';
import type { Conversation } from '../../packages/harness-core/src/contracts.ts';
import { BrandSymbol, Segmented } from './components.tsx';
import { mod } from './TitleBar.tsx';
import type { Page } from './App.tsx';
import { useReducedMotion } from './reduced-motion.ts';
import { BlocksIcon } from './animated-icons/blocks.tsx';
import { BrainIcon } from './animated-icons/brain.tsx';
import { FileTextIcon } from './animated-icons/file-text.tsx';
import { FolderOpenIcon } from './animated-icons/folder-open.tsx';
import { HistoryIcon } from './animated-icons/history.tsx';
import { MegaphoneIcon } from './animated-icons/megaphone.tsx';
import { MessageSquareIcon } from './animated-icons/message-square.tsx';
import { PlusIcon } from './animated-icons/plus.tsx';
import { ReceiptIcon } from './animated-icons/receipt.tsx';
import { SearchIcon } from './animated-icons/search.tsx';
import { SlidersHorizontalIcon } from './animated-icons/sliders-horizontal.tsx';

type Handle = { startAnimation: () => void; stopAnimation: () => void };
type AnimatedIcon = ForwardRefExoticComponent<{ size?: number; className?: string } & RefAttributes<Handle>>;

export const tools: { id: Page; label: string; icon: LucideIcon; motion: AnimatedIcon; beta?: boolean }[] = [
  { id: 'document-tools', label: 'เครื่องมือร่างเอกสาร', icon: FileText, motion: FileTextIcon },
  { id: 'media', label: 'สื่อภายใน', icon: Megaphone, motion: MegaphoneIcon },
  { id: 'skills', label: 'ศูนย์รวม Skill', icon: Blocks, motion: BlocksIcon },
  { id: 'documents', label: 'เอกสาร', icon: FolderOpen, motion: FolderOpenIcon },
  { id: 'memory', label: 'ความจำ', icon: Brain, motion: BrainIcon },
  { id: 'history', label: 'ค้นงานเก่า', icon: HistoryStill, motion: HistoryIcon },
  { id: 'receipt', label: 'ตรวจใบเสร็จ AFP', icon: Receipt, motion: ReceiptIcon, beta: true },
];
const DAY = 86_400_000;
/** Recency buckets like Desktop, newest first. Tasks without a date stay in the most recent group. */
export function groupSessions(sessions: Conversation[], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: [string, (t: number) => boolean][] = [
    ['วันนี้', (t) => t >= today],
    ['เมื่อวาน', (t) => t >= today - DAY],
    ['7 วันที่ผ่านมา', (t) => t >= today - 7 * DAY],
    ['30 วันที่ผ่านมา', (t) => t >= today - 30 * DAY],
    ['เก่ากว่านั้น', () => true],
  ];
  const groups: { label: string; sessions: Conversation[] }[] = [];
  for (const s of sessions) {
    const time = s.created_at ? Date.parse(s.created_at) : now.getTime();
    const label = buckets.find(([, test]) => test(time))![0];
    const group = groups.find((g) => g.label === label);
    if (group) group.sessions.push(s);
    else groups.push({ label, sessions: [s] });
  }
  return groups;
}
const readChoice = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const saveChoice = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* A convenience only: without storage the default comes back next time. */
  }
};
export const sidebarChoice = {
  read: () => readChoice('step.sidebar') !== 'rail',
  save: (full: boolean) => saveChoice('step.sidebar', full ? 'full' : 'rail'),
};

export function Sidebar({
  page,
  sessions,
  currentSession,
  skillCount,
  profile,
  update,
  mobileOpen,
  onCloseMobile,
  onPage,
  onSession,
  onNew,
  onPalette,
  onSearchAll,
  onUpdate,
}: {
  page: Page;
  sessions: Conversation[];
  currentSession: string | undefined;
  skillCount: number;
  profile: { initial: string; name: string; detail: string };
  update: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onPage: (page: Page) => void;
  onSession: (session: Conversation) => void;
  onNew: () => void;
  onPalette: () => void;
  onSearchAll: (query: string) => void;
  onUpdate: () => void;
}) {
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState<'all' | 'artifacts'>('all'),
    [toolsOpen, setToolsOpen] = useState(readChoice('step.tools') !== 'icons');
  const panel = useRef<HTMLElement>(null);
  // The drawer always opens at the brand and เริ่มงานใหม่, not where it was last scrolled.
  useEffect(() => {
    if (mobileOpen && panel.current) panel.current.scrollTop = 0;
  }, [mobileOpen]);
  const q = search.trim().toLowerCase();
  const shown = sessions.filter(
    (s) =>
      (filter === 'all' || s.draft.trim()) &&
      (!q || s.title.toLowerCase().includes(q) || s.draft.toLowerCase().includes(q)),
  );
  return (
    <aside ref={panel} className={'sidebar ' + (mobileOpen ? 'mobile-open' : '')} aria-label="แถบงาน">
      <div className="brand">
        <div>
          <BrandSymbol />
          <span className="brand-tagline">MAKE INNOVATION SIMPLE</span>
        </div>
        <button className="icon-button mobile-only" aria-label="ปิดเมนู" onClick={onCloseMobile}>
          <X size={18} />
        </button>
      </div>
      <button className="primary new-work" onClick={onNew}>
        <Plus size={18} />
        เริ่มงานใหม่
      </button>
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q) onSearchAll(search.trim());
        }}
      >
        <Search size={16} aria-hidden="true" />
        <input
          aria-label="ค้นหางานของฉัน"
          placeholder="ค้นหางานหรือเนื้อหา"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className="palette-hint"
          aria-label={`เปิดคำสั่ง ${mod}K`}
          title="เปิดคำสั่ง"
          onClick={onPalette}
        >
          {mod}K
        </button>
      </form>
      <Segmented
        className="session-filter"
        label="กรองงาน"
        value={filter}
        onChange={(value) => {
          setFilter(value);
          onPage('chat');
        }}
        options={[
          {
            value: 'all',
            label: (
              <>
                <MessageSquare size={14} />
                งานทั้งหมด
              </>
            ),
          },
          {
            value: 'artifacts',
            label: (
              <>
                <FileText size={14} />
                มีผลงาน
              </>
            ),
          },
        ]}
      />
      <div className="sessions">
        {groupSessions(shown).map((group) => (
          <section key={group.label} aria-label={group.label}>
            <div className="session-group">{group.label}</div>
            {group.sessions.map((s) => (
              <button
                key={s.id}
                className="session-open"
                aria-current={page === 'chat' && currentSession === s.id ? 'true' : undefined}
                title={s.title}
                onClick={() => onSession(s)}
              >
                <span>{s.title}</span>
                <small>
                  {s.visibility === 'workspace' ? 'แชร์ใน workspace' : 'ส่วนตัว'}
                  {s.draft.trim() ? ' · มีร่าง' : ''}
                </small>
              </button>
            ))}
          </section>
        ))}
        {!shown.length && (
          <p className="session-empty">
            {q
              ? 'ไม่พบงานที่ตรงกับคำค้น · กด Enter เพื่อค้นในบทสนทนาและร่างทั้งหมด'
              : filter === 'artifacts'
                ? 'ยังไม่มีร่างที่บันทึก งานที่มีร่างจะอยู่ที่นี่'
                : 'เมื่อเริ่มงาน บทสนทนาจะอยู่ที่นี่'}
          </p>
        )}
      </div>
      <div className="tools-group">
        <span>เครื่องมือ</span>
        <button
          className="tools-toggle"
          aria-expanded={toolsOpen}
          aria-label={toolsOpen ? 'ย่อเครื่องมือเป็นไอคอน' : 'แสดงชื่อเครื่องมือ'}
          title={toolsOpen ? 'ย่อเครื่องมือเป็นไอคอน' : 'แสดงชื่อเครื่องมือ'}
          onClick={() => {
            saveChoice('step.tools', toolsOpen ? 'icons' : 'open');
            setToolsOpen(!toolsOpen);
          }}
        >
          {toolsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      <nav className={toolsOpen ? 'tools-nav' : 'tools-nav icons'} aria-label="เครื่องมือ">
        {tools.map((t) => (
          <button
            key={t.id}
            className={page === t.id ? 'nav-active' : ''}
            aria-current={page === t.id ? 'page' : undefined}
            title={toolsOpen ? undefined : t.label}
            onClick={() => onPage(t.id)}
          >
            <t.icon size={17} />
            <span className="nav-label">{t.label}</span>
            {t.id === 'skills' && skillCount > 0 && <span className="count">{skillCount}</span>}
            {t.beta && <span className="beta">ทดลอง</span>}
          </button>
        ))}
      </nav>
      <button
        className={'settings-button ' + (page === 'settings' ? 'nav-active' : '')}
        aria-current={page === 'settings' ? 'page' : undefined}
        onClick={() => onPage('settings')}
      >
        <SlidersHorizontal size={18} />
        การตั้งค่า
      </button>
      {update && (
        <div className="update-card" role="status">
          <strong>มีแอปรุ่นใหม่</strong>
          <p>บันทึกร่างที่แก้ไขก่อน แอปจะโหลดใหม่ งานที่เริ่มแล้วยังอยู่ในระบบ</p>
          <button className="primary" onClick={onUpdate}>
            <RefreshCw size={14} />
            โหลดใหม่เพื่ออัปเดต
          </button>
        </div>
      )}
      <div className="profile">
        <span className="avatar-badge" aria-hidden="true">
          {profile.initial}
        </span>
        <div>
          <strong>{profile.name}</strong>
          <small>{profile.detail}</small>
        </div>
      </div>
    </aside>
  );
}

/** A rail icon that plays its drawing's animation while the button is hovered or has keyboard focus. */
function RailButton({
  icon: Icon,
  still: Still,
  label,
  size = 17,
  className = '',
  current,
  onClick,
}: {
  icon: AnimatedIcon;
  still: LucideIcon;
  label: string;
  size?: number;
  className?: string;
  current?: boolean;
  onClick: () => void;
}) {
  const reduced = useReducedMotion();
  const icon = useRef<Handle>(null);
  const start = () => !reduced && icon.current?.startAnimation();
  const stop = () => icon.current?.stopAnimation();
  return (
    <button
      className={'rail-button ' + className + (current ? ' nav-active' : '')}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={start}
      onMouseLeave={stop}
      onFocus={start}
      onBlur={stop}
    >
      {reduced ? <Still size={size} /> : <Icon ref={icon} size={size} />}
    </button>
  );
}

/** The sidebar folded to icons, as on Desktop. Each icon is named by its tooltip and accessible name. */
export function SidebarRail({
  page,
  profile,
  onPage,
  onNew,
  onPalette,
  onExpand,
}: {
  page: Page;
  profile: { initial: string; name: string };
  onPage: (page: Page) => void;
  onNew: () => void;
  onPalette: () => void;
  onExpand: () => void;
}) {
  return (
    // Animations follow the computer's "reduce motion" setting.
    <MotionConfig reducedMotion="user">
      <aside className="sidebar rail" aria-label="แถบงาน">
        <div className="rail-brand">
          <BrandSymbol />
        </div>
        <RailButton
          icon={PlusIcon}
          still={Plus}
          size={18}
          className="rail-new"
          label="เริ่มงานใหม่"
          onClick={onNew}
        />
        <RailButton icon={SearchIcon} still={Search} label="ค้นหางาน" onClick={onPalette} />
        <RailButton icon={MessageSquareIcon} still={MessageSquare} label="งานทั้งหมด" onClick={onExpand} />
        <span className="rail-divider" aria-hidden="true" />
        <nav aria-label="เครื่องมือ">
          {tools.map((t) => (
            <RailButton
              key={t.id}
              icon={t.motion}
              still={t.icon}
              label={t.label}
              current={page === t.id}
              onClick={() => onPage(t.id)}
            />
          ))}
        </nav>
        <span className="rail-spacer" />
        <RailButton
          icon={SlidersHorizontalIcon}
          still={SlidersHorizontal}
          size={18}
          label="การตั้งค่า"
          current={page === 'settings'}
          onClick={() => onPage('settings')}
        />
        <button
          className="rail-profile"
          aria-label={'บัญชีของฉัน · ' + profile.name}
          title={profile.name}
          onClick={() => onPage('settings')}
        >
          <span className="avatar-badge" aria-hidden="true">
            {profile.initial}
          </span>
        </button>
      </aside>
    </MotionConfig>
  );
}
