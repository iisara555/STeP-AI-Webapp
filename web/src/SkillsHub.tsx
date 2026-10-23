import { useRef, useState } from 'react';
import { BookOpen, Info, Search } from 'lucide-react';
import type { Skill } from '../../packages/harness-core/src/contracts.ts';
import { Busy, Empty, Modal } from './components.tsx';
import type { ViewProps } from './App.tsx';
const scopeText = (value: unknown) => {
  const scope = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const lines: string[] = [];
  if (Array.isArray(scope.allow))
    lines.push(...scope.allow.filter((v): v is string => typeof v === 'string').map((v) => '• ' + v));
  for (const [key, label] of [
    ['human_only', 'ให้ผู้มีอำนาจตัดสินใจ'],
    ['escalate', 'ส่งให้ทีมที่รับผิดชอบ'],
  ] as const) {
    const section = scope[key];
    if (section && typeof section === 'object')
      for (const item of Object.values(section)) {
        if (item && typeof item === 'object' && 'description' in item && typeof item.description === 'string')
          lines.push(label + ' · ' + item.description);
      }
  }
  return lines.join('\n') || 'ใช้ตามขอบเขตคำแนะนำ Skill และให้คนตรวจผลก่อนนำไปใช้';
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
export function SkillsHub({
  data,
  tenant,
  host,
  fail,
  onUse,
}: ViewProps & { onUse: (skill: Skill) => void }) {
  const [query, setQuery] = useState(''),
    [owner, setOwner] = useState('');
  const [selected, setSelected] = useState<Skill | null>(null),
    [detail, setDetail] = useState<Skill | null>(null),
    [loading, setLoading] = useState(false);
  const request = useRef(0);
  const skills = data.skills.filter(
    (s) => (!s.tenant_id || s.tenant_id === tenant) && !s.metadata.developerOnly,
  );
  const owners = [...new Set(skills.map((s) => String(s.metadata.owner || 'common')))].sort();
  const shown = skills.filter(
    (s) =>
      (!owner || String(s.metadata.owner || 'common') === owner) &&
      [s.title, s.skill_key, s.description, ...strings(s.metadata.triggers)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  async function inspect(s: Skill) {
    const current = ++request.current;
    setSelected(s);
    setDetail(null);
    setLoading(true);
    try {
      const result = await host.call<Skill>('skill.read', { tenant, key: s.skill_key });
      if (current === request.current) setDetail(result);
    } catch (error) {
      if (current === request.current) fail(error);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">วิธีทำงานจาก Desktop</p>
          <h1>Skill</h1>
          <p>ค้นหาตามงาน ทีม หรือคำที่ใช้เรียก แล้วตรวจขอบเขตก่อนเริ่ม</p>
        </div>
      </div>
      <div className="catalog-controls">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="ค้นหา Skill"
            placeholder="ค้นหา Skill หรือคำที่ใช้เรียก"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          ทีมเจ้าของ
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">ทุกทีม</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o === 'common' ? 'ใช้ได้ทุกทีม' : o.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {shown.length} / {skills.length} Skill
        </span>
      </div>
      <div className="skill-grid">
        {shown.map((s) => (
          <article className="skill-card" key={s.id}>
            <div className="skill-card-icon">
              <BookOpen size={23} />
            </div>
            <h2>{s.title}</h2>
            <p>{s.description}</p>
            <code>/{s.skill_key}</code>
            <div className="skill-tags">
              <span className="badge">{s.metadata.webUnsupported ? 'ใช้ใน Desktop' : 'ใช้บนเว็บได้'}</span>
              <span className="badge">{String(s.metadata.owner || 'common').toUpperCase()}</span>
              {typeof s.metadata.stage === 'string' && (
                <span className="badge">{s.metadata.stage === 'pilot' ? 'ทดลอง' : s.metadata.stage}</span>
              )}
            </div>
            <div className="inline-actions">
              <button disabled={Boolean(s.metadata.webUnsupported)} onClick={() => onUse(s)}>
                เริ่มใช้ Skill
              </button>
              <button onClick={() => void inspect(s)} aria-label={'รายละเอียด ' + s.title}>
                <Info size={16} />
                รายละเอียด
              </button>
            </div>
          </article>
        ))}
      </div>
      {!shown.length && (
        <Empty
          icon={<BookOpen size={30} />}
          title={skills.length ? 'ไม่พบ Skill ที่ตรงกับคำค้น' : 'กำลังเตรียม Skill ขององค์กร'}
          detail={
            skills.length
              ? 'ลองเปลี่ยนคำค้นหรือทีมเจ้าของ'
              : 'ผู้ดูแลต้องนำเข้า Skill และเอกสาร STeP ก่อนเปิดใช้งานจริง'
          }
        />
      )}
      {selected && (
        <Modal
          title={selected.title}
          onClose={() => {
            setSelected(null);
            setDetail(null);
          }}
        >
          <p>{selected.description}</p>
          {Boolean(selected.metadata.webUnsupported) && (
            <p>
              Skill นี้ต้องใช้เบราว์เซอร์และสิทธิ์บนเครื่อง Desktop
              เว็บยังไม่เปิดการกรอกหรือส่งแบบฟอร์มแทนผู้ใช้
            </p>
          )}
          <p className="small muted">ต้นทาง: {selected.source_version}</p>
          {loading ? (
            <Busy label="กำลังอ่านรายละเอียด Skill" />
          ) : (
            detail && (
              <>
                <h3>คำที่ใช้เรียก</h3>
                <p>{strings(detail.metadata.triggers).join(' · ') || detail.skill_key}</p>
                <h3>ขอบเขตและเรื่องที่ต้องให้คนตัดสินใจ</h3>
                <pre className="source-text">{scopeText(detail.metadata.scope)}</pre>
                <h3>แหล่งข้อมูลบังคับ</h3>
                <p>{strings(detail.metadata.required_source_keys).join(' · ') || 'ไม่มีรายการเพิ่มเติม'}</p>
                {strings(detail.metadata.missing_required_source_keys).length > 0 && (
                  <p className="warning-text">
                    ยังไม่มีต้นฉบับพร้อมใช้:{' '}
                    {strings(detail.metadata.missing_required_source_keys).join(' · ')}{' '}
                    ให้ยืนยันกับเจ้าของเอกสารก่อนอ้างเป็นข้อกำหนด
                  </p>
                )}
                <p className="small muted">
                  ไฟล์ประกอบที่นำเข้า: {strings(detail.metadata.support_source_keys).length} ไฟล์ · Skill
                  ไม่ให้สิทธิ์อนุมัติหรือส่งข้อมูลแทนคุณ
                </p>
                <details>
                  <summary>อ่านคำแนะนำ Skill</summary>
                  <pre className="source-text">{detail.instructions}</pre>
                </details>
              </>
            )
          )}
          <footer>
            <button onClick={() => setSelected(null)}>ปิด</button>
            {!selected.metadata.webUnsupported && (
              <button
                className="primary"
                onClick={() => {
                  onUse(selected);
                  setSelected(null);
                }}
              >
                เริ่มใช้ Skill
              </button>
            )}
          </footer>
        </Modal>
      )}
    </>
  );
}
