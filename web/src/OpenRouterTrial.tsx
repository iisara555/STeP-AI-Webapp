import { useEffect, useState } from 'react';
import type { Host } from './host.ts';
import { Busy, ErrorNotice, number } from './components.tsx';

type Model = { id: string; name: string };
type Result = {
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  cost: number | null;
  truncated: boolean;
};
export function OpenRouterTrial({ host, tenant }: { host: Host; tenant: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null),
    [statusRevision, setStatusRevision] = useState(0),
    [checking, setChecking] = useState(true),
    [loaded, setLoaded] = useState(false),
    [models, setModels] = useState<Model[]>([]),
    [model, setModel] = useState(''),
    [prompt, setPrompt] = useState('ช่วยเสนอขั้นตอนเตรียมประชุมทีมตัวอย่าง 3 ข้อ'),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    setChecking(true);
    setError(null);
    void host.call<{ configured: boolean }>('admin.openrouter.status', { tenant }).then(
      (value) => {
        if (active) {
          setConfigured(value.configured);
          setChecking(false);
        }
      },
      (err: unknown) => {
        if (active) {
          setError(err);
          setChecking(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [host, tenant, statusRevision]);
  return (
    <section className="settings-card" aria-labelledby="openrouter-heading">
      <h3 id="openrouter-heading">ทดลอง OpenRouter Free สำหรับผู้ดูแล</h3>
      <p>ลองข้อความตัวอย่างก่อนตัดสินใจซื้อ API แบบ Pay-as-you-go</p>
      <p className="small muted">
        ส่งเฉพาะข้อความที่พิมพ์ในช่องนี้ไปยัง OpenRouter และผู้ให้บริการโมเดล
        ข้อมูลทดลองอาจถูกเก็บหรือใช้ฝึกโมเดลตามนโยบายผู้ให้บริการ กรุณาใช้ข้อมูลสมมติ ไม่มีการแนบเอกสาร ความจำ
        แชตเดิม หรือข้อมูล Google Workspace
      </p>
      {host.demo && <p className="warning-note">ตัวอย่างหน้าจอเท่านั้น · ไม่ได้เรียก OpenRouter จริง</p>}
      {error != null && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
      {checking && <Busy label="กำลังตรวจสถานะ OpenRouter" />}
      {!checking && configured === null && (
        <button type="button" onClick={() => setStatusRevision((n) => n + 1)}>
          ตรวจสถานะอีกครั้ง
        </button>
      )}
      {configured === false && (
        <p className="warning-note">
          ยังไม่เปิดใช้ OpenRouter สำหรับองค์กรนี้
          ผู้ดูแลเซิร์ฟเวอร์ต้องตั้งคีย์และเปิดสิทธิ์ทดลองให้กับองค์กรก่อน
        </p>
      )}
      <p className="small muted">
        เฉพาะโมเดล :free ที่ราคาเป็นศูนย์ · เพดานราคา $0 · ตอบสูงสุด 512 tokens · ช่องนี้จำกัดรวมองค์กร 5
        ครั้ง/นาที ทุกช่องทดลองในบัญชีเดียวกันรวม 40 ครั้ง/วัน (UTC) รวมคำขอที่ล้มเหลว โควตาจริงของ OpenRouter
        อาจต่ำกว่านี้ ไม่มีการส่งซ้ำหรือเปลี่ยนเป็นโมเดลเสียเงินอัตโนมัติ
      </p>
      <button
        type="button"
        disabled={!configured || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setResult(null);
          setModels([]);
          setModel('');
          setConsent(false);
          setLoaded(false);
          try {
            const value = await host.call<{ models: Model[] }>('admin.openrouter.models', { tenant });
            setModels(value.models);
            setModel(value.models[0]?.id || '');
            setLoaded(true);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        โหลดรายการโมเดลฟรี
      </button>
      {configured && models.length === 0 && (
        <p className="small muted">
          {loaded
            ? 'ขณะนี้ไม่มีโมเดลฟรีที่ผ่านเงื่อนไข ลองโหลดรายการใหม่ภายหลัง'
            : 'โหลดรายการเพื่อเลือกโมเดลที่ยังให้บริการฟรี'}
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !consent || !model || !prompt.trim()) return;
          setBusy(true);
          setError(null);
          setResult(null);
          // Consent applies to one attempt; a failed/ambiguous request is never replayed.
          setConsent(false);
          try {
            setResult(
              await host.call<Result>('admin.openrouter.test', {
                tenant,
                model,
                prompt,
                consent: true,
                requestId: crypto.randomUUID(),
              }),
            );
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          โมเดลฟรี
          <select
            value={model}
            disabled={busy || !models.length}
            onChange={(e) => {
              setModel(e.target.value);
              setConsent(false);
              setResult(null);
            }}
            required
          >
            {!models.length && <option value="">ยังไม่มีรายการโมเดล</option>}
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          ข้อความทดลอง (ข้อมูลสมมติ)
          <textarea
            rows={4}
            maxLength={4000}
            required
            value={prompt}
            disabled={busy || !configured}
            onChange={(e) => {
              setPrompt(e.target.value);
              setConsent(false);
              setResult(null);
            }}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy || !model}
            onChange={(e) => setConsent(e.target.checked)}
          />
          ยืนยันส่งข้อความทดลองนี้ให้ OpenRouter และผู้ให้บริการ โดยไม่มีข้อมูลลับหรือข้อมูลส่วนบุคคล
        </label>
        <button className="primary" disabled={busy || !configured || !model || !consent || !prompt.trim()}>
          ส่งทดลองโมเดลฟรี
        </button>
      </form>
      {busy && <Busy label="กำลังติดต่อ OpenRouter" />}
      {result && (
        <div role="status" className="trial-result">
          <h4>ผลการทดลอง{host.demo ? ' · ข้อมูลจำลอง' : ''}</h4>
          <p className="small muted">
            {result.model} · {(result.elapsedMs / 1000).toFixed(1)} วินาที · input{' '}
            {number(result.inputTokens)} / output {number(result.outputTokens)} tokens ·{' '}
            {result.cost === 0 ? 'ผู้ให้บริการรายงานค่าใช้จ่าย $0' : 'ผู้ให้บริการไม่ได้รายงานค่าใช้จ่าย'}
          </p>
          {result.truncated && <p className="warning-note">คำตอบหยุดที่ขีดจำกัด tokens และอาจยังไม่ครบ</p>}
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.text}</p>
          <button type="button" onClick={() => setResult(null)}>
            ล้างผลการทดลอง
          </button>
        </div>
      )}
      <p className="small muted">
        ข้อความและคำตอบไม่บันทึกลงประวัติของแอป เปลี่ยนหน้าหรือออกจากระบบเพื่อล้างหน้าจอ
      </p>
    </section>
  );
}
