import { useState } from 'react';
import { CircleHelp, ExternalLink, Search, Download } from 'lucide-react';
import {
  DESKTOP_BASELINE,
  DESKTOP_FEATURES,
  FEATURE_STATUS,
  desktopSourceUrl,
  type FeatureStatus,
} from '../../packages/harness-core/src/desktop-reference.ts';
import { saveBlob } from './host.ts';
export function Help({ onOpen }: { onOpen: (page: string) => void }) {
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('');
  const shown = DESKTOP_FEATURES.filter(
    (f) =>
      (!status || f.status === status) &&
      `${f.title} ${f.category} ${f.desktop} ${f.web}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">คู่มือและความสามารถ</p>
          <h1>รู้จัก STeP AI</h1>
          <p>อ้างอิง Desktop {DESKTOP_BASELINE.version} · ตรวจได้ว่าหน้าเว็บรองรับส่วนใดแล้ว</p>
        </div>
        <CircleHelp size={30} />
      </div>
      <section className="guide-start">
        <h2>เริ่มทำงาน</h2>
        <ol>
          <li>เริ่มงานส่วนตัว หรือเลือก workspace ที่ต้องการแชร์</li>
          <li>เลือก Skill / แบบฟอร์ม และแนบเฉพาะเอกสารที่เกี่ยวข้อง</li>
          <li>ตรวจรายการข้อมูลและบริการ AI ก่อนกดยืนยันแต่ละคำขอ</li>
          <li>ตรวจคำตอบกับแหล่งอ้างอิง แก้ร่างและส่งออก ไม่มีการอนุมัติหรือส่งเอกสารแทนคุณ</li>
        </ol>
        <p className="small muted">
          Ctrl/⌘+K เปิดคำสั่ง · Ctrl/⌘+Alt+N เริ่มงาน · Ctrl/⌘+Shift+M ความจำ · Ctrl/⌘+, ตั้งค่า
        </p>
      </section>
      <div className="catalog-controls">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="ค้นความสามารถ"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นความสามารถหรือข้อจำกัด"
          />
        </label>
        <label>
          สถานะบนเว็บ
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">ทุกสถานะ</option>
            {Object.entries(FEATURE_STATUS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span>
          {shown.length} / {DESKTOP_FEATURES.length} หมวด
        </span>
      </div>
      <div className="feature-list">
        {shown.map((f) => (
          <article key={f.id}>
            <header>
              <div>
                <small className="muted">{f.category}</small>
                <h2>{f.title}</h2>
              </div>
              <span className="badge">{FEATURE_STATUS[f.status as FeatureStatus]}</span>
            </header>
            <p>
              <strong>Desktop:</strong> {f.desktop}
            </p>
            <p>
              <strong>ในเว็บนี้:</strong> {f.web}
            </p>
            <footer>
              {f.target && f.target !== 'help' && (
                <button onClick={() => onOpen(f.target!)}>เปิดหน้าที่เกี่ยวข้อง</button>
              )}
              <details>
                <summary>แหล่งอ้างอิงต้นทาง</summary>
                {f.sources.map((s) => (
                  <a key={s} href={desktopSourceUrl(s)} target="_blank" rel="noreferrer">
                    {s}
                    <ExternalLink size={12} />
                  </a>
                ))}
              </details>
            </footer>
          </article>
        ))}
      </div>
      <section className="guide-start">
        <h2>แจ้งปัญหา / เสนอแนะ</h2>
        <p>
          บันทึกแบบรายงานแล้วตรวจข้อความก่อนส่งให้ผู้ดูแลด้วยช่องทางขององค์กร ไม่แนบรหัสผ่าน คีย์
          หรือเอกสารพนักงาน
        </p>
        <button
          onClick={() =>
            saveBlob(
              new Blob(
                [
                  'STeP AI Webapp — รายงานปัญหา\n\nหน้าที่พบปัญหา:\nขั้นตอนที่ทำ:\nสิ่งที่คาดหวัง:\nสิ่งที่เกิดขึ้น / รหัสปัญหา:\nวันเวลา:\n\nตรวจและลบข้อมูลส่วนบุคคล/ความลับก่อนส่ง\n',
                ],
                { type: 'text/plain;charset=utf-8' },
              ),
              'แบบรายงานปัญหา.txt',
            )
          }
        >
          <Download size={16} />
          ดาวน์โหลดแบบรายงาน
        </button>
        <p className="small muted">
          การทดสอบด้วยข้อมูลตัวอย่างไม่ยืนยันว่า Google, AI หรือ homelab พร้อมใช้จริง
        </p>
      </section>
    </>
  );
}
