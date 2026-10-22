import { useEffect, useState } from 'react';
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Link2,
  LogOut,
  Pause,
  Play,
  ShieldCheck,
  Unlink,
  Users,
} from 'lucide-react';
import type { AiService, Membership } from '../../packages/harness-core/src/contracts.ts';
import type { ViewProps } from './App.tsx';
import { Busy, Modal, bytes, number } from './components.tsx';
import { OpenRouterTrial } from './OpenRouterTrial.tsx';
type GoogleState = { status: string; services: string[] };
type Usage = {
  runs: { input_tokens: number; output_tokens: number; reserved_cents: number; status: string }[];
  visibleBytes: number;
  aiConfigured: boolean;
  model: string;
  ai?: AiService;
};
export function SettingsView({
  host,
  data,
  tenant,
  refresh,
  fail,
  onLogout,
  onTenantChange,
  initialTab,
}: ViewProps & { onLogout: () => void; onTenantChange: (id: string) => void; initialTab?: string }) {
  const [tab, setTab] = useState(initialTab || 'account'),
    [google, setGoogle] = useState<GoogleState | null>(null),
    [usage, setUsage] = useState<Usage | null>(null),
    [members, setMembers] = useState<Membership[]>([]),
    [invites, setInvites] = useState<{ email: string; accepted_at: string | null }[]>([]),
    [busy, setBusy] = useState(false),
    [inviting, setInviting] = useState(false),
    [disconnect, setDisconnect] = useState(false),
    [notice, setNotice] = useState('');
  const own = data.memberships.find((m) => m.tenant_id === tenant),
    org = data.tenants.find((t) => t.id === tenant)!,
    admin = own?.role === 'owner' || own?.role === 'admin';
  useEffect(() => {
    if (initialTab) setTab(initialTab === 'team' && !admin ? 'account' : initialTab);
  }, [initialTab, admin]);
  const load = async () => {
    const [g, u] = await Promise.all([
      host.call<GoogleState>('google.state', { tenant }),
      host.call<Usage>('usage', { tenant }),
    ]);
    setGoogle(g);
    setUsage(u);
    if (admin) {
      const result = await host.call<{
        members: Membership[];
        invites: { email: string; accepted_at: string | null }[];
      }>('admin.members', { tenant });
      setMembers(result.members);
      setInvites(result.invites);
    }
  };
  useEffect(() => {
    void load().catch(fail);
  }, [tenant, host]);
  const connect = async () => {
    setBusy(true);
    try {
      const result = await host.call<{ url: string }>('google.connect', {
        tenant,
        services: ['calendar-read', 'drive-selected'],
      });
      if (host.demo) {
        await load();
        setNotice('เชื่อมต่อแล้วในโหมดตัวอย่าง');
      } else location.assign(result.url);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const control = async (state: string) => {
    setBusy(true);
    try {
      await host.call('google.control', { tenant, state });
      await load();
      setDisconnect(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const aiReady = Boolean(
    usage?.aiConfigured &&
    (usage.ai?.textOnly ? admin && org.free_ai_trial_enabled : org.monthly_ai_budget_cents > 0),
  );
  const totalTokens = usage?.runs.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0) || 0;
  const cost = usage?.runs.reduce((n, r) => n + r.reserved_cents, 0) || 0;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">บัญชี การเชื่อมต่อ และข้อมูลของคุณ</p>
          <h1>การตั้งค่า</h1>
          <p>ตรวจสถานะและจัดการสิ่งที่แอปเข้าถึงได้</p>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="หมวดการตั้งค่า">
          {[
            { key: 'account', title: 'บัญชีและองค์กร', icon: Users },
            { key: 'ai', title: 'เชื่อมต่อ AI', icon: Brain },
            { key: 'google', title: 'Google Workspace', icon: Link2 },
            { key: 'privacy', title: 'ข้อมูลและความเป็นส่วนตัว', icon: ShieldCheck },
            { key: 'usage', title: 'ปริมาณการใช้', icon: FolderOpen },
            ...(admin ? [{ key: 'team', title: 'จัดการสมาชิก', icon: Users }] : []),
          ].map((item) => (
            <button
              key={item.key}
              className={tab === item.key ? 'selected' : ''}
              onClick={() => setTab(item.key)}
            >
              <item.icon size={18} />
              {item.title}
              <ChevronRight size={15} />
            </button>
          ))}
        </nav>
        <section className="settings-content">
          {notice && (
            <p className="success-notice" role="status">
              {notice}
            </p>
          )}
          {tab === 'account' && (
            <>
              <h2>บัญชีและองค์กร</h2>
              <div className="settings-card">
                <div className="account-details">
                  <span className="avatar large">{data.user.name?.slice(0, 1) || 'S'}</span>
                  <div>
                    <h3>{data.user.name || 'บัญชีของคุณ'}</h3>
                    <p>{data.user.email}</p>
                    <span className="badge">ลงชื่อเข้าใช้ด้วย Google</span>
                  </div>
                </div>
                <label>
                  องค์กร
                  <select value={tenant} onChange={(e) => onTenantChange(e.target.value)}>
                    {data.tenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted">
                  สิทธิ์ของคุณ:{' '}
                  {own?.role === 'owner'
                    ? 'เจ้าขององค์กร'
                    : own?.role === 'admin'
                      ? 'ผู้ดูแลองค์กร'
                      : 'พนักงาน'}
                </p>
                <button onClick={onLogout}>
                  <LogOut size={16} />
                  ออกจากระบบในเครื่องนี้
                </button>
              </div>
            </>
          )}
          {tab === 'ai' && (
            <>
              <h2>เชื่อมต่อ AI</h2>
              <p className="muted">STeP จัดการบริการและวงเงินให้ คุณไม่ต้องตั้งค่า API key เอง</p>
              <div className="settings-card">
                <div className="service-status">
                  <span className="service-icon">
                    <Brain size={27} />
                  </span>
                  <div>
                    <h3>AI ขององค์กร</h3>
                    <p>{usage?.ai?.displayName || usage?.model || 'Google Gemini API'}</p>
                  </div>
                  <span className={'badge ' + (aiReady ? 'ready' : '')}>
                    {aiReady ? 'พร้อมใช้' : 'ยังไม่พร้อมใช้'}
                  </span>
                </div>
                {!aiReady && (
                  <p className="warning-note">
                    {usage?.ai?.textOnly
                      ? admin
                        ? 'เซิร์ฟเวอร์เลือก OpenRouter รุ่นฟรีสำหรับผู้ดูแล แชตองค์กรยังต้องเปิดทดลองแยกต่างหาก คุณใช้ช่องทดลองข้อความด้านล่างได้เมื่อผู้ดูแลระบบตั้งค่าแล้ว'
                        : 'รุ่นฟรีเปิดให้ผู้ดูแลทดลองเท่านั้น'
                      : admin
                        ? 'ตั้งค่าคีย์ที่ฝั่งเซิร์ฟเวอร์ แล้วกำหนดวงเงินและอัตราค่าบริการก่อนเปิดใช้งาน'
                        : 'ผู้ดูแลกำลังเตรียมบริการ AI และวงเงินขององค์กร'}
                  </p>
                )}
                <p className="small muted">
                  แชต อ่านเอกสาร และตรวจใบเสร็จใช้วงเงินร่วมกัน ไม่มีการเปลี่ยนผู้ให้บริการอัตโนมัติ
                </p>
              </div>
              {admin && <OpenRouterTrial key={tenant} host={host} tenant={tenant} />}
              {admin && !usage?.ai?.textOnly && (
                <form
                  className="settings-card"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    setBusy(true);
                    try {
                      await host.call('admin.ai', {
                        tenant,
                        budgetCents: Math.round(Number(form.get('budget')) * 100),
                        inputRate: Number(form.get('inputRate')),
                        outputRate: Number(form.get('outputRate')),
                      });
                      await refresh();
                      await load();
                      setNotice('บันทึกวงเงินแล้ว');
                    } catch (err) {
                      fail(err);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <h3>วงเงินสำหรับช่วงทดลอง</h3>
                  <p className="muted small">
                    วงเงินในแอปช่วยจำกัดการเริ่มงาน ควรตรวจยอดจริงกับ Google
                    และตั้งอัตราให้ครอบคลุมโมเดลแชตกับ embedding ก่อนเปิดใช้
                  </p>
                  <label>
                    วงเงินต่อเดือน (USD)
                    <input
                      name="budget"
                      type="number"
                      min="0"
                      max="1000"
                      step="0.01"
                      defaultValue={org.monthly_ai_budget_cents / 100}
                      required
                    />
                  </label>
                  <label>
                    ราคา input ต่อ 1 ล้าน tokens (US cents)
                    <input
                      name="inputRate"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={org.input_cents_per_million || ''}
                      required
                    />
                  </label>
                  <label>
                    ราคา output ต่อ 1 ล้าน tokens (US cents)
                    <input
                      name="outputRate"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={org.output_cents_per_million || ''}
                      required
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    บันทึกวงเงิน
                  </button>
                </form>
              )}
            </>
          )}
          {tab === 'google' && (
            <>
              <h2>Google Workspace</h2>
              <p className="muted">แยกจากการล็อกอินเข้า STeP คุณหยุดหรือยกเลิกสิทธิ์ได้</p>
              <div className="settings-card">
                <div className="service-status">
                  <span className="google-letter">G</span>
                  <div>
                    <h3>บัญชี Google ของคุณ</h3>
                    <p>{data.user.email}</p>
                  </div>
                  <span className={'badge ' + (google?.status === 'ready' ? 'ready' : '')}>
                    {google?.status === 'ready'
                      ? 'พร้อมใช้'
                      : google?.status === 'paused'
                        ? 'หยุดการใช้งานไว้'
                        : google?.status === 'reauth_required'
                          ? 'ต้องเชื่อมต่ออีกครั้ง'
                          : 'ยังไม่ได้เชื่อมต่อ'}
                  </span>
                </div>
                <ul className="plain-list">
                  <li>
                    <CheckCircle2 size={17} />
                    อ่านนัดหมายใน Google Calendar
                  </li>
                  <li>
                    <CheckCircle2 size={17} />
                    อ่านไฟล์ Drive ที่คุณเลือกให้แอปเข้าถึง
                  </li>
                </ul>
                <p className="small muted">
                  การอ่านไม่อนุญาตให้ส่งอีเมล แก้ปฏิทิน หรือแชร์ไฟล์ สิทธิ์ยังขึ้นกับนโยบายบัญชี Google
                  Workspace ของ STeP
                </p>
                <div className="inline-actions">
                  {google?.status === 'ready' ? (
                    <>
                      <button disabled={busy} onClick={() => void control('paused')}>
                        <Pause size={16} />
                        หยุดการใช้ข้อมูลบัญชี
                      </button>
                      <button onClick={() => setDisconnect(true)}>
                        <Unlink size={16} />
                        ยกเลิกการเชื่อมต่อ
                      </button>
                    </>
                  ) : google?.status === 'paused' ? (
                    <button className="primary" disabled={busy} onClick={() => void control('ready')}>
                      <Play size={16} />
                      กลับมาใช้ข้อมูลบัญชี
                    </button>
                  ) : (
                    <button className="primary" disabled={busy} onClick={() => void connect()}>
                      <Link2 size={16} />
                      {google?.status === 'reauth_required'
                        ? 'เชื่อมต่อ Google อีกครั้ง'
                        : 'เชื่อมต่อ Google'}
                    </button>
                  )}
                </div>
                {busy && <Busy label="กำลังตรวจการเชื่อมต่อ" />}
              </div>
            </>
          )}
          {tab === 'privacy' && (
            <>
              <h2>ข้อมูลและความเป็นส่วนตัว</h2>
              <div className="settings-card">
                <h3>คุณเลือกสิ่งที่แชร์ได้</h3>
                <ul className="privacy-list">
                  <li>
                    <strong>ความจำส่วนตัว</strong>
                    <p>เจ้าของเท่านั้นที่เปิดอ่านผ่านแอปได้ ไม่ใช้ในบทสนทนาที่แชร์โดยอัตโนมัติ</p>
                  </li>
                  <li>
                    <strong>เอกสารและบทสนทนา</strong>
                    <p>เริ่มเป็นส่วนตัว เลือกแชร์ใน workspace ก่อนเพิ่มข้อมูลให้ทีม</p>
                  </li>
                  <li>
                    <strong>การใช้ AI</strong>
                    <p>
                      แอปแสดงข้อมูลและบริการ AI ที่จะรับข้อมูลก่อนเริ่มงาน เอกสารที่อัปโหลดยังไม่ถูกส่งไป AI
                      ทันที
                    </p>
                  </li>
                  <li>
                    <strong>เมื่อออกจากระบบ</strong>
                    <p>
                      ล้างข้อมูลหน้าจอและการเข้าใช้ในเครื่องนี้ ไม่เก็บบทสนทนาหรือเอกสารไว้ในแคชออฟไลน์ของ PWA
                    </p>
                  </li>
                  <li>
                    <strong>การดูแลระบบ</strong>
                    <p>
                      ผู้ดูแลสมาชิกไม่มีสิทธิ์เปิดเนื้อหาส่วนตัวผ่านแอปโดยอัตโนมัติ
                      ผู้ถือสิทธิ์ดูแลฐานข้อมูลยังมีอำนาจทางเทคนิค
                    </p>
                  </li>
                </ul>
              </div>
            </>
          )}
          {tab === 'usage' && (
            <>
              <h2>ปริมาณการใช้</h2>
              <div className="usage-grid">
                <div className="metric">
                  <span>token เดือนนี้</span>
                  <strong>{number(totalTokens)}</strong>
                  <small>{admin ? 'ยอดรวมขององค์กร' : 'เฉพาะงานของคุณ'}</small>
                </div>
                <div className="metric">
                  <span>วงเงินที่ใช้และสำรองไว้</span>
                  <strong>${(cost / 100).toFixed(2)}</strong>
                  <small>เทียบยอดเรียกเก็บจริงกับผู้ให้บริการ</small>
                </div>
                <div className="metric">
                  <span>{admin ? 'พื้นที่ที่ใช้ในองค์กร' : 'พื้นที่ที่คุณใช้'}</span>
                  <strong>{bytes(usage?.visibleBytes || 0)}</strong>
                  <small>พื้นที่ส่วนตัวเริ่มต้น {bytes(org.member_storage_limit)}</small>
                </div>
              </div>
              <div className="settings-card">
                <h3>พื้นที่เริ่มต้นขององค์กร</h3>
                <p>
                  {bytes(org.storage_limit)} สำหรับไฟล์ที่อัปโหลดและภาพที่เตรียมอ่าน เอกสารบน Drive
                  เก็บเป็นรายการอ้างอิง
                </p>
                <p className="muted">
                  งานที่ยังไม่เสร็จหรือเชื่อมต่อขาดช่วงอาจยังสำรองวงเงินไว้
                  เพื่อป้องกันการใช้เกินโดยไม่ทราบยอดจากผู้ให้บริการ
                </p>
              </div>
            </>
          )}
          {tab === 'team' && admin && (
            <>
              <div className="section-heading">
                <h2>จัดการสมาชิก</h2>
                <button className="primary" onClick={() => setInviting(true)}>
                  เชิญพนักงาน
                </button>
              </div>
              <p className="muted">เพิ่มรายชื่อก่อนให้พนักงานล็อกอินด้วย Google ไม่ส่งอีเมลอัตโนมัติ</p>
              <div className="settings-card member-list">
                {members.map((m) => (
                  <div key={m.user_id}>
                    <div>
                      <strong>{m.display_name || m.email || 'สมาชิก'}</strong>
                      <p>{m.email}</p>
                    </div>
                    <span className="badge">
                      {m.role === 'owner'
                        ? 'เจ้าของ'
                        : m.role === 'admin'
                          ? 'ผู้ดูแล'
                          : m.active
                            ? 'พร้อมใช้'
                            : 'ถูกระงับ'}
                    </span>
                    {m.role === 'member' && (
                      <button
                        onClick={() =>
                          void host
                            .call('admin.member-state', { tenant, userId: m.user_id, active: !m.active })
                            .then(load)
                            .catch(fail)
                        }
                      >
                        {m.active ? 'ระงับการเข้าใช้' : 'กลับมาใช้ได้'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {invites.filter((i) => !i.accepted_at).length > 0 && (
                <div className="settings-card">
                  <h3>รอพนักงานเข้าร่วม</h3>
                  {invites
                    .filter((i) => !i.accepted_at)
                    .map((i) => (
                      <p key={i.email}>{i.email}</p>
                    ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {inviting && (
        <Modal title="เชิญพนักงานเข้า STeP" onClose={() => setInviting(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              try {
                await host.call('admin.invite', { tenant, email: form.get('email'), role: form.get('role') });
                await load();
                setInviting(false);
                setNotice('เพิ่มรายชื่อแล้ว ส่งลิงก์แอปให้พนักงานล็อกอินด้วยบัญชีนี้ได้');
              } catch (err) {
                fail(err);
              }
            }}
          >
            <label>
              อีเมลบัญชี Google
              <input type="email" name="email" autoFocus required />
            </label>
            <label>
              สิทธิ์
              <select name="role">
                <option value="member">พนักงาน</option>
                {own?.role === 'owner' && <option value="admin">ผู้ดูแลองค์กร</option>}
              </select>
            </label>
            <footer>
              <button type="button" onClick={() => setInviting(false)}>
                ยกเลิก
              </button>
              <button className="primary">เพิ่มรายชื่อพนักงาน</button>
            </footer>
          </form>
        </Modal>
      )}
      {disconnect && (
        <Modal title="ยกเลิกการเชื่อมต่อ Google" onClose={() => setDisconnect(false)}>
          <p>
            ลบสิทธิ์ที่ STeP เก็บไว้ แอปจะอ่านข้อมูล Google ของบัญชีนี้ไม่ได้จนกว่าคุณจะเชื่อมต่อใหม่
            ข้อมูลที่บันทึกใน STeP แล้วยังอยู่
          </p>
          <footer>
            <button onClick={() => setDisconnect(false)}>ยกเลิก</button>
            <button className="danger" onClick={() => void control('disconnect')}>
              ยกเลิกการเชื่อมต่อ
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
