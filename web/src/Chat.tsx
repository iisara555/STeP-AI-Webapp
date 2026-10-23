import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  BookOpen,
  Brain,
  Check,
  Copy,
  Download,
  FileText,
  MessageSquare,
  Paperclip,
  Plus,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ChatMessage,
  Conversation,
  Run,
  Skill,
  SourceRef,
} from '../../packages/harness-core/src/contracts.ts';
import { errorView } from '../../packages/harness-core/src/index.ts';
import { ApiError, saveBlob } from './host.ts';
import { Busy, Empty, Modal, Visibility } from './components.tsx';
import type { ViewProps } from './App.tsx';
import { exportWord } from './extract.ts';
import { startersFor, starterTeams } from '../../packages/harness-core/vendor/desktop/starters.ts';
import { parseDocumentOutput } from '../../packages/harness-core/vendor/desktop/document-output.ts';
import type { PreparedWork } from '../../packages/harness-core/src/desktop-workflows.ts';
type Plan = {
  provider: string;
  providerConsent: string;
  documents: { id: string; name: string }[];
  memories: { id: string; title: string }[];
  google: boolean;
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
}: ViewProps & {
  session: Conversation | null;
  setSession: (s: Conversation | null) => void;
  skill: Skill | null;
  clearSkill: () => void;
  newSession: () => void;
  prepared: { sessionId: string; text: string } | null;
  consumePrepared: () => void;
  onPrepare: (work: PreparedWork) => Promise<void>;
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
    [draft, setDraft] = useState('');
  const [source, setSource] = useState<{ title: string; body: string } | null>(null),
    [remember, setRemember] = useState<ChatMessage | null>(null);
  const [starterTeam, setStarterTeam] = useState(''),
    [starting, setStarting] = useState(false);
  const [wordPreset, setWordPreset] = useState<'saraban' | 'report' | 'book'>('report');
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null),
    currentSession = useRef(session?.id);
  currentSession.current = session?.id;
  useEffect(() => {
    setMessages([]);
    setRun(null);
    setText(prepared && prepared.sessionId === session?.id ? prepared.text : '');
    if (prepared?.sessionId === session?.id) consumePrepared();
    setDocuments([]);
    setPlan(null);
    setDraftOpen(Boolean(prepared?.sessionId === session?.id && session?.draft));
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
        setRun(
          result.runs.find((r) => ['queued', 'running', 'waiting_approval'].includes(r.status)) ||
            result.runs[0] ||
            null,
        );
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
  }, [run?.id, tenant, host, session?.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [messages.length, run?.status]);
  const active = Boolean(run && ['queued', 'running', 'waiting_approval'].includes(run.status));
  const visibleDocs = data.documents.filter(
    (d) =>
      d.tenant_id === tenant &&
      d.status === 'ready' &&
      (session?.visibility !== 'workspace' ||
        (d.visibility === 'workspace' && d.workspace_id === workspace?.id)),
  );
  const preview = async () => {
    if (!session || !text.trim() || active) return;
    const id = session.id;
    setBusy(true);
    try {
      const result = await host.call<Plan>('context.plan', {
        tenant,
        session: id,
        message: text,
        documentIds: documents,
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
  if (!session)
    return (
      <div className="chat-welcome">
        <div className="welcome-mark brand-logo">
          <img className="brand-colour" src="/step-symbol-colour.svg" alt="STeP" />
          <img className="brand-white" src="/step-symbol-mono-white.svg" alt="STeP" />
        </div>
        <p className="eyebrow">จากคำขอ สู่งานที่ใช้ต่อได้</p>
        <h1>{skill ? skill.title : 'วันนี้อยากให้ช่วยเรื่องอะไร'}</h1>
        <p>
          เริ่มงานส่วนตัว เลือกเอกสารที่เกี่ยวข้อง
          <br />
          แล้วให้ AI ช่วยจัดข้อมูลและเตรียมขั้นตอนถัดไป
        </p>
        <button className="primary" onClick={newSession}>
          <Plus size={19} />
          เริ่มงานใหม่
        </button>
        <section className="team-starters">
          <label>
            ตัวอย่างงานตามทีม
            <select value={starterTeam} onChange={(e) => setStarterTeam(e.target.value)}>
              <option value="">งานทั่วไป</option>
              {starterTeams.map((team) => (
                <option key={team} value={team}>
                  {team.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          {startersFor(starterTeam).map((starter) => (
            <button
              key={starter.th}
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                try {
                  await onPrepare({ title: starter.tag.th, draft: '', message: starter.th });
                } catch (error) {
                  fail(error);
                } finally {
                  setStarting(false);
                }
              }}
            >
              <small>{starter.tag.th}</small>
              {starter.th}
            </button>
          ))}
        </section>
        <div className="welcome-features">
          <span>
            <Brain size={19} />
            ใช้ความจำที่คุณเลือก
          </span>
          <span>
            <FileText size={19} />
            อ้างอิงจากเอกสาร
          </span>
          <span>
            <MessageSquare size={19} />
            กลับมาทำงานต่อได้
          </span>
        </div>
      </div>
    );
  return (
    <div className={'conversation-layout ' + (draftOpen ? 'with-draft' : '')}>
      <section className="conversation">
        <div className="conversation-heading">
          <div>
            <h1>{session.title}</h1>
            <Visibility shared={session.visibility === 'workspace'} />
          </div>
          <div className="inline-actions">
            <button onClick={() => setDraftOpen((v) => !v)}>
              <FileText size={16} />
              {draftOpen ? 'ซ่อนร่าง' : 'ร่างเอกสาร'}
            </button>
            <button
              className="icon-button"
              aria-label="ส่งออกบทสนทนา"
              onClick={() =>
                saveBlob(
                  new Blob(
                    [
                      messages
                        .map((m) => `## ${m.role === 'user' ? 'คุณ' : 'STeP AI'}\n\n${m.body}`)
                        .join('\n\n'),
                    ],
                    { type: 'text/markdown;charset=utf-8' },
                  ),
                  'บทสนทนา.md',
                )
              }
            >
              <Download size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="ลบบทสนทนา"
              onClick={() => setSource({ title: 'ลบบทสนทนา', body: 'delete-confirm' })}
            >
              <Trash2 size={17} />
            </button>
          </div>
        </div>
        <div className="messages" aria-live="polite">
          {!messages.length && (
            <Empty
              icon={<MessageSquare size={30} />}
              title="เริ่มจากสิ่งที่อยากให้ช่วย"
              detail="ระบุงานที่ต้องทำ ผลลัพธ์ที่ต้องการ และเลือกเอกสารที่เกี่ยวข้อง"
            >
              <div className="suggestions">
                {['ช่วยวางโครงร่างเอกสาร', 'ช่วยสรุปเอกสารที่เลือก', 'พรุ่งนี้มีประชุมอะไรบ้าง'].map((s) => (
                  <button key={s} onClick={() => setText(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </Empty>
          )}
          {messages.map((m) => (
            <article
              key={m.id}
              className={'message ' + (m.role === 'user' ? 'user-message' : 'assistant-message')}
            >
              <div className="message-name">{m.role === 'user' ? 'คุณ' : 'STeP AI'}</div>
              <div className="message-body">{m.body}</div>
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
                    <Copy size={15} />
                  </button>
                  <button onClick={() => setRemember(m)}>
                    <Brain size={15} />
                    บันทึกความจำ
                  </button>
                  <button
                    onClick={() => {
                      try {
                        const match = /<document_draft>/.test(m.body);
                        setDraft(match ? parseDocumentOutput(m.body, 'tor').draft : m.body);
                      } catch {
                        setDraft(m.body);
                      }
                      setDraftOpen(true);
                    }}
                  >
                    <FileText size={15} />
                    ใช้เป็นร่าง
                  </button>
                </div>
              )}
            </article>
          ))}
          {active && (
            <div className="run-progress">
              <Busy label={run?.status === 'queued' ? 'กำลังรอคิว AI' : 'AI กำลังอ่านข้อมูลที่คุณเลือก'} />
              <p>คุณกลับมาดูงานนี้ภายหลังได้</p>
            </div>
          )}
          {run && ['failed', 'interrupted', 'cancelled'].includes(run.status) && (
            <div className="run-status">
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
        <div className="composer-wrap">
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void preview();
            }}
          >
            {skill && (
              <span className="skill-chip">
                Skill · {skill.title}
                <button type="button" aria-label="นำ Skill ออก" onClick={clearSkill}>
                  <X size={14} />
                </button>
              </span>
            )}
            <textarea
              aria-label="ข้อความถึง AI"
              placeholder="พิมพ์สิ่งที่อยากให้ช่วย…"
              value={text}
              maxLength={20000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void preview();
                }
              }}
              rows={3}
            />
            <div className="composer-tools">
              <div className="inline-actions">
                <button type="button" onClick={() => setShowFiles((v) => !v)}>
                  <Paperclip size={17} />
                  {documents.length ? `${documents.length} เอกสาร` : 'เลือกเอกสาร'}
                </button>
                {session.visibility === 'private' && (
                  <label className="checkbox-row compact">
                    <input
                      type="checkbox"
                      checked={useMemory}
                      onChange={(e) => setUseMemory(e.target.checked)}
                    />
                    ใช้ความจำของฉัน
                  </label>
                )}
              </div>
              {active ? (
                <button
                  type="button"
                  className="stop-button"
                  aria-label="หยุดงาน"
                  disabled={run?.actor_id !== data.user.id}
                  onClick={() =>
                    void host
                      .call('run.cancel', { tenant, id: run?.id })
                      .then(() => setRun((r) => (r ? { ...r, status: 'cancelled' } : null)))
                      .catch(fail)
                  }
                >
                  <Square size={16} />
                </button>
              ) : (
                <button className="send-button" aria-label="ส่งข้อความ" disabled={!text.trim() || busy}>
                  {busy ? <Busy label="" /> : <ArrowUp size={20} />}
                </button>
              )}
            </div>
          </form>
          <p className="composer-note">ตรวจข้อมูลสำคัญกับเอกสารต้นฉบับก่อนนำไปใช้</p>
        </div>
      </section>
      {draftOpen && (
        <aside className="draft-panel">
          <header>
            <h2>ร่างเอกสาร</h2>
            <button className="icon-button" onClick={() => setDraftOpen(false)} aria-label="ปิดร่าง">
              <X size={18} />
            </button>
          </header>
          <div className="draft-toolbar">
            <button onClick={() => setDraft((d) => d + '\n\n## หัวข้อ\n')}>หัวข้อ</button>
            <button onClick={() => setDraft((d) => d + '\n- รายการ\n')}>รายการ</button>
            <button
              onClick={() =>
                setDraft((d) => d + '\n\n| หัวข้อ | รายละเอียด |\n| --- | --- |\n| รายการ | รอยืนยัน |\n')
              }
            >
              ตาราง
            </button>
            <label>
              รูปแบบ Word
              <select
                aria-label="รูปแบบ Word"
                value={wordPreset}
                onChange={(e) => setWordPreset(e.target.value as typeof wordPreset)}
              >
                <option value="saraban">สารบรรณ · 16 pt</option>
                <option value="report">รายงาน · 14 pt</option>
                <option value="book">หนังสือ · 16 pt</option>
              </select>
            </label>
          </div>
          <textarea
            ref={draftInput}
            aria-label="ร่างเอกสาร"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="ใช้คำตอบเป็นร่าง หรือเริ่มพิมพ์เองได้"
          />
          <p className="small muted draft-note">
            ร่าง Markdown · Word ยังไม่ฝังฟอนต์หรือตราครุฑ ตรวจรูปแบบกับแบบของหน่วยงานก่อนใช้
          </p>
          <footer>
            <button
              onClick={() =>
                void host
                  .call<Conversation>('session.draft', {
                    tenant,
                    id: session.id,
                    version: session.version,
                    draft,
                  })
                  .then((s) => setSession(s))
                  .catch(fail)
              }
            >
              <Check size={15} />
              บันทึก
            </button>
            <button
              disabled={!draft.trim()}
              onClick={() => void exportWord(draft, session.title, wordPreset).catch(fail)}
            >
              <Download size={15} />
              Word (.docx)
            </button>
            <button
              disabled={!draft.trim()}
              onClick={() =>
                saveBlob(new Blob([draft], { type: 'text/plain;charset=utf-8' }), 'ร่างเอกสาร.txt')
              }
            >
              ข้อความ (.txt)
            </button>
          </footer>
        </aside>
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
                  kind: 'preference',
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
