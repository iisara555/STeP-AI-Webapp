import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Command, ShieldCheck, Brain, FolderOpen, Check } from './icons.tsx';
import type { Snapshot, Workspace, Conversation, Skill } from '../../packages/harness-core/src/contracts.ts';
import { ApiError, configured, loadSnapshot, supabase, webHost, type Host } from './host.ts';
import { demoHost } from './demo.ts';
import { Art, BrandSymbol, Busy, ErrorNotice, Modal } from './components.tsx';
import { Chat, type PreparedText } from './Chat.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { TitleBar, mod, type MenuGroup } from './TitleBar.tsx';
import { Sidebar, SidebarRail, sidebarChoice, tools } from './Sidebar.tsx';
import { useTheme } from './ThemeSelect.tsx';
import type { PreparedWork } from '../../packages/harness-core/src/desktop-workflows.ts';
import { assistantName } from '../../packages/harness-core/src/assistant-profile.ts';
// Tool pages load on first open, so the first screen does not wait for the Desktop reference or Word export.
const Documents = lazy(() => import('./Documents.tsx').then((m) => ({ default: m.Documents })));
const Memories = lazy(() => import('./Memories.tsx').then((m) => ({ default: m.Memories })));
const ReceiptView = lazy(() => import('./ReceiptView.tsx').then((m) => ({ default: m.ReceiptView })));
const SettingsView = lazy(() => import('./SettingsView.tsx').then((m) => ({ default: m.SettingsView })));
const SkillsHub = lazy(() => import('./SkillsHub.tsx').then((m) => ({ default: m.SkillsHub })));
const DocumentTools = lazy(() => import('./DocumentTools.tsx').then((m) => ({ default: m.DocumentTools })));
const MediaStudio = lazy(() => import('./MediaStudio.tsx').then((m) => ({ default: m.MediaStudio })));
const Help = lazy(() => import('./Help.tsx').then((m) => ({ default: m.Help })));
const History = lazy(() => import('./History.tsx').then((m) => ({ default: m.History })));
export type Page =
  | 'chat'
  | 'skills'
  | 'documents'
  | 'memory'
  | 'receipt'
  | 'settings'
  | 'document-tools'
  | 'media'
  | 'history'
  | 'help';
