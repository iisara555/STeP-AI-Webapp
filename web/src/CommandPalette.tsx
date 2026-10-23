import { useState } from 'react';
import type { Skill, Snapshot } from '../../packages/harness-core/src/contracts.ts';
import { Modal } from './components.tsx';
export function CommandPalette({
  data,
  tenant,
  onClose,
  onPage,
  onSkill,
}: {
  data: Snapshot;
  tenant: string;
  onClose: () => void;
  onPage: (page: string) => void;
  onSkill: (skill: Skill) => void;
}) {
  const [query, setQuery] = useState('');
  const pages = [
    ['chat', 'งานของฉัน'],
    ['history', 'ค้นงานเก่า'],
    ['skills', 'Skill'],
    ['document-tools', 'ร่างเอกสาร'],
    ['media', 'สื่อภายใน'],
    ['documents', 'เอกสาร'],
    ['memory', 'ความจำ'],
    ['receipt', 'ตรวจใบเสร็จ AFP'],
    ['settings', 'การตั้งค่า'],
    ['help', 'คู่มือและความสามารถ'],
  ];
  const q = query.trim().toLowerCase();
  const skills = data.skills.filter(
    (s) =>
      (!s.tenant_id || s.tenant_id === tenant) &&
      !s.metadata.developerOnly &&
      !s.metadata.webUnsupported &&
      (s.title + ' ' + s.skill_key).toLowerCase().includes(q),
  );
  return (
    <Modal title="ค้นหน้าหรือ Skill" onClose={onClose}>
      <label>
        คำค้น
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ชื่อหน้า งาน หรือ /ชื่อ Skill"
        />
      </label>
      <div className="command-results">
        {pages
          .filter(([key, label]) => (key + ' ' + label).toLowerCase().includes(q))
          .map(([key, label]) => (
            <button key={key} onClick={() => onPage(key)}>
              {label}
            </button>
          ))}
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
