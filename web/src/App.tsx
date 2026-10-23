import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import {
  Brain,
  Check,
  CircleHelp,
  History as HistoryIcon,
  Image,
  FilePenLine,
  PanelLeftClose,
  PanelLeftOpen,
  Command,
  FileText,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Receipt,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Snapshot, Workspace, Conversation, Skill } from '../../packages/harness-core/src/contracts.ts';
import { ApiError, configured, loadSnapshot, supabase, webHost, type Host } from './host.ts';
import { demoHost } from './demo.ts';
import { Busy, Empty, ErrorNotice, Modal, Visibility } from './components.tsx';
import { Chat } from './Chat.tsx';
import { Documents } from './Documents.tsx';
import { Memories } from './Memories.tsx';
import { ReceiptView } from './ReceiptView.tsx';
import { SettingsView } from './SettingsView.tsx';
import { SkillsHub } from './SkillsHub.tsx';
import { DocumentTools } from './DocumentTools.tsx';
import { MediaStudio } from './MediaStudio.tsx';
import { Help } from './Help.tsx';
import { History } from './History.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { ThemeSelect } from './ThemeSelect.tsx';
import type { PreparedWork } from '../../packages/harness-core/src/desktop-workflows.ts';
import { exchangeCodeOnce, verifiedIdentity } from './auth.ts';
import {
  currentRoute,
  loginPath,
  navigate,
  pagePaths,
  returnPath,
  returnPathKey,
  routePage,
  subscribeRoute,
  type Page,
} from './routes.ts';
export type { Page } from './routes.ts';
export interface ViewProps {
  host: Host;
  data: Snapshot;
  tenant: string;
  workspace: Workspace | null;
  refresh: () => Promise<void>;
  fail: (error: unknown) => void;
}
const navigation = [
  { id: 'chat' as const, label: 'งานของฉัน', icon: MessageSquare },
  { id: 'history' as const, label: 'ค้นงานเก่า', icon: HistoryIcon },
  { id: 'document-tools' as const, label: 'ร่างเอกสาร', icon: FilePenLine },
  { id: 'media' as const, label: 'สื่อภายใน', icon: Image },
  { id: 'skills' as const, label: 'Skill', icon: LayoutGrid },
  { id: 'documents' as const, label: 'เอกสาร', icon: FileText },
  { id: 'memory' as const, label: 'ความจำ', icon: Brain },
  { id: 'receipt' as const, label: 'ตรวจใบเสร็จ AFP', icon: Receipt },
];
export function App() {
  const route = useSyncExternalStore(subscribeRoute, currentRoute);
  const pathname = route.split('?')[0];
  const page = routePage(pathname);
  const [demo, setDemo] = useState(new URLSearchParams(location.search).get('demo') === '1');
  const authEntry = useMemo(() => new URL(location.href), [demo]);
  const host = useMemo(() => (demo ? demoHost() : webHost()), [demo]);
  const [settingsTab, setSettingsTab] = useState(
    new URLSearchParams(location.search).has('google') ? 'google' : 'account',
  );
  const [signedIn, setSignedIn] = useState(demo),
    [authReady, setAuthReady] = useState(demo || !configured());
  const [data, setData] = useState<Snapshot | null>(null),
    [tenant, setTenant] = useState(''),
    [workspaceId, setWorkspaceId] = useState('');
  const [session, setSession] = useState<Conversation | null>(null),
    [skill, setSkill] = useState<Skill | null>(null);
  const [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(false),
    [mobile, setMobile] = useState(false),
    [dialog, setDialog] = useState<'workspace' | 'share' | 'conversation' | null>(null);
  const [search, setSearch] = useState(''),
    [update, setUpdate] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const [collapsed, setCollapsed] = useState(false),
    [palette, setPalette] = useState(false);
  const [prepared, setPrepared] = useState<{ sessionId: string; text: string } | null>(null);
  const consumePrepared = useCallback(() => setPrepared(null), []);
  const activeTenant = useRef(tenant);
  activeTenant.current = tenant;
  const epoch = useRef(0);
  const authenticatedUser = useRef('');
  const [authGeneration, setAuthGeneration] = useState(0);
  useEffect(() => {
    if (demo) {
      setSignedIn(true);
      setAuthReady(true);
      return;
    }
    if (!configured()) return;
    let active = true;
    let initializing = true;
    let validation = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const db = supabase();
    const applyIdentity = (next: string) => {
      if (next !== authenticatedUser.current) {
        authenticatedUser.current = next;
        epoch.current++;
        setAuthGeneration((v) => v + 1);
        setData(null);
        setSession(null);
        setTenant('');
        setWorkspaceId('');
        setDialog(null);
        setError(null);
      }
      setSignedIn(Boolean(next));
    };
    const validate = async () => {
      const current = ++validation;
      try {
        const id = await verifiedIdentity(db);
        if (active && current === validation) applyIdentity(id);
      } catch (e) {
        if (active && current === validation) {
          applyIdentity('');
          setError(e);
        }
      } finally {
        if (active && current === validation) setAuthReady(true);
      }
    };
    const initialize = async () => {
      try {
        if (authEntry.pathname === '/settings' && authEntry.searchParams.has('google')) {
          const result = authEntry.searchParams.get('google') || '';
          navigate('/settings', true);
          if (result !== 'connected')
            throw new ApiError(/^[A-Z_]{3,60}$/.test(result) ? result : 'GOOGLE_LOGIN_FAILED');
        }
        if (authEntry.pathname === '/auth/callback') {
          const params = authEntry.searchParams;
          const code = params.get('code');
          if (params.has('error') || !code) throw new ApiError('GOOGLE_LOGIN_FAILED');
          await exchangeCodeOnce(db, code);
          if (active) {
            const destination = returnPath(sessionStorage.getItem(returnPathKey));
            sessionStorage.removeItem(returnPathKey);
            navigate(destination, true);
          }
        }
        if (active) await validate();
      } catch (e) {
        if (active) {
          applyIdentity('');
          sessionStorage.removeItem(returnPathKey);
          navigate('/login', true);
          setError(e);
        }
      } finally {
        initializing = false;
        if (active) setAuthReady(true);
      }
    };
    void initialize();
    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((event, s) => {
      if (!active || event === 'INITIAL_SESSION') return;
      if (!s) {
        validation++;
        applyIdentity('');
        setAuthReady(true);
      } else if (!initializing) {
        if (s.user.id !== authenticatedUser.current) applyIdentity('');
        setAuthReady(false);
        // Supabase callbacks run under an Auth lock. Validate after releasing it.
        const timer = setTimeout(() => {
          timers.delete(timer);
          void validate();
        }, 0);
        timers.add(timer);
      }
    });
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, [demo, authEntry]);
  useEffect(() => {
    if (!authReady) return;
    if (!signedIn && pathname !== '/login') navigate(loginPath(pathname), true);
    else if (signedIn && pathname === '/login')
      navigate(returnPath(new URLSearchParams(location.search).get('next')), true);
  }, [authReady, signedIn, pathname, route]);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    const snapshot = await loadSnapshot(host);
    if (current !== epoch.current) return;
    setData(snapshot);
    setTenant((t) => (snapshot.tenants.some((x) => x.id === t) ? t : snapshot.tenants[0]?.id || ''));
  }, [host]);
  useEffect(() => {
    if (!signedIn || !authReady) return;
    setLoading(true);
    void refresh()
      .catch(setError)
      .finally(() => setLoading(false));
  }, [signedIn, authReady, refresh, authGeneration]);
  useEffect(() => {
    const on = () => setOnline(true),
      off = () => setOnline(false),
      ready = () => setUpdate(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('step-update-ready', ready);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('step-update-ready', ready);
    };
  }, []);
  useEffect(() => {
    setPrepared(null);
    setSession(null);
    setSkill(null);
    setWorkspaceId('');
    if (tenant) setError(null);
  }, [tenant]);
  const workspaces = data?.workspaces.filter((w) => w.tenant_id === tenant) || [];
  const workspace = workspaces.find((w) => w.id === workspaceId) || null;
  const changePage = (p: Page) => {
    setMobile(false);
    navigate(pagePaths[p] + (demo ? '?demo=1' : ''));
  };
  const fail = useCallback((e: unknown) => setError(e), []);
  const useSkill = (selected: Skill) => {
    if (selected.skill_key === 'receipt-audit') changePage('receipt');
    else {
      setSkill(selected);
      changePage('chat');
    }
  };
  const prepareWork = async (work: PreparedWork) => {
    const selected = data?.skills.find(
      (s) =>
        (!s.tenant_id || s.tenant_id === tenant) &&
        s.skill_key === work.skillKey &&
        !s.metadata.developerOnly &&
        !s.metadata.webUnsupported,
    );
    if (work.skillKey && !selected && !host.demo) throw new ApiError('HARNESS_INCOMPLETE');
    const current = epoch.current;
    let created = await host.call<Conversation>('session.create', {
      tenant,
      workspace: null,
      visibility: 'private',
      title: work.title,
    });
    if (work.draft)
      created = await host.call<Conversation>('session.draft', {
        tenant,
        id: created.id,
        version: created.version,
        draft: work.draft,
      });
    if (current !== epoch.current || activeTenant.current !== tenant) return;
    await refresh();
    if (current !== epoch.current || activeTenant.current !== tenant) return;
    setWorkspaceId('');
    setSession(created);
    setSkill(selected || null);
    setPrepared({ sessionId: created.id, text: work.message });
    changePage('chat');
  };
  useEffect(() => {
    if (!signedIn || !data) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.isComposing || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'k' && !e.altKey) {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (k === 'n' && e.altKey) {
        e.preventDefault();
        setDialog('conversation');
      } else if (k === 'm' && e.shiftKey) {
        e.preventDefault();
        changePage('memory');
      } else if (k === ',') {
        e.preventDefault();
        changePage('settings');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [signedIn, data, demo]);

  const logout = async () => {
    setSignedIn(false);
    epoch.current++;
    setData(null);
    setSession(null);
    setError(null);
    setPrepared(null);
    setPalette(false);
    await host.signOut().catch(() => {});
    setSignedIn(false);
    setDemo(false);
    sessionStorage.removeItem(returnPathKey);
    navigate('/login', true);
  };
  const updateApp = async () => {
    if (
      !window.confirm(
        'บันทึกร่างที่แก้ไขก่อนอัปเดต แอปจะเปิดใหม่ งานที่เริ่มแล้วจะยังอยู่ในระบบ ต้องการอัปเดตตอนนี้หรือไม่?',
      )
    )
      return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration?.waiting) {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      registration.waiting.postMessage('activate-update');
    } else location.reload();
  };
  if (!authReady)
    return (
      <main className="login">
        <Busy label="กำลังตรวจบัญชี" />
      </main>
    );
  if (!signedIn)
    return (
      <main className="login">
        <div className="login-card">
          <div className="brand-logo">
            <img className="brand-colour" src="/step-symbol-colour.svg" alt="STeP" />
            <img className="brand-white" src="/step-symbol-mono-white.svg" alt="STeP" />
          </div>
          <p className="eyebrow">MAKE INNOVATION SIMPLE</p>
          <h1>
            พื้นที่ทำงานของคุณ
            <br />
            พร้อม AI ที่เข้าใจงาน
          </h1>
          <p>
            เก็บงาน เอกสาร และความจำไว้ด้วยกัน
            <br />
            เลือกแชร์กับทีมได้เมื่อคุณพร้อม
          </p>
          {Boolean(error) && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
          {configured() ? (
            <button className="primary login-button" onClick={() => void host.signIn().catch(setError)}>
              ลงชื่อเข้าใช้ด้วย Google
            </button>
          ) : (
            <div className="setup-note">
              <ShieldCheck size={20} />
              <p>
                ระบบยังไม่เปิดให้เข้าใช้งานจริง
                <br />
                ผู้ดูแลกำลังเตรียมการเชื่อมต่อบัญชีองค์กร
              </p>
            </div>
          )}
          <button
            className="text-button"
            onClick={() => {
              setDemo(true);
              setSignedIn(true);
              setError(null);
              navigate('/?demo=1');
            }}
          >
            ดูตัวอย่างหน้าจอ
          </button>
          <small>สำหรับบัญชีที่ได้รับเชิญจาก STeP เท่านั้น</small>
        </div>
        <div className="login-art">
          <div className="art-card">
            <Brain size={28} />
            <strong>จำสิ่งที่ช่วยให้ทำงานง่ายขึ้น</strong>
            <span>ความจำส่วนตัว แก้ไขและลบได้</span>
          </div>
          <div className="art-card">
            <FolderOpen size={28} />
            <strong>เอกสารอยู่เป็นที่ หาได้เมื่อใช้</strong>
            <span>อัปโหลดเอง หรือเลือกจาก Google Drive</span>
          </div>
          <div className="art-card">
            <ShieldCheck size={28} />
            <strong>คุณเลือกเองว่าจะแชร์อะไร</strong>
            <span>workspace ส่วนตัว พร้อมชวนทีมมาทำงาน</span>
          </div>
        </div>
      </main>
    );
  if (loading && !data)
    return (
      <main className="login">
        <Busy label="กำลังเปิดพื้นที่ทำงาน" />
      </main>
    );
  if (!data?.tenants.length)
    return (
      <main className="login">
        <div className="login-card">
          <div className="brand-logo">
            <img className="brand-colour" src="/step-symbol-colour.svg" alt="STeP" />
            <img className="brand-white" src="/step-symbol-mono-white.svg" alt="STeP" />
          </div>
          <h1>บัญชีนี้ยังไม่ได้รับเชิญ</h1>
          <p>{data?.user.email || 'ขอให้ผู้ดูแลเพิ่มบัญชี Google ของคุณในรายชื่อพนักงาน'}</p>
          {Boolean(error) && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
          <button className="primary" onClick={() => void refresh().catch(setError)}>
            ตรวจอีกครั้ง
          </button>
          <button onClick={() => void logout()}>เปลี่ยนบัญชี</button>
        </div>
      </main>
    );
  const props: ViewProps = { host, data, tenant, workspace, refresh, fail };
  const sessions = data.sessions.filter(
    (s) =>
      s.tenant_id === tenant &&
      (!workspace || s.workspace_id === workspace.id) &&
      s.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className={'app-shell ' + (collapsed ? 'sidebar-collapsed' : '')}>
      {mobile && <button className="sidebar-scrim" aria-label="ปิดเมนู" onClick={() => setMobile(false)} />}
      <aside className={'sidebar ' + (mobile ? 'mobile-open' : '')}>
        <div className="sidebar-brand">
          <div className="brand-logo">
            <img className="brand-colour" src="/step-symbol-colour.svg" alt="STeP" />
            <img className="brand-white" src="/step-symbol-mono-white.svg" alt="STeP" />
          </div>
          <span>AI WORKSPACE</span>
          <button className="icon-button mobile-only" aria-label="ปิดเมนู" onClick={() => setMobile(false)}>
            <X size={20} />
          </button>
        </div>
        <button className="sidebar-command" onClick={() => setPalette(true)}>
          <Command size={18} />
          <span>ค้นหน้าหรือ Skill</span>
          <kbd>⌘/Ctrl K</kbd>
        </button>
        <button className="primary new-task" onClick={() => setDialog('conversation')}>
          <Plus size={19} />
          <span>เริ่มงานใหม่</span>
        </button>
        <label className="search">
          <Search size={16} />
          <input
            placeholder="ค้นหางานของฉัน"
            aria-label="ค้นหางานของฉัน"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <nav aria-label="เมนูหลัก">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? 'selected' : ''}
              aria-label={n.label}
              title={n.label}
              onClick={() => changePage(n.id)}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-history">
          <p className="section-label">บทสนทนาล่าสุด</p>
          {sessions.slice(0, 16).map((s) => (
            <button
              key={s.id}
              className={session?.id === s.id ? 'active-history' : ''}
              onClick={() => {
                setSession(s);
                changePage('chat');
              }}
            >
              <MessageSquare size={14} />
              <span>{s.title}</span>
            </button>
          ))}
          {!sessions.length && <small>งานที่คุณเริ่มจะแสดงตรงนี้</small>}
        </div>
        <div className="sidebar-footer">
          <button
            aria-label="คู่มือและความสามารถ"
            title="คู่มือและความสามารถ"
            onClick={() => changePage('help')}
          >
            <CircleHelp size={19} />
            <span>คู่มือและความสามารถ</span>
          </button>
          <button className={page === 'settings' ? 'selected' : ''} onClick={() => changePage('settings')}>
            <Settings size={19} />
            <span>การตั้งค่า</span>
          </button>
          <div className="account">
            <span className="avatar">{data.user.name?.slice(0, 1) || 'S'}</span>
            <div>
              <strong>{data.user.name || 'บัญชีของฉัน'}</strong>
              <span>{data.tenants.find((t) => t.id === tenant)?.name}</span>
            </div>
            <button className="icon-button" aria-label="ออกจากระบบ" onClick={() => void logout()}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="workspace-heading">
            <button className="icon-button mobile-only" aria-label="เปิดเมนู" onClick={() => setMobile(true)}>
              <Menu size={22} />
            </button>
            <button
              className="icon-button desktop-only"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'ขยายแถบเมนู' : 'ย่อแถบเมนู'}
            >
              {collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
            </button>
            <FolderOpen size={19} />
            <select
              aria-label="เลือก workspace"
              value={workspaceId}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setSession(null);
              }}
            >
              <option value="">พื้นที่ส่วนตัว</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="สร้าง workspace"
              onClick={() => setDialog('workspace')}
            >
              <Plus size={18} />
            </button>
          </div>
          <div className="topbar-actions">
            <ThemeSelect />
            {demo && <span className="badge demo">ตัวอย่าง · ไม่ใช่ข้อมูลจริง</span>}
            {workspace?.created_by === data.user.id && (
              <button onClick={() => setDialog('share')}>
                <Share2 size={16} />
                เชิญทีม
              </button>
            )}
            <span className="private-hint">
              <ShieldCheck size={15} />
              คุณเลือกสิ่งที่แชร์ได้
            </span>
          </div>
        </header>
        {!online && (
          <div className="connection-banner" role="status">
            ขณะนี้ออฟไลน์ · เชื่อมต่ออินเทอร์เน็ตเพื่อเปิดข้อมูลและเริ่มงาน
          </div>
        )}
        {update && (
          <div className="connection-banner">
            มีแอปรุ่นใหม่ <button onClick={() => void updateApp()}>อัปเดตเมื่อพร้อม</button>
          </div>
        )}
        {Boolean(error) && (
          <div className="global-notice">
            <ErrorNotice
              error={error}
              onDismiss={() => setError(null)}
              onAction={(code) => {
                setError(null);
                if (code === 'UNAUTHENTICATED') {
                  void logout();
                  return;
                }
                if (code === 'GOOGLE_PRIVATE_CONTEXT') {
                  changePage('chat');
                  setDialog('conversation');
                  return;
                }
                if (/AI|GOOGLE|HARNESS|SERVER|MEMBER_LIMIT/.test(code)) {
                  setSettingsTab(
                    code === 'AI_QUOTA'
                      ? 'usage'
                      : code.startsWith('GOOGLE_')
                        ? 'google'
                        : code === 'MEMBER_LIMIT'
                          ? 'team'
                          : 'ai',
                  );
                  changePage('settings');
                } else if (/STORAGE|DOCUMENT|FILE_INVALID|UPLOAD_PENDING/.test(code)) changePage('documents');
                else if (code === 'MEMORY_LIMIT') changePage('memory');
                else if (code === 'ACCESS_DENIED') {
                  setSession(null);
                  changePage('chat');
                } else if (/NETWORK/.test(code)) void refresh().catch(setError);
              }}
            />
          </div>
        )}
        <div className={'page ' + (page === 'chat' ? 'chat-page' : '')}>
          {page === 'chat' && (
            <Chat
              {...props}
              key={tenant + workspaceId}
              session={session}
              setSession={setSession}
              skill={skill}
              clearSkill={() => setSkill(null)}
              newSession={() => setDialog('conversation')}
              prepared={prepared}
              consumePrepared={consumePrepared}
              onPrepare={prepareWork}
            />
          )}
          {page === 'documents' && <Documents {...props} />}
          {page === 'memory' && <Memories {...props} />}
          {page === 'receipt' && <ReceiptView {...props} />}
          {page === 'settings' && (
            <SettingsView
              {...props}
              key={tenant}
              initialTab={settingsTab}
              onLogout={() => void logout()}
              onTenantChange={(id) => {
                setSettingsTab('account');
                setTenant(id);
              }}
            />
          )}
          {page === 'skills' && <SkillsHub {...props} onUse={useSkill} />}
          {page === 'document-tools' && <DocumentTools {...props} onPrepare={prepareWork} />}
          {page === 'media' && <MediaStudio {...props} onPrepare={prepareWork} />}
          {page === 'history' && (
            <History
              {...props}
              key={tenant + workspaceId}
              onOpen={(s) => {
                setSession(s);
                changePage('chat');
              }}
            />
          )}
          {page === 'help' && <Help onOpen={(p) => changePage(p as Page)} />}
        </div>
      </main>
      {palette && (
        <CommandPalette
          data={data}
          tenant={tenant}
          onClose={() => setPalette(false)}
          onPage={(p) => {
            changePage(p as Page);
            setPalette(false);
          }}
          onSkill={(s) => {
            useSkill(s);
            setPalette(false);
          }}
        />
      )}
      {dialog === 'workspace' && (
        <Modal title="สร้าง workspace" onClose={() => setDialog(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              try {
                const w = await host.call<Workspace>('workspace.create', {
                  tenant,
                  name: form.get('name'),
                  description: form.get('description'),
                });
                await refresh();
                setWorkspaceId(w.id);
                setSession(null);
                setDialog(null);
              } catch (err) {
                fail(err);
              }
            }}
          >
            <p className="muted">เริ่มเป็นพื้นที่ส่วนตัว คุณเลือกเชิญทีมได้ภายหลัง</p>
            <label>
              ชื่อ workspace
              <input name="name" required maxLength={100} placeholder="เช่น เตรียมงานประชุม" autoFocus />
            </label>
            <label>
              รายละเอียด
              <textarea name="description" maxLength={1000} rows={3} />
            </label>
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                ยกเลิก
              </button>
              <button className="primary">สร้าง workspace</button>
            </footer>
          </form>
        </Modal>
      )}
      {dialog === 'share' && workspace && (
        <Modal title={'เชิญทีมเข้า ' + workspace.name} onClose={() => setDialog(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              try {
                await host.call('workspace.share', {
                  tenant,
                  id: workspace.id,
                  email: form.get('email'),
                  role: form.get('role'),
                });
                setDialog(null);
              } catch (err) {
                fail(err);
              }
            }}
          >
            <p className="muted">
              สมาชิกจะเห็นเฉพาะข้อมูลที่เลือก “แชร์ใน workspace” ความจำและบทสนทนาส่วนตัวยังเป็นของคุณ
            </p>
            <label>
              อีเมลพนักงานที่เป็นสมาชิก STeP แล้ว
              <input name="email" type="email" required autoFocus />
            </label>
            <label>
              สิทธิ์
              <select name="role">
                <option value="editor">แก้ไขข้อมูลที่แชร์ได้</option>
                <option value="viewer">อ่านข้อมูลที่แชร์ได้</option>
              </select>
            </label>
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                ยกเลิก
              </button>
              <button className="primary">เพิ่มสมาชิก</button>
            </footer>
          </form>
        </Modal>
      )}
      {dialog === 'conversation' && (
        <Modal title="เริ่มงานใหม่" onClose={() => setDialog(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              try {
                const s = await host.call<Conversation>('session.create', {
                  tenant,
                  workspace: workspace?.id || null,
                  visibility: form.get('visibility'),
                });
                await refresh();
                setSession(s);
                setDialog(null);
                changePage('chat');
              } catch (err) {
                fail(err);
              }
            }}
          >
            <p className="muted">เลือกคนที่เห็นบทสนทนานี้ก่อนเริ่ม พื้นที่ส่วนตัวจะใช้ความจำของคุณได้</p>
            <label className="radio-row">
              <input type="radio" name="visibility" value="private" defaultChecked />
              ส่วนตัว · คุณเห็นคนเดียว
            </label>
            {workspace && (
              <label className="radio-row">
                <input type="radio" name="visibility" value="workspace" />
                แชร์กับสมาชิกใน {workspace.name}
              </label>
            )}
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                ยกเลิก
              </button>
              <button className="primary">เริ่มงาน</button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