export interface ViewProps {
  host: Host;
  data: Snapshot;
  tenant: string;
  workspace: Workspace | null;
  refresh: () => Promise<void>;
  fail: (error: unknown) => void;
}
const pages: Page[] = [
  'settings',
  'skills',
  'documents',
  'memory',
  'receipt',
  'document-tools',
  'media',
  'history',
  'help',
];
/** Title and one-line purpose for the page header, as on Desktop. */
const headers: Record<Exclude<Page, 'chat'>, [string, string]> = {
  'document-tools': [
    'เครื่องมือร่างเอกสาร',
    'ใส่ข้อมูลหรือแนบต้นเรื่อง ให้ AI ช่วยร่าง แล้วตรวจแก้ก่อนส่งออก',
  ],
  media: ['สื่อภายใน', 'เตรียมเนื้อหาและ Prompt ภาพสำหรับสื่อสารภายใน ตามสีองค์กรและห้ามสร้างโลโก้'],
  skills: ['ศูนย์รวม Skill', 'ค้นหา Skill และดูว่ารายการใดพร้อมใช้บนเว็บ'],
  documents: ['เอกสาร', 'เก็บไฟล์ส่วนตัว หรือเลือกแชร์เฉพาะใน workspace'],
  memory: ['ความจำ', 'สิ่งที่ผู้ช่วยจำไว้ใช้ในงานถัดไป แก้ไขหรือลบได้เสมอ'],
  history: ['ค้นงานเก่า', 'ค้นชื่อ บทสนทนา และร่างที่คุณมีสิทธิ์อ่าน'],
  receipt: ['ตรวจใบเสร็จ AFP', 'ทดลอง · ให้ AI อ่านใบเสร็จ แล้วคุณตรวจเทียบต้นฉบับก่อนใช้'],
  settings: ['การตั้งค่า', 'บัญชี การเชื่อมต่อ AI, Google Workspace และข้อมูลของคุณ'],
  help: ['คู่มือและความสามารถ', 'ตรวจได้ว่าเว็บรองรับความสามารถใดของ Desktop แล้ว'],
};
const narrow = window.matchMedia('(max-width: 900px)');
const subscribeNarrow = (onChange: () => void) => {
  narrow.addEventListener('change', onChange);
  return () => narrow.removeEventListener('change', onChange);
};
export function App() {
  const [demo, setDemo] = useState(new URLSearchParams(location.search).get('demo') === '1');
  const host = useMemo(() => (demo ? demoHost() : webHost()), [demo]);
  const [settingsTab, setSettingsTab] = useState(
    new URLSearchParams(location.search).has('google') ? 'google' : 'profile',
  );
  const [signedIn, setSignedIn] = useState(demo),
    [authReady, setAuthReady] = useState(demo || !configured());
  const [data, setData] = useState<Snapshot | null>(null),
    [tenant, setTenant] = useState(''),
    [workspaceId, setWorkspaceId] = useState('');
  const [page, setPage] = useState<Page>(
      pages.includes(location.pathname.slice(1) as Page) ? (location.pathname.slice(1) as Page) : 'chat',
    ),
    [session, setSession] = useState<Conversation | null>(null),
    [skill, setSkill] = useState<Skill | null>(null);
  const [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(false),
    [mobile, setMobile] = useState(false),
    [dialog, setDialog] = useState<'workspace' | 'share' | 'conversation' | 'update' | null>(null);
  const [update, setUpdate] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const [fullSidebar, setFullSidebar] = useState(sidebarChoice.read()),
    [palette, setPalette] = useState(false),
    [historyQuery, setHistoryQuery] = useState('');
  const [theme, setTheme] = useTheme();
  const isNarrow = useSyncExternalStore(subscribeNarrow, () => narrow.matches);
  const [artifactSlot, setArtifactSlot] = useState<HTMLDivElement | null>(null);
  const [prepared, setPrepared] = useState<PreparedText | null>(null);
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
    const db = supabase();
    const initialize = async () => {
      try {
        if (location.pathname === '/settings' && new URLSearchParams(location.search).has('google')) {
          const result = new URLSearchParams(location.search).get('google') || '';
          history.replaceState(null, '', '/settings');
          if (result !== 'connected')
            throw new ApiError(/^[A-Z_]{3,60}$/.test(result) ? result : 'GOOGLE_LOGIN_FAILED');
        }
        if (location.pathname === '/auth/callback') {
          const code = new URLSearchParams(location.search).get('code');
          if (code) {
            const result = await db.auth.exchangeCodeForSession(code);
            if (result.error) throw new ApiError('GOOGLE_LOGIN_FAILED');
          }
          history.replaceState(null, '', '/');
        }
        const {
          data: { session },
        } = await db.auth.getSession();
        if (active) setSignedIn(Boolean(session));
      } catch (e) {
        if (active) setError(e);
      } finally {
        if (active) setAuthReady(true);
      }
    };
    void initialize();
    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((_event, s) => {
      if (active) {
        const next = s?.user.id || '';
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
        setSignedIn(Boolean(s));
      }
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [demo]);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    const snapshot = await loadSnapshot(host);
    if (current !== epoch.current) return;
    setData(snapshot);
    setTenant((t) => (snapshot.tenants.some((x) => x.id === t) ? t : snapshot.tenants[0]?.id || ''));
  }, [host]);
  useEffect(() => {
    if (!signedIn) return;
    setLoading(true);
    void refresh()
      .catch(setError)
      .finally(() => setLoading(false));
  }, [signedIn, refresh, authGeneration]);
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
    setError(null);
  }, [tenant]);
  const workspaces = data?.workspaces.filter((w) => w.tenant_id === tenant) || [];
  const workspace = workspaces.find((w) => w.id === workspaceId) || null;
  const changePage = (p: Page) => {
    setPage(p);
    setMobile(false);
    history.replaceState(null, '', (p === 'chat' ? '/' : '/' + p) + (demo ? '?demo=1' : ''));
  };
  const fail = useCallback((e: unknown) => setError(e), []);
  const useSkill = (selected: Skill) => {
    if (selected.skill_key === 'receipt-audit') changePage('receipt');
    else {
      setSkill(selected);
      setSession(null);
      changePage('chat');
    }
  };
  const prepareWork = async (
    work: PreparedWork,
    options: { submit?: boolean; documents?: string[] } = {},
  ) => {
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
    setPrepared({ sessionId: created.id, text: work.message, ...options });
    changePage('chat');
  };
  const newTask = () => {
    if (workspace) setDialog('conversation');
    else {
      setSession(null);
      setSkill(null);
      changePage('chat');
    }
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
        newTask();
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
  }, [signedIn, data, demo, workspace]);

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
    history.replaceState(null, '', '/');
  };
  const updateApp = async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration?.waiting) {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      registration.waiting.postMessage('activate-update');
    } else location.reload();
  };
  const toggleSidebar = () => {
    sidebarChoice.save(!fullSidebar);
    setFullSidebar(!fullSidebar);
  };
  if (!authReady)
    return (
      <main className="login login-wait">
        <Busy label="กำลังตรวจบัญชี" />
      </main>
    );
  if (!signedIn)
    return (
      <main className="login">
        <div className="login-card">
          <BrandSymbol />
          <span className="brand-tagline">MAKE INNOVATION SIMPLE</span>
          <h1>
            พื้นที่ทำงานของคุณ
            <br />
            <em>พร้อม AI ที่เข้าใจงาน</em>
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
              history.replaceState(null, '', '/?demo=1');
            }}
          >
            ดูตัวอย่างหน้าจอ
          </button>
          <small>สำหรับบัญชีที่ได้รับเชิญจาก STeP เท่านั้น</small>
        </div>
        <div className="login-art">
          <Art scene="teamwork" />
          <ul className="welcome-trust">
            <li>
              <Brain size={16} />
              <span>
                <strong>จำสิ่งที่ช่วยให้ทำงานง่ายขึ้น</strong>
                ความจำส่วนตัว แก้ไขและลบได้
              </span>
            </li>
            <li>
              <FolderOpen size={16} />
              <span>
                <strong>เอกสารอยู่เป็นที่ หาได้เมื่อใช้</strong>
                อัปโหลดเอง หรือเลือกจาก Google Drive
              </span>
            </li>
            <li>
              <ShieldCheck size={16} />
              <span>
                <strong>คุณเลือกเองว่าจะแชร์อะไร</strong>
                workspace ส่วนตัว พร้อมชวนทีมมาทำงาน
              </span>
            </li>
          </ul>
        </div>
      </main>
    );
  if (loading && !data)
    return (
      <main className="login login-wait">
        <Busy label="กำลังเปิดพื้นที่ทำงาน" />
      </main>
    );
  if (!data?.tenants.length)
    return (
      <main className="login login-wait">
        <div className="login-card">
          <BrandSymbol />
          <span className="brand-tagline">MAKE INNOVATION SIMPLE</span>
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
    (s) => s.tenant_id === tenant && (!workspace || s.workspace_id === workspace.id),
  );
  const own = data.memberships.find((m) => m.tenant_id === tenant && m.user_id === data.user.id);
  const memberProfile = data.profiles?.find((p) => p.tenant_id === tenant);
  const shownName = memberProfile?.display_name || data.user.name || 'บัญชีของฉัน';
  const profile = {
    initial: (memberProfile?.display_name || data.user.name || data.user.email || 'S')
      .slice(0, 1)
      .toUpperCase(),
    avatar: memberProfile?.avatar || '',
    name: shownName,
    // As on Desktop: the assistant and team once the employee has set them, otherwise the organization and role.
    detail: memberProfile
      ? 'ผู้ช่วย ' +
        assistantName(memberProfile) +
        (memberProfile.team ? ' · ทีม ' + memberProfile.team.toUpperCase() : '')
      : [
          data.tenants.find((t) => t.id === tenant)?.name,
          own?.role === 'owner' ? 'เจ้าขององค์กร' : own?.role === 'admin' ? 'ผู้ดูแลองค์กร' : 'พนักงาน',
        ]
          .filter(Boolean)
          .join(' · '),
  };
  const skillCount = data.skills.filter(
    (s) => (!s.tenant_id || s.tenant_id === tenant) && !s.metadata.developerOnly,
  ).length;
  const rail = !fullSidebar && !isNarrow;
  const menu: MenuGroup[] = [
    {
      label: 'งาน',
      items: [
        { id: 'new', label: 'เริ่มงานใหม่', hint: mod + 'Alt+N', run: newTask },
        { id: 'palette', label: 'ค้นหางานและคำสั่ง', hint: mod + 'K', run: () => setPalette(true) },
        { id: 'receipt', label: 'ตรวจใบเสร็จ AFP', run: () => changePage('receipt') },
      ],
    },
    {
      label: 'มุมมอง',
      theme: true,
      items: isNarrow
        ? []
        : [{ id: 'left', label: fullSidebar ? 'ย่อแถบงาน' : 'ขยายแถบงาน', run: toggleSidebar }],
    },
    {
      label: 'เครื่องมือ',
      items: tools
        .filter((t) => t.id !== 'receipt')
        .map((t) => ({
          id: t.id,
          label: t.label,
          hint: t.id === 'memory' ? mod + 'Shift+M' : undefined,
          run: () => changePage(t.id),
        })),
    },
    {
      label: 'ช่วยเหลือ',
      items: [
        { id: 'settings', label: 'การตั้งค่า', hint: mod + ',', run: () => changePage('settings') },
        { id: 'help', label: 'คู่มือและความสามารถ', run: () => changePage('help') },
        { id: 'logout', label: 'ออกจากระบบ', run: () => void logout(), danger: true },
      ],
    },
  ];
  const header = page === 'chat' ? null : headers[page];
  return (
    <div className="shell">
      <TitleBar
        groups={menu}
        theme={theme}
        onTheme={setTheme}
        title={page === 'chat' ? session?.title || '' : headers[page][0]}
        sidebarOpen={fullSidebar}
        onSidebar={toggleSidebar}
        onMobileMenu={() => setMobile(true)}
        onPalette={() => setPalette(true)}
        workspaces={workspaces}
        workspaceId={workspaceId}
        onWorkspace={(id) => {
          setWorkspaceId(id);
          setSession(null);
        }}
        onCreateWorkspace={() => setDialog('workspace')}
        onShare={workspace?.created_by === data.user.id ? () => setDialog('share') : undefined}
      />
      <div className="app">
        {mobile && (
          <button
            className="sidebar-scrim"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setMobile(false)}
          />
        )}
        {rail ? (
          <SidebarRail
            page={page}
            profile={profile}
            onPage={changePage}
            onNew={newTask}
            onPalette={() => setPalette(true)}
            onExpand={toggleSidebar}
          />
        ) : (
          <Sidebar
            page={page}
            sessions={sessions}
            currentSession={session?.id}
            skillCount={skillCount}
            profile={profile}
            update={update}
            mobileOpen={mobile}
            onCloseMobile={() => setMobile(false)}
            onPage={changePage}
            onSession={(s) => {
              setSession(s);
              changePage('chat');
            }}
            onNew={newTask}
            onPalette={() => setPalette(true)}
            onSearchAll={(query) => {
              setHistoryQuery(query);
              changePage('history');
            }}
            onUpdate={() => setDialog('update')}
          />
        )}
        <main className="main-pane">
          {header && (
            <header className="topbar">
              <div className="topbar-title">
                <span className="topbar-heading">
                  <strong>{header[0]}</strong>
                </span>
                <small>{header[1]}</small>
              </div>
            </header>
          )}
          <div className={'page ' + (page === 'chat' ? 'chat-page' : '')}>
            <Suspense fallback={<Busy />}>
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
                  artifactSlot={artifactSlot}
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
                  theme={theme}
                  onTheme={setTheme}
                  onLogout={() => void logout()}
                  onTenantChange={(id) => {
                    setSettingsTab('profile');
                    setTenant(id);
                  }}
                />
              )}
              {page === 'skills' && <SkillsHub {...props} onUse={useSkill} />}
              {page === 'document-tools' && (
                <DocumentTools {...props} onPrepare={(work: PreparedWork) => prepareWork(work)} />
              )}
              {page === 'media' && (
                <MediaStudio {...props} onPrepare={(work: PreparedWork) => prepareWork(work)} />
              )}
              {page === 'history' && (
                <History
                  {...props}
                  key={tenant + workspaceId + historyQuery}
                  initialQuery={historyQuery}
                  onOpen={(s) => {
                    setSession(s);
                    changePage('chat');
                  }}
                />
              )}
              {page === 'help' && <Help onOpen={(p) => changePage(p as Page)} />}
            </Suspense>
          </div>
          <footer className="statusbar" aria-label="สถานะ">
            <span className="status-item" role="status">
              <span className={'status-dot ' + (online ? 'ok' : 'off')} aria-hidden="true" />
              {online ? 'พร้อมทำงาน' : 'ออฟไลน์ · เชื่อมต่ออินเทอร์เน็ตเพื่อเปิดข้อมูลและเริ่มงาน'}
            </span>
            {demo && <span className="badge demo">ตัวอย่าง · ไม่ใช่ข้อมูลจริง</span>}
            <span className="spacer" />
            <button className="status-item status-button" onClick={() => setPalette(true)}>
              <Command size={12} />
              คำสั่ง {mod}K
            </button>
          </footer>
        </main>
        <div ref={setArtifactSlot} className="artifact-slot" />
      </div>
      {Boolean(error) && (
        <div className="toast-region">
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
      {palette && (
        <CommandPalette
          data={data}
          tenant={tenant}
          sessions={sessions}
          onClose={() => setPalette(false)}
          onPage={(p) => {
            changePage(p as Page);
            setPalette(false);
          }}
          onSkill={(s) => {
            useSkill(s);
            setPalette(false);
          }}
          onSession={(s) => {
            setSession(s);
            changePage('chat');
            setPalette(false);
          }}
        />
      )}
      {dialog === 'update' && (
        <Modal title="อัปเดตแอป" onClose={() => setDialog(null)}>
          <p>บันทึกร่างที่แก้ไขก่อนอัปเดต แอปจะเปิดใหม่ งานที่เริ่มแล้วจะยังอยู่ในระบบ</p>
          <footer>
            <button onClick={() => setDialog(null)}>ภายหลัง</button>
            <button className="primary" onClick={() => void updateApp()}>
              <Check size={16} />
              อัปเดตตอนนี้
            </button>
          </footer>
        </Modal>
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
