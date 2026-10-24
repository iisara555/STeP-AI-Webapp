import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Blocks,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Heading2,
  List,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  Table,
  Trash2,
  X,
} from './icons.tsx';
import type {
  ChatMessage,
  Conversation,
  Run,
  Skill,
  SourceRef,
} from '../../packages/harness-core/src/contracts.ts';
import { errorView } from '../../packages/harness-core/src/index.ts';
import { saveBlob } from './host.ts';
import { Art, Busy, FreeTierNote, MEMORY_KINDS, Modal, Segmented, Visibility } from './components.tsx';
import type { ViewProps } from './App.tsx';
import type { ExportChoice } from './DraftExport.tsx';
import { startersFor, starterTeams } from '../../packages/harness-core/vendor/desktop/starters.ts';
import { teamLabel } from '../../packages/harness-core/vendor/desktop/teams.ts';
import { assistantName } from '../../packages/harness-core/src/assistant-profile.ts';
import { parseDocumentOutput } from '../../packages/harness-core/vendor/desktop/document-output.ts';
import type { DocumentToolId } from '../../packages/harness-core/vendor/desktop/document-tools.ts';
import { resolvePresentation } from '../../packages/harness-core/vendor/desktop/document-presentation.ts';
import { isDocumentTool } from '../../packages/harness-core/src/document-context.ts';
import type { PreparedWork } from '../../packages/harness-core/src/desktop-workflows.ts';
// Word, PDF and the page preview load the Markdown reader, Garuda and layout only when a draft is exported or previewed.
const DraftExport = lazy(() => import('./DraftExport.tsx').then((m) => ({ default: m.DraftExport })));
const DraftPage = lazy(() => import('./DraftExport.tsx').then((m) => ({ default: m.DraftPage })));
type Plan = {
  provider: string;
  providerConsent: string;
  documents: { id: string; name: string }[];
  memories: { id: string; title: string }[];
  google: boolean;
  /** True when the employee's own name and answer style travel with the request. */
  profile?: boolean;
};
/** Text handed to a newly created task; `submit` opens the consent preview right away. */
export type PreparedText = {
  sessionId: string;
  text: string;
  submit?: boolean;
  documents?: string[];
  documentTool?: string;
};
/** A document answer's two blocks, as Desktop separates them; null when the answer is ordinary chat. */
const documentParts = (body: string, tool?: DocumentToolId) => {
  if (!body.includes('<document_draft>')) return null;
  try {
    return parseDocumentOutput(body, tool || 'tor');
  } catch {
    return null;
  }
};
const titleFrom = (text: string) => {
  const line = text.trim().split('\n')[0];
  return line.length > 60 ? line.slice(0, 57) + '…' : line || 'งานใหม่';
};
export function Chat({
  host,
  data,
  tenant,
  workspace,
  refresh,
  fail,
  session,
  setSession,
  skill,
  clearSkill,
  newSession,
  prepared,
  consumePrepared,
  onPrepare,
  artifactSlot,
}: ViewProps & {
  session: Conversation | null;
  setSession: (s: Conversation | null) => void;
  skill: Skill | null;
  clearSkill: () => void;
  newSession: () => void;
  prepared: PreparedText | null;
  consumePrepared: () => void;
  onPrepare: (work: PreparedWork, options?: { submit?: boolean; documents?: string[] }) => Promise<void>;
  artifactSlot: HTMLElement | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [run, setRun] = useState<Run | null>(null),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false);
  const [useMemory, setUseMemory] = useState(true),
    [documents, setDocuments] = useState<string[]>([]),
    [showFiles, setShowFiles] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null),
    [googleConsent, setGoogleConsent] = useState(false),
    [draftOpen, setDraftOpen] = useState(false),
    [draft, setDraft] = useState(''),
    [menu, setMenu] = useState(false);
  const [source, setSource] = useState<{ title: string; body: string } | null>(null),
    [remember, setRemember] = useState<ChatMessage | null>(null);
  const [documentTool, setDocumentTool] = useState<DocumentToolId | undefined>();
  const memberProfile = data.profiles?.find((p) => p.tenant_id === tenant);
  const assistant = assistantName(memberProfile);
  const [starterTeam, setStarterTeam] = useState(
    memberProfile?.team && starterTeams.includes(memberProfile.team) ? memberProfile.team : '',
  );
  // Export layout follows the document tool, as on Desktop: official drafts start on the สารบรรณ page with page numbers.
  const [presentation, setPresentation] = useState(() => resolvePresentation()),
    [exportChoice, setExportChoice] = useState<ExportChoice>({ font: 'auto', garuda: 'auto' }),
    [draftView, setDraftView] = useState<'edit' | 'page'>('edit');
  useEffect(() => {
    setPresentation(resolvePresentation({}, Boolean(documentTool)));
    setExportChoice({ font: 'auto', garuda: 'auto' });
  }, [session?.id, documentTool]);
  const composer = useRef<HTMLTextAreaElement>(null),
    autoPreview = useRef(false);
  const bottom = useRef<HTMLDivElement>(null),
    currentSession = useRef(session?.id);
  currentSession.current = session?.id;
  useEffect(() => {
    const handoff = prepared && prepared.sessionId === session?.id ? prepared : null;
    setMessages([]);
    setRun(null);
    setText(handoff ? handoff.text : '');
    if (handoff) consumePrepared();
    autoPreview.current = Boolean(handoff?.submit);
    setDocuments(handoff?.documents || []);
    setDocumentTool(isDocumentTool(handoff?.documentTool) ? handoff.documentTool : undefined);
    setPlan(null);
    setMenu(false);
    setDraftOpen(Boolean(handoff && session?.draft));
    setDraft(session?.draft || '');
    if (!session) return;
    const id = session.id;
    let active = true;
    void host
      .call<{ session: Conversation; messages: ChatMessage[]; runs: Run[] }>('session.read', { tenant, id })
      .then((result) => {
        if (!active) return;
        setMessages(result.messages);
        setDraft(result.session.draft);
        setSession(result.session);
        // A reopened drafting task keeps its document tool, recorded on its earlier runs.
        const tool = handoff?.documentTool || result.runs.find((r) => r.document_tool)?.document_tool;
        setDocumentTool(isDocumentTool(tool) ? tool : undefined);
        setRun(
          result.runs.find((r) => ['queued', 'running', 'waiting_approval'].includes(r.status)) ||
            result.runs[0] ||
            null,
        );
        if (autoPreview.current && handoff) {
          autoPreview.current = false;
          void preview(id, handoff.text, handoff.documents || []);
        }
      })
      .catch((e) => {
        if (active) fail(e);
      });
    return () => {
      active = false;
    };
  }, [session?.id, tenant, host]);
  useEffect(() => {
    if (!run || !['queued', 'running', 'waiting_approval'].includes(run.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await host.call<Run>('run.read', { tenant, id: run.id });
        if (stopped) return;
        setRun(updated);
        if (['queued', 'running', 'waiting_approval'].includes(updated.status)) {
          timer = setTimeout(poll, document.hidden ? 5000 : 1500);
          return;
        }
        if (session) {
          const result = await host.call<{ session: Conversation; messages: ChatMessage[] }>('session.read', {
            tenant,
            id: session.id,
          });
          if (!stopped) {
            setMessages(result.messages);
            setSession(result.session);
            // As on Desktop, a fresh document answer is staged in the draft pane for review; saving stays manual.
            const answer = [...result.messages].reverse().find((m) => m.role === 'assistant');
            const staged = documentTool && answer ? documentParts(answer.body, documentTool) : null;
            if (staged?.draft) {
              setDraft(staged.draft);
              setDraftOpen(true);
            }
            await refresh();
          }
        }
      } catch (e) {
        if (!stopped) {
          fail(e);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [run?.id, tenant, host, session?.id, documentTool]);
  useEffect(() => {
    // The home screen opens at its greeting; only a conversation follows its newest turn.
    if (messages.length) bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [messages.length, run?.status]);
  const active = Boolean(run && ['queued', 'running', 'waiting_approval'].includes(run.status));
  const visibleDocs = data.documents.filter(
    (d) =>
      d.tenant_id === tenant &&
      d.status === 'ready' &&
      (session?.visibility !== 'workspace' ||
        (d.visibility === 'workspace' && d.workspace_id === workspace?.id)),
  );
  // Text typed on the home screen starts a private task; the consent preview opens before any AI call.
  const preview = async (id = session?.id, message = text, documentIds = documents) => {
    if (!id || !message.trim() || active) return;
    setBusy(true);
    try {
      const result = await host.call<Plan>('context.plan', {
        tenant,
        session: id,
        message,
        documentIds,
        useMemory,
      });
      if (currentSession.current === id) {
        setPlan(result);
        setGoogleConsent(false);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    if (session) return preview();
    setBusy(true);
    try {
      await onPrepare(
        { title: titleFrom(text), draft: '', message: text, skillKey: skill?.skill_key },
        { submit: true, documents },
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!session || !plan) return;
    const id = session.id;
    setBusy(true);
    try {
      const result = await host.call<Run>('run.start', {
        tenant,
        session: id,
        kind: 'chat',
        requestId: crypto.randomUUID(),
        message: text,
        skill: skill?.skill_key,
        documentTool,
        documentIds: documents,
        useMemory,
        consent: true,
        providerConsent: plan.providerConsent,
        googleConsent,
      });
      if (currentSession.current !== id) return;
      setPlan(null);
      setText('');
      setRun(result);
      const state = await host.call<{ session: Conversation; messages: ChatMessage[] }>('session.read', {
        tenant,
        id,
      });
      setMessages(state.messages);
      await refresh();
    } catch (e) {
      setPlan(null);
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const openSource = async (ref: SourceRef) => {
    try {
      if (ref.kind === 'organization') {
        const value = await host.call<{ title: string; body: string }>('knowledge.read', {
          tenant,
          key: ref.id,
        });
        setSource(value);
      } else if (ref.kind === 'document') {
        const doc = data.documents.find((d) => d.id === ref.id);
        if (doc?.object_path) saveBlob(await host.download(doc.object_path), doc.name);
      } else
        setSource({
          title: ref.title,
          body: 'อ่านจาก Google Calendar ของบัญชีที่คุณเชื่อมต่อ ภายในช่วงเวลาที่ระบุในแหล่งอ้างอิง',
        });
    } catch (e) {
      fail(e);
    }
  };
  const removeSession = async () => {
    if (!session) return;
    try {
      await host.call('session.delete', { tenant, id: session.id });
      setSession(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  };
  const saveDraft = () =>
    session &&
    void host
      .call<Conversation>('session.draft', { tenant, id: session.id, version: session.version, draft })
      .then((s) => setSession(s))
      .catch(fail);
  const called = memberProfile?.display_name || data.user.name?.split(' ')[0] || '';
  // As on Desktop: the name the employee chose, then their team.
  const greeting =
    (called ? 'สวัสดีครับ คุณ' + called : 'สวัสดีครับ') +
    (memberProfile?.team ? ' · ' + teamLabel(memberProfile.team) : '');
  const starters = startersFor(starterTeam);
  // Every source the answers in this task cited, once each, so the draft keeps its provenance in view.
  const draftSources = [
    ...new Map(messages.flatMap((m) => m.sources || []).map((s) => [s.kind + s.id, s])).values(),
  ];
  return (
    <div className="chat-layout">
      <div className="conversation-col">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-heading">
              <strong>{session?.title || (skill ? skill.title : 'เริ่มต้นงานที่อยากทำ')}</strong>
              {session && (
                <button
                  className="icon-button"
                  aria-label="ตัวเลือกงานนี้"
                  title="ตัวเลือกงานนี้"
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  onClick={() => setMenu(!menu)}
                >
                  <ChevronDown size={16} />
                </button>
              )}
            </span>
            {menu && session && (
              <>
                <button
                  className="menu-backdrop"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={() => setMenu(false)}
                />
                <div
                  className="title-menu"
                  role="menu"
                  aria-label="ตัวเลือกงานนี้"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setMenu(false);
                  }}
                >
                  <button
                    role="menuitem"
                    autoFocus
                    onClick={() => {
                      setMenu(false);
                      saveBlob(
                        new Blob(
                          [
                            messages
                              .map((m) => `## ${m.role === 'user' ? 'คุณ' : assistant}\n\n${m.body}`)
                              .join('\n\n'),
                          ],
                          { type: 'text/markdown;charset=utf-8' },
                        ),
                        'บทสนทนา.md',
                      );
                    }}
                  >
                    <Download size={15} />
                    ส่งออก Markdown
                  </button>
                  <hr />
                  <button
                    role="menuitem"
                    className="titlebar-danger"
                    onClick={() => {
                      setMenu(false);
                      setSource({ title: 'ลบงานนี้', body: 'delete-confirm' });
                    }}
                  >
                    <Trash2 size={15} />
                    ลบงานนี้
                  </button>
                </div>
              </>
            )}
            <small>
              {session ? (
                <Visibility shared={session.visibility === 'workspace'} />
              ) : (
                'จากคำขอ สู่ผลงานที่ใช้ต่อได้'
              )}
            </small>
          </div>
          {session && (
            <div className="topbar-actions">
              <button onClick={() => setDraftOpen((v) => !v)} aria-pressed={draftOpen}>
                <FileText size={16} />
                {draftOpen ? 'ซ่อนร่าง' : 'เปิดร่าง'}
              </button>
            </div>
          )}
        </header>
        <div className="conversation" aria-live="polite">
          {!messages.length && (
            <div className="welcome">
              <div className="welcome-intro">
                <div className="welcome-heading">
                  <p className="greet">{greeting}</p>
                  <h1>
                    ให้ AI ร่างงานหนัก
                    <br />
                    <em>ส่วนคุณตัดสินเรื่องสำคัญ</em>
                  </h1>
                </div>
                <Art scene="chat" className="welcome-illustration" />
              </div>
              <div className="suggestions-label">
                <span>
                  {starterTeam
                    ? 'ลองงานแรกของทีม ' + teamLabel(starterTeam)
                    : 'ลองงานแรกที่คนส่วนใหญ่ใช้บ่อย'}
                </span>
                <select
                  aria-label="ตัวอย่างงานตามทีม"
                  value={starterTeam}
                  onChange={(e) => setStarterTeam(e.target.value)}
                >
                  <option value="">งานทั่วไป</option>
                  {starterTeams.map((team) => (
                    <option key={team} value={team}>
                      ทีม {team.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div className="suggestions">
                {starters.map((starter) => (
                  <button
                    key={starter.th}
                    onClick={() => {
                      setText(starter.th);
                      composer.current?.focus();
                    }}
                  >
                    <Sparkles size={16} />
                    <span>
                      <small className="starter-tag">{starter.tag.th}</small>
                      {starter.th}
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
              <p className="welcome-lede">
                ผู้ช่วยที่รู้จักงานของ STeP สรุปเอกสารยาว ร่างหนังสือ วางแผนโครงการ และตรวจความพร้อมก่อนส่ง
                ทุกร่างผ่านตาคุณก่อนใช้จริง
              </p>
              <ul className="welcome-trust">
                <li>
                  <ShieldCheck size={14} />
                  เห็นข้อมูลที่ AI จะอ่านก่อนยืนยันทุกครั้ง
                </li>
                <li>
                  <Check size={14} />
                  AI ร่าง คนตรวจและอนุมัติ
                </li>
                <li>
                  <Blocks size={14} />
                  รู้จักทีมและ Skill ของ STeP
                </li>
              </ul>
            </div>
          )}
          {messages.map((m) => (
            <article
              key={m.id}
              className={'message ' + (m.role === 'user' ? 'user' : 'assistant')}
              aria-label={m.role === 'user' ? 'คุณ' : assistant}
            >
              {m.role === 'assistant' && documentParts(m.body, documentTool) ? (
                <>
                  <p className="draft-staged">
                    <FileText size={14} />
                    ร่างเอกสารอยู่ในแผงผลงาน · ด้านล่างคือผลตรวจและสิ่งที่ต้องยืนยัน ไม่อยู่ในตัวเอกสาร
                  </p>
                  <div className="message-body">
                    {documentParts(m.body, documentTool)!.review || 'ไม่มีรายการที่ต้องตรวจเพิ่ม'}
                  </div>
                </>
              ) : (
                <div className="message-body">{m.body}</div>
              )}
              {m.sources?.length > 0 && (
                <div className="sources">
                  {m.sources.map((s) => (
                    <button key={s.id} onClick={() => void openSource(s)}>
                      <BookOpen size={13} />
                      {s.title}
                    </button>
                  ))}
                </div>
              )}
              {m.role === 'assistant' && (
                <div className="message-actions">
                  <button
                    onClick={() => void navigator.clipboard.writeText(m.body).catch(fail)}
                    aria-label="คัดลอกคำตอบ"
                  >
                    <Copy size={14} />
                  </button>
                  <button onClick={() => setRemember(m)}>
                    <Brain size={14} />
                    บันทึกความจำ
                  </button>
                  <button
                    onClick={() => {
                      setDraft(documentParts(m.body, documentTool)?.draft ?? m.body);
                      setDraftOpen(true);
                    }}
                  >
                    <FileText size={14} />
                    ใช้เป็นร่าง
                  </button>
                </div>
              )}
            </article>
          ))}
          {active && (
            <div className="activity">
              <Busy
                label={run?.status === 'queued' ? 'กำลังรอคิว AI' : assistant + ' กำลังอ่านข้อมูลที่คุณเลือก'}
              />
              <p>คุณกลับมาดูงานนี้ภายหลังได้</p>
            </div>
          )}
          {run && ['failed', 'interrupted', 'cancelled'].includes(run.status) && (
            <div className={'run-status ' + (run.status === 'cancelled' ? 'neutral' : '')} role="status">
              <strong>
                {run.status === 'cancelled'
                  ? 'หยุดงานแล้ว'
                  : errorView(run.error_code || 'RUN_INTERRUPTED').title}
              </strong>
              <p>
                {run.status === 'cancelled'
                  ? 'คำตอบที่บันทึกแล้วจะยังอยู่'
                  : errorView(run.error_code || 'RUN_INTERRUPTED').detail}
              </p>
              <small>รหัสปัญหา: {run.error_code || run.status}</small>
            </div>
          )}
          <div ref={bottom} />
        </div>
        <div className="composer-area">
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {skill && (
              <span className="skill-chip">
                Skill · {skill.title}
                <button type="button" aria-label="นำ Skill ออก" onClick={clearSkill}>
                  <X size={13} />
                </button>
              </span>
            )}
            <textarea
              ref={composer}
              aria-label="ข้อความถึง AI"
              placeholder="พิมพ์สิ่งที่อยากให้ช่วย…"
              value={text}
              maxLength={20000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
            />
            <div className="composer-tools">
              <button
                type="button"
                className="composer-add"
                aria-label={documents.length ? `เอกสารที่เลือก ${documents.length} รายการ` : 'เลือกเอกสาร'}
                title="เลือกเอกสารให้ AI อ่าน"
                onClick={() => setShowFiles((v) => !v)}
              >
                <Plus size={15} />
                {documents.length ? `${documents.length} เอกสาร` : 'เอกสาร'}
              </button>
              {session?.visibility !== 'workspace' && (
                <label className="pill">
                  <input
                    type="checkbox"
                    checked={useMemory}
                    onChange={(e) => setUseMemory(e.target.checked)}
                  />
                  ใช้ความจำของฉัน
                </label>
              )}
              <span className="spacer" />
              {active ? (
                <button
                  type="button"
                  className="stop"
                  aria-label="หยุดงาน"
                  disabled={run?.actor_id !== data.user.id}
                  onClick={() =>
                    void host
                      .call('run.cancel', { tenant, id: run?.id })
                      .then(() => setRun((r) => (r ? { ...r, status: 'cancelled' } : null)))
                      .catch(fail)
                  }
                >
                  <Square size={14} />
                </button>
              ) : (
                <button className="send" aria-label="ส่งข้อความ" disabled={!text.trim() || busy}>
                  {busy ? <Busy label="" /> : <ArrowUp size={17} />}
                </button>
              )}
            </div>
          </form>
          <p className="composer-note">
            {!session && workspace
              ? `ข้อความจากหน้านี้เริ่มงานส่วนตัว · กด “เริ่มงานใหม่” เพื่อแชร์ใน ${workspace.name}`
              : 'ตรวจข้อมูลและร่างก่อนนำไปใช้ · ประวัติเก็บในบัญชี STeP ของคุณ'}
          </p>
        </div>
      </div>
      {draftOpen &&
        session &&
        artifactSlot &&
        createPortal(
          <aside className="artifact-pane" aria-label="ผลงาน">
            <header className="artifact-header">
              <FileText size={17} />
              <strong>ผลงาน</strong>
              <button className="icon-button" onClick={() => setDraftOpen(false)} aria-label="ปิดร่าง">
                <X size={17} />
              </button>
            </header>
            <div className="draft-title">
              <span>{session.title}</span>
              <small>
                {!draft.trim()
                  ? 'ยังไม่มีร่าง · ใช้คำตอบเป็นร่าง หรือพิมพ์เองได้'
                  : draft === session.draft
                    ? 'ร่าง Markdown · บันทึกแล้ว'
                    : 'ร่าง Markdown · ยังไม่บันทึก'}
              </small>
            </div>
            <div className="draft-toolbar" role="toolbar" aria-label="จัดรูปแบบร่าง">
              <button onClick={() => setDraft((d) => d + '\n\n## หัวข้อ\n')}>
                <Heading2 size={15} />
                หัวข้อ
              </button>
              <button onClick={() => setDraft((d) => d + '\n- รายการ\n')}>
                <List size={15} />
                รายการ
              </button>
              <button
                onClick={() =>
                  setDraft((d) => d + '\n\n| หัวข้อ | รายละเอียด |\n| --- | --- |\n| รายการ | รอยืนยัน |\n')
                }
              >
                <Table size={15} />
                ตาราง
              </button>
              <Segmented
                label="มุมมองร่าง"
                className="segmented draft-view"
                value={draftView}
                onChange={setDraftView}
                options={[
                  { value: 'edit', label: 'แก้ไข' },
                  { value: 'page', label: 'หน้ากระดาษ', disabled: !draft.trim() },
                ]}
              />
            </div>
            {draftView === 'page' && draft.trim() ? (
              <Suspense fallback={<Busy label="กำลังจัดหน้า" />}>
                <DraftPage draft={draft} documentTool={documentTool} choice={exportChoice} />
              </Suspense>
            ) : (
              <textarea
                className="draft-editor"
                aria-label="ร่างเอกสาร"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="ใช้คำตอบเป็นร่าง หรือเริ่มพิมพ์เองได้"
              />
            )}
            <details className="draft-sources">
              <summary>แหล่งอ้างอิงที่ใช้ ({draftSources.length})</summary>
              {draftSources.length ? (
                <ul>
                  {draftSources.map((s) => (
                    <li key={s.kind + s.id}>
                      <button onClick={() => void openSource(s)}>
                        <BookOpen size={12} />
                        {s.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">คำตอบในงานนี้ยังไม่ได้อ้างอิงเอกสารหรือความรู้องค์กร</p>
              )}
            </details>
            <p className="draft-note">
              {['memo', 'letter'].includes(documentTool || '')
                ? 'ตราครุฑและการจัดหน้าเป็นแบบทำงานตามระเบียบงานสารบรรณ ตรวจกับแบบของหน่วยงานก่อนเสนอ'
                : 'การจัดหน้าเป็นแบบทำงาน ตรวจกับแบบของหน่วยงานก่อนใช้'}
            </p>
            <Suspense
              fallback={
                <footer className="artifact-footer">
                  <Busy label="กำลังเตรียมการส่งออก" />
                </footer>
              }
            >
              <DraftExport
                draft={draft}
                title={session.title}
                documentTool={documentTool}
                choice={exportChoice}
                onChoice={setExportChoice}
                presentation={presentation}
                onPresentation={setPresentation}
                onError={fail}
                leading={
                  <button onClick={saveDraft}>
                    <Save size={15} />
                    บันทึก
                  </button>
                }
              />
            </Suspense>
          </aside>,
          artifactSlot,
        )}
      {showFiles && (
        <Modal title="เอกสารที่ให้ AI อ่านในงานนี้" onClose={() => setShowFiles(false)}>
          <p className="muted">
            เลือกเฉพาะเอกสารที่เกี่ยวข้องกับคำถาม บทสนทนาที่แชร์จะใช้เอกสารส่วนตัวไม่ได้
          </p>
          <div className="file-options">
            {visibleDocs.map((d) => (
              <label key={d.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={documents.includes(d.id)}
                  disabled={!documents.includes(d.id) && documents.length >= 8}
                  onChange={(e) =>
                    setDocuments((old) =>
                      e.target.checked ? [...old, d.id] : old.filter((id) => id !== d.id),
                    )
                  }
                />
                <span>
                  {d.name}
                  <Visibility shared={d.visibility === 'workspace'} />
                </span>
              </label>
            ))}
            {!visibleDocs.length && <p>ยังไม่มีเอกสารที่พร้อมใช้ เพิ่มเอกสารจากเมนู “เอกสาร” ได้ครับ</p>}
          </div>
          <footer>
            <button className="primary" onClick={() => setShowFiles(false)}>
              ใช้เอกสารที่เลือก
            </button>
          </footer>
        </Modal>
      )}
      {plan && (
        <Modal title="ข้อมูลที่จะให้ AI อ่าน" onClose={() => setPlan(null)}>
          <p className="muted">ส่งให้ {plan.provider} เพื่อทำงานตามคำขอนี้</p>
          <ul className="consent-list">
            <li>ข้อความที่พิมพ์และบทสนทนาที่เกี่ยวข้อง</li>
            {plan.profile && <li>ชื่อเรียก ทีม และสไตล์การตอบที่คุณตั้งไว้</li>}
            {plan.documents.map((d) => (
              <li key={d.id}>เอกสาร · {d.name}</li>
            ))}
            {plan.memories.map((m) => (
              <li key={m.id}>ความจำ · {m.title}</li>
            ))}
          </ul>
          {plan.google && (
            <label className="checkbox-row consent-check">
              <input
                type="checkbox"
                checked={googleConsent}
                onChange={(e) => setGoogleConsent(e.target.checked)}
              />
              อ่าน Google Calendar ของฉันตามช่วงเวลาที่ถาม
            </label>
          )}
          <FreeTierNote ai={data.ai} />
          <p className="small muted">การอ่านครั้งนี้ไม่อนุญาตให้ส่งอีเมล เปลี่ยนปฏิทิน หรือแชร์ไฟล์</p>
          <footer>
            <button onClick={() => setPlan(null)}>กลับไปแก้ข้อความ</button>
            <button
              className="primary"
              disabled={busy || (plan.google && !googleConsent)}
              onClick={() => void submit()}
            >
              {busy ? <Busy label="กำลังเริ่มงาน" /> : 'เริ่มงาน'}
            </button>
          </footer>
        </Modal>
      )}
      {source && (
        <Modal title={source.title} onClose={() => setSource(null)}>
          {source.body === 'delete-confirm' ? (
            <>
              <p>ลบบทสนทนาและร่างนี้ออกจากระบบ ข้อมูลสำรองอาจยังอยู่ตามระยะเวลาที่องค์กรกำหนด</p>
              <footer>
                <button onClick={() => setSource(null)}>ยกเลิก</button>
                <button
                  className="danger"
                  onClick={() => {
                    setSource(null);
                    void removeSession();
                  }}
                >
                  ลบบทสนทนา
                </button>
              </footer>
            </>
          ) : (
            <pre className="source-text">{source.body}</pre>
          )}
        </Modal>
      )}
      {remember && (
        <Modal title="บันทึกความจำส่วนตัว" onClose={() => setRemember(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              try {
                await host.call('memory.save', {
                  tenant,
                  workspace: null,
                  visibility: 'private',
                  title: form.get('title'),
                  body: form.get('body'),
                  kind: form.get('kind'),
                  origin: 'chat',
                });
                setRemember(null);
                await refresh();
              } catch (error) {
                fail(error);
              }
            }}
          >
            <p className="muted">
              เก็บเฉพาะสิ่งที่ต้องการให้ใช้ในงานถัดไป ตรวจข้อความก่อนบันทึก ความจำไม่ใช่การยืนยันว่าคำตอบ AI
              ถูกต้อง
            </p>
            <label>
              ชื่อความจำ
              <input name="title" maxLength={120} required />
            </label>
            <label>
              ประเภท
              <select name="kind" defaultValue="preference">
                {MEMORY_KINDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              สิ่งที่ต้องการจำ
              <textarea
                name="body"
                rows={7}
                maxLength={4000}
                defaultValue={remember.body.slice(0, 4000)}
                required
              />
            </label>
            <footer>
              <button type="button" onClick={() => setRemember(null)}>
                ยกเลิก
              </button>
              <button className="primary">ยืนยันและบันทึก</button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
