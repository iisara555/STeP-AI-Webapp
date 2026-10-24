import { useState } from 'react';
import {
  DOCUMENT_TOOLS,
  prepareDocument,
  type PreparedWork,
} from '../../packages/harness-core/src/desktop-workflows.ts';
import { Busy } from './components.tsx';
import type { ViewProps } from './App.tsx';

export function DocumentTools({
  fail,
  onPrepare,
}: ViewProps & { onPrepare: (work: PreparedWork) => Promise<void> }) {
  const [id, setId] = useState('tor');
  const [values, setValues] = useState<Record<string, string>>({});
  const [variant, setVariant] = useState('service');
  const [busy, setBusy] = useState(false);
  const tool = DOCUMENT_TOOLS.find((t) => t.id === id)!;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>เครื่องมือร่างเอกสาร</h1>
          <p>กรอกข้อมูลต้นเรื่อง เตรียมร่าง แล้วเลือกเอกสารประกอบก่อนให้ AI ช่วย</p>
        </div>
      </div>
      <div className="workflow-layout">
        <nav className="workflow-menu" aria-label="ประเภทเอกสาร">
          {DOCUMENT_TOOLS.map((t) => (
            <button
              key={t.id}
              className={id === t.id ? 'nav-active' : ''}
              aria-current={id === t.id ? 'true' : undefined}
              onClick={() => {
                setId(t.id);
                setVariant(t.variants[0].id);
                setValues({});
              }}
            >
              {t.title}
            </button>
          ))}
        </nav>
        <form
          className="workflow-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onPrepare(prepareDocument(id, values, variant));
            } catch (error) {
              fail(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{tool.title}</h2>
          <p className="muted">{tool.description}</p>
          <label>
            รูปแบบ
            <select value={variant} onChange={(e) => setVariant(e.target.value)}>
              {tool.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid">
            {tool.fields.map((f) => (
              <label key={f.key} className={f.multiline ? 'full-width' : ''}>
                {f.label}
                {f.multiline ? (
                  <textarea
                    rows={3}
                    maxLength={1800}
                    value={values[f.key] || ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    maxLength={500}
                    value={values[f.key] || ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
                {f.hint && <small className="muted">{f.hint}</small>}
              </label>
            ))}
          </div>
          <p className="small muted">
            ช่องที่ยังไม่มีหลักฐานจะคง “รอยืนยัน” ร่างนี้ยังไม่ใช่การอนุมัติ การออกเลขหนังสือ หรือการลงนาม
            ฟอร์มจะถูกบันทึกในบทสนทนาส่วนตัวเมื่อกดเตรียมงาน
          </p>
          <button className="primary" disabled={busy || !Object.values(values).some((v) => v.trim())}>
            {busy ? <Busy label="กำลังเตรียมร่าง" /> : 'เตรียมร่างในบทสนทนา'}
          </button>
        </form>
      </div>
    </>
  );
}
