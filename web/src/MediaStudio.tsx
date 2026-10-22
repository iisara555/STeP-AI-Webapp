import { useState } from 'react';
import { Copy, Download, Image } from 'lucide-react';
import {
  MEDIA_TYPES,
  MEDIA_STYLE_LABELS,
  MEDIA_RATIOS,
  MEDIA_FONTS,
  MEDIA_SPACE_LABELS,
  compileMedia,
  mediaAiRequest,
  normalizeMedia,
  type MediaState,
} from '../../packages/harness-core/vendor/desktop/internal-media.ts';
import type { PreparedWork } from '../../packages/harness-core/src/desktop-workflows.ts';
import type { ViewProps } from './App.tsx';
import { saveBlob } from './host.ts';
export function MediaStudio({
  fail,
  onPrepare,
}: ViewProps & { onPrepare: (work: PreparedWork) => Promise<void> }) {
  const [state, setState] = useState(normalizeMedia());
  const [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const result = compileMedia(state);
  const update = (key: keyof MediaState, value: string) => {
    setState((s) => normalizeMedia({ ...s, [key]: value }));
    setCopied(false);
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">สื่อสารภายใน · Simple / Service / Sincere</p>
          <h1>สื่อภายใน</h1>
          <p>เตรียมเนื้อหาและ Prompt ด้วยแนวทางเดียวกับ Desktop</p>
        </div>
        <Image size={30} />
      </div>
      <div className="studio-layout">
        <section className="workflow-form" aria-label="ข้อมูลสื่อภายใน">
          <div className="form-grid">
            <label>
              ชนิดงาน
              <select value={state.type} onChange={(e) => update('type', e.target.value)}>
                {Object.entries(MEDIA_TYPES).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              สัดส่วน
              <select value={state.ratio} onChange={(e) => update('ratio', e.target.value)}>
                {MEDIA_RATIOS.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="full-width">
              หัวข้อ
              <input value={state.topic} maxLength={200} onChange={(e) => update('topic', e.target.value)} />
            </label>
            {(
              [
                ['brief', 'ข้อมูลต้นเรื่อง'],
                ['content', 'ข้อความบนสื่อ / ขั้นตอนที่ยืนยันแล้ว'],
                ['visual', 'แนวคิดภาพ'],
                ['source', 'แหล่งข้อมูล'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="full-width">
                {label}
                <textarea
                  rows={key === 'content' ? 5 : 2}
                  value={state[key]}
                  maxLength={3000}
                  onChange={(e) => update(key, e.target.value)}
                />
              </label>
            ))}
            <label>
              สไตล์
              <select value={state.style} onChange={(e) => update('style', e.target.value)}>
                {Object.entries(MEDIA_STYLE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ฟอนต์สำหรับจัดข้อความ
              <select value={state.font} onChange={(e) => update('font', e.target.value)}>
                {MEDIA_FONTS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              การวางข้อความ
              <select value={state.textMode} onChange={(e) => update('textMode', e.target.value)}>
                <option value="SPACE">เว้นพื้นที่เติมข้อความภายหลัง</option>
                <option value="GENERATE">ให้เครื่องมือภาพลองจัดข้อความ</option>
              </select>
            </label>
            <label>
              พื้นที่ว่าง
              <select value={state.position} onChange={(e) => update('position', e.target.value)}>
                {Object.entries(MEDIA_SPACE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            disabled={!state.topic.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onPrepare({
                  title: 'ร่างสื่อภายใน',
                  draft: state.content,
                  message: mediaAiRequest(state),
                  skillKey: 'step-image-prompt',
                });
              } catch (error) {
                fail(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            เตรียมให้ AI ช่วยร่างเนื้อหา
          </button>
        </section>
        <section className="studio-result">
          <h2>ตัวอย่างการจัดวาง</h2>
          <div className="media-preview" style={{ aspectRatio: state.ratio.replace(':', ' / ') }}>
            <span>{MEDIA_TYPES[state.type]}</span>
            <h3>{state.topic || 'หัวข้อสื่อ'}</h3>
            <p>{state.content || 'ข้อความที่จะให้ผู้อ่านเห็น'}</p>
            <small>ภาพตัวอย่างโครงวาง · ยังไม่ได้สร้างภาพ</small>
          </div>
          <p className="small muted">
            ใช้สี STeP #FFC709 / #231F20 ห้ามวาดโลโก้ใหม่ ตรวจภาษา ฟอนต์ และข้อมูลก่อนเผยแพร่
          </p>
          {result.missing.length > 0 && <p role="status">ยังขาด: {result.missing.join(' · ')}</p>}
          {result.warnings.map((w) => (
            <p key={w} className="warning-text">
              {w}
            </p>
          ))}
          <div className="inline-actions">
            <button
              disabled={!result.ready}
              onClick={() =>
                void navigator.clipboard
                  .writeText(result.prompt)
                  .then(() => setCopied(true))
                  .catch(fail)
              }
            >
              <Copy size={16} />
              {copied ? 'คัดลอกแล้ว' : 'คัดลอก Prompt'}
            </button>
            <button
              disabled={!result.ready}
              onClick={() =>
                saveBlob(
                  new Blob([result.prompt], { type: 'text/plain;charset=utf-8' }),
                  'สื่อภายใน-prompt.txt',
                )
              }
            >
              <Download size={16} />
              บันทึก Prompt
            </button>
          </div>
          <p className="small muted">
            หน้าเว็บนี้สร้าง Prompt ในเครื่อง การสร้างภาพผ่าน API ยังไม่เปิดใช้
            เมื่อคัดลอกไปใช้กับบริการอื่นให้ตรวจข้อมูลและสิทธิ์ของบริการนั้นก่อน
          </p>
          <details>
            <summary>ดู Prompt</summary>
            <pre className="source-text">{result.prompt}</pre>
          </details>
        </section>
      </div>
    </>
  );
}
