import { useState } from 'react';
import type { Conversation, Skill, Snapshot } from '../../packages/harness-core/src/contracts.ts';
import { Modal } from './components.tsx';
import { tools } from './Sidebar.tsx';
/** Search tasks, pages and Skills in one list, as Desktop's command bar does. */
export function CommandPalette({
  data,
  tenant,
  sessions,
  onClose,
  onPage,
  onSkill,
  onSession,
}: {
  data: Snapshot;
  tenant: string;
  sessions: Conversation[];
  onClose: () => void;
  onPage: (page: string) => void;
  onSkill: (skill: Skill) => void;
  onSession: (session: Conversation) => void;
}) {
  const [query, setQuery] = useState('');
  const pages: [string, string][] = [
    ['chat', 'งานของฉัน'],
    ...tools.map((t): [string, string] => [t.id, t.label]),
    ['settings', 'การตั้งค่า'],
    ['help', 'คู่มือและความสามารถ'],
  ];
  const q = query.trim().toLowerCase();
  const tasks = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)).slice(0, 8) : [];
  const skills = data.skills.filter(
    (s) =>
      (!s.tenant_id || s.tenant_id === tenant) &&
      !s.metadata.developerOnly &&
      !s.metadata.webUnsupported &&
      (s.title + ' ' + s.skill_key).toLowerCase().includes(q.replace(/^\//, '')),
  );
  const shownPages = pages.filter(([key, label]) => (key + ' ' + label).toLowerCase().includes(q));
  return (
    <Modal title="ค้นหางานและคำสั่ง" onClose={onClose}>
      <label>
        คำค้น
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ชื่องาน หน้า หรือ /ชื่อ Skill"
        />
      </label>
      <div className="command-results">
        {tasks.length > 0 && <div className="command-group">งาน</div>}
        {tasks.map((s) => (
          <button key={s.id} onClick={() => onSession(s)}>
            <span>{s.title}</span>
            <small>{s.visibility === 'workspace' ? 'แชร์ใน workspace' : 'ส่วนตัว'}</small>
          </button>
        ))}
        {shownPages.length > 0 && <div className="command-group">หน้าและเครื่องมือ</div>}
        {shownPages.map(([key, label]) => (
          <button key={key} onClick={() => onPage(key)}>
            {label}
          </button>
        ))}
        {skills.length > 0 && <div className="command-group">Skill</div>}
        {skills.slice(0, 20).map((s) => (
          <button key={s.id} onClick={() => onSkill(s)}>
            <span>{s.title}</span>
            <small>/{s.skill_key}</small>
          </button>
        ))}
      </div>
      <p className="small muted">ใช้ Tab และ Enter เพื่อเลือก · Esc เพื่อปิด</p>
    </Modal>
  );
}
