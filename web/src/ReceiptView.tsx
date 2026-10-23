import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Download, FileImage, Receipt, RotateCw, Upload } from 'lucide-react';
import type { DocumentRecord, ReceiptResult, Run } from '../../packages/harness-core/src/contracts.ts';
import { RECEIPT_BUYER, errorView } from '../../packages/harness-core/src/index.ts';
import type { ViewProps } from './App.tsx';
import { Busy, Modal } from './components.tsx';
import { prepareReceipt, uploadFile } from './uploads.ts';
import { saveBlob } from './host.ts';
const types: Record<ReceiptResult['document_type'], string> = {
  full_tax_invoice: 'ใบเสร็จรับเงิน/ใบกำกับภาษีแบบเต็มรูป',
  abbreviated_tax_invoice: 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ',
  cash_bill: 'บิลเงินสด',
  general_receipt: 'ใบเสร็จรับเงินทั่วไป',
  unknown: 'ยังระบุประเภทไม่ได้',
};
const statuses = { found: 'พบข้อมูล', missing: 'ไม่พบ', uncertain: 'อ่านไม่ชัด', mismatch: 'ข้อมูลไม่ตรง' };
export function ReceiptView({ host, data, tenant, refresh, fail }: ViewProps) {
  const [document, setDocument] = useState<DocumentRecord | null>(null),
    [preview, setPreview] = useState(''),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState<{ providerName: string; providerConsent?: string } | null>(null),
    [run, setRun] = useState<Run | null>(null),
    [result, setResult] = useState<ReceiptResult | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [saved, setSaved] = useState(false),
    [warnings, setWarnings] = useState<string[]>([]),
    [history, setHistory] = useState<Run[]>([]),
    [rotation, setRotation] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    localFile = useRef<File | null>(null),
    current = useRef(0);
  const receipts = data.documents.filter(
    (d) =>
      d.tenant_id === tenant &&
      d.owner_id === data.user.id &&
      d.status === 'ready' &&
      (d.mime.startsWith('image/') || d.mime === 'application/pdf'),
  );
  useEffect(() => {
    void host
      .call<Run[]>('receipt.history', { tenant })
      .then(setHistory)
      .catch(() => {});
    return () => {
      current.current++;
    };
  }, [tenant, host]);
  useEffect(() => {
    if (!document?.object_path) {
      setPreview('');
      return;
    }
    let active = true;
    let url = '';
    void host
      .download(document.object_path)
      .then((blob) => {
        if (active && blob.type.startsWith('image/')) {
          url = URL.createObjectURL(blob);
          setPreview(url);
        }
      })
      .catch(fail);
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setPreview('');
    };
  }, [document?.id, host]);
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.status)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await host.call<Run>('run.read', { tenant, id: run.id });
        if (!active) return;
        setRun(value);
        if (value.status === 'completed') {
          const receipt = (value.result as { receipt?: ReceiptResult })?.receipt;
          if (!receipt) throw new Error('PROVIDER_STREAM_INVALID');
          setResult(receipt);
          setConfirmed(false);
          setSaved(false);
          setBusy(false);
          const records = await host.call<Run[]>('receipt.history', { tenant });
          if (active) setHistory(records);
        } else if (['failed', 'cancelled', 'interrupted'].includes(value.status)) {
          setBusy(false);
          if (value.error_code) fail(new Error(value.error_code));
        } else timer = setTimeout(poll, 1500);
      } catch (e) {
        if (active) {
          setBusy(false);
          fail(e);
        }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [run?.id, tenant, host]);
  const upload = async (file: File) => {
    setBusy(true);
    setResult(null);
    setRun(null);
    setConfirmed(false);
    setSaved(false);
    setWarnings([]);
    setRotation(0);
    localFile.current = file;
    const token = ++current.current;
    try {
      const doc = await uploadFile(host, tenant, null, 'private', file);
      if (token !== current.current) return;
      setDocument(doc);
      if (file.type.startsWith('image/')) {
        const prepared = await prepareReceipt(file);
        await uploadFile(host, tenant, null, 'private', prepared.file, doc.id);
        if (token === current.current) setWarnings(prepared.warnings);
      }
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      if (token === current.current) setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const rotate = async () => {
    if (!document || !localFile.current) return;
    setBusy(true);
    const next = (rotation + 90) % 360;
    try {
      const prepared = await prepareReceipt(localFile.current, next);
      await uploadFile(host, tenant, null, 'private', prepared.file, document.id);
      setRotation(next);
      setWarnings(prepared.warnings);
      setResult(null);
      setRun(null);
      setConfirmed(false);
      setSaved(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!document || !consent) return;
    setBusy(true);
    setConsent(null);
    setResult(null);
    try {
      setRun(
        await host.call<Run>('run.start', {
          tenant,
          document: document.id,
          kind: 'receipt',
          requestId: crypto.randomUUID(),
          consent: true,
          providerConsent: consent.providerConsent,
        }),
      );
    } catch (e) {
      setBusy(false);
      fail(e);
    }
  };
  const save = async () => {
    if (!document || !run || !result || !confirmed) return;
    setBusy(true);
    try {
      await host.call('receipt.review', {
        tenant,
        id: run.id,
        document: document.id,
        result,
        sourceConfirmed: true,
      });
      setSaved(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const openHistory = async (r: Run) => {
    const token = ++current.current;
    setRun(r);
    setDocument(data.documents.find((d) => d.id === r.document_id) || null);
    setResult((r.result as { receipt?: ReceiptResult })?.receipt || null);
    setConfirmed(false);
    setSaved(false);
    localFile.current = null;
    try {
      const review = await host.call<{ review: ReceiptResult; reviewed_at: string } | null>(
        'receipt.read-review',
        { tenant, id: r.id },
      );
      if (token === current.current && review) {
        setResult(review.review);
        setConfirmed(true);
        setSaved(true);
      }
    } catch (e) {
      if (token === current.current) fail(e);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">อ่านจากต้นฉบับ แล้วตรวจจุดสำคัญ</p>
          <h1>ตรวจใบเสร็จ AFP</h1>
          <p>ดูประเภทเอกสาร ข้อมูลที่ครบหรือยังขาด และสิ่งที่ต้องทำต่อ</p>
        </div>
        <button className="primary" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={17} />
          เลือกภาพหรือ PDF
        </button>
      </div>
      <input
        aria-label="เลือกไฟล์อัปโหลด"
        className="visually-hidden"
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.pdf"
        ref={input}
        onChange={(e) => {
          if (e.target.files?.[0]) void upload(e.target.files[0]);
        }}
      />
      <div className="receipt-layout">
        <section className="receipt-source">
          <header>
            <h2>ต้นฉบับ</h2>
            {document?.object_path && (
              <button
                aria-label="ดาวน์โหลดต้นฉบับ"
                onClick={() =>
                  void host
                    .download(document.object_path!)
                    .then((blob) => saveBlob(blob, document.name))
                    .catch(fail)
                }
              >
                <Download size={17} />
              </button>
            )}
          </header>
          {document ? (
            <>
              <p className="receipt-filename">{document.name}</p>
              {preview ? (
                <div className="receipt-image">
                  <img src={preview} alt="ต้นฉบับใบเสร็จ" style={{ transform: `rotate(${rotation}deg)` }} />
                </div>
              ) : (
                <div className="receipt-placeholder">
                  <FileImage size={42} />
                  <p>เอกสาร PDF · เปิดต้นฉบับจากปุ่มดาวน์โหลดเพื่อตรวจเทียบ</p>
                </div>
              )}
              <div className="inline-actions">
                {localFile.current?.type.startsWith('image/') && (
                  <button disabled={busy} onClick={() => void rotate()}>
                    <RotateCw size={16} />
                    หมุนภาพ
                  </button>
                )}
                <button disabled={busy} onClick={() => input.current?.click()}>
                  เปลี่ยนไฟล์
                </button>
              </div>
            </>
          ) : (
            <button className="upload-area" disabled={busy} onClick={() => input.current?.click()}>
              <FileImage size={44} />
              <strong>เลือกใบเสร็จหนึ่งใบต่อไฟล์</strong>
              <span>
                ภาพหรือ PDF ไม่เกิน 10 MB
                <br />
                ถ่ายให้เห็นทั้งใบและตัวอักษรชัด
              </span>
            </button>
          )}
          {receipts.length > 0 && (
            <label className="existing-file">
              หรือเลือกไฟล์ที่เก็บไว้
              <select
                aria-label="เลือกใบเสร็จที่เก็บไว้"
                value={document?.id || ''}
                disabled={busy}
                onChange={(e) => {
                  setDocument(receipts.find((d) => d.id === e.target.value) || null);
                  setResult(null);
                  setRun(null);
                  setRotation(0);
                  localFile.current = null;
                }}
              >
                <option value="">เลือกเอกสาร</option>
                {receipts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {warnings.map((w) => (
            <p className="warning-note" key={w}>
              {w}
            </p>
          ))}
        </section>
        <section className="receipt-result">
          {busy ? (
            <div className="receipt-waiting">
              <Busy
                label={
                  run?.status === 'queued'
                    ? 'กำลังรอคิวตรวจใบเสร็จ'
                    : run
                      ? 'กำลังอ่านข้อความและจัดกลุ่มข้อมูล'
                      : 'กำลังเตรียมภาพ'
                }
              />
              <p>ต้นฉบับยังเก็บไว้ ผลที่อ่านได้จะให้คุณตรวจอีกครั้ง</p>
            </div>
          ) : result ? (
            <>
              <div className="result-section">
                <span className="step-number">1</span>
                <div>
                  <h2>ใบเสร็จประเภทไหน</h2>
                  <select
                    aria-label="ประเภทใบเสร็จ"
                    value={result.document_type}
                    onChange={(e) => {
                      setResult({
                        ...result,
                        document_type: e.target.value as ReceiptResult['document_type'],
                      });
                      setConfirmed(false);
                      setSaved(false);
                    }}
                  >
                    {Object.entries(types).map(([key, title]) => (
                      <option key={key} value={key}>
                        {title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="result-section">
                <span className="step-number">2</span>
                <div>
                  <h2>องค์ประกอบครบหรือไม่</h2>
                  <p className="result-summary">
                    {result.complete === 'complete'
                      ? 'พบข้อมูลหลักครบ · รอตรวจเทียบต้นฉบับ'
                      : result.complete === 'incomplete'
                        ? 'มีข้อมูลที่ยังขาดหรือไม่ตรง'
                        : 'ยังต้องตรวจข้อมูลบางจุด'}
                  </p>
                  <p className="muted small">
                    ลายเซ็นผู้รับเงิน:{' '}
                    {result.signature === 'present'
                      ? 'พบรอยลายเซ็น'
                      : result.signature === 'absent'
                        ? 'ไม่พบ'
                        : 'ยังระบุไม่ได้'}
                  </p>
                  <div className="check-list">
                    {result.checks.map((check, i) => (
                      <div key={i} className="receipt-check">
                        <div>
                          <strong>{check.field}</strong>
                          <span className={'check-status ' + check.status}>{statuses[check.status]}</span>
                        </div>
                        <input
                          aria-label={'แก้ไข ' + check.field}
                          value={check.value || ''}
                          placeholder={
                            check.status === 'uncertain' ? 'ตรวจจากต้นฉบับแล้วกรอก' : 'ยังไม่มีข้อมูล'
                          }
                          onChange={(e) => {
                            setResult({
                              ...result,
                              checks: result.checks.map((c, n) =>
                                n === i ? { ...c, value: e.target.value } : c,
                              ),
                            });
                            setConfirmed(false);
                            setSaved(false);
                          }}
                        />
                        {check.evidence && <small>อ่านได้ว่า: {check.evidence}</small>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="result-section">
                <span className="step-number">3</span>
                <div>
                  <h2>ต้องทำอะไรต่อ</h2>
                  <ul>
                    {result.next_steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ul>
                  {result.warnings.map((warning, i) => (
                    <p className="warning-note" key={i}>
                      {warning}
                    </p>
                  ))}
                </div>
              </div>
              <div className="receipt-confirm">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => {
                      setConfirmed(e.target.checked);
                      setSaved(false);
                    }}
                  />
                  ตรวจข้อมูลที่แสดงกับต้นฉบับ และแก้ส่วนที่อ่านผิดแล้ว
                </label>
                <button
                  className="primary"
                  disabled={!confirmed || busy || saved}
                  onClick={() => void save()}
                >
                  {saved ? (
                    <>
                      <CheckCircle2 size={17} />
                      บันทึกผลตรวจแล้ว
                    </>
                  ) : (
                    <>
                      <Check size={17} />
                      บันทึกผลตรวจ
                    </>
                  )}
                </button>
                <p className="small muted">
                  ผลตรวจช่วยเตรียมเอกสาร ไม่ใช่การอนุมัติเบิกจ่ายหรือรับรองลายเซ็น
                </p>
              </div>
            </>
          ) : (
            <div className="receipt-intro">
              <div className="empty-icon">
                <Receipt size={32} />
              </div>
              <h2>ตรวจเฉพาะสิ่งที่ต้องรู้ก่อนเบิก</h2>
              <ol>
                <li>ใบเสร็จประเภทไหน</li>
                <li>ข้อมูลหลักครบตามเอกสารหรือไม่</li>
                <li>ต้องแก้ไขหรือเตรียมอะไรเพิ่ม</li>
              </ol>
              <button
                className="primary"
                disabled={!document || busy || data.ai?.textOnly}
                onClick={() =>
                  setConsent({
                    providerName: data.ai?.displayName || 'Google Gemini API',
                    providerConsent: data.ai?.consentId,
                  })
                }
              >
                เริ่มตรวจใบเสร็จ
              </button>
            </div>
          )}
          {result && !busy && (
            <button
              className="text-button"
              disabled={data.ai?.textOnly}
              onClick={() =>
                setConsent({
                  providerName: data.ai?.displayName || 'Google Gemini API',
                  providerConsent: data.ai?.consentId,
                })
              }
            >
              ตรวจจากภาพอีกครั้ง
            </button>
          )}
        </section>
      </div>
      <details className="buyer-reference">
        <summary>ข้อมูลผู้ซื้อที่ใช้ตรวจเทียบ</summary>
        <p>
          {RECEIPT_BUYER.name}
          <br />
          {RECEIPT_BUYER.address}
          <br />
          เลขประจำตัวผู้เสียภาษี 0-9940-00423-17-9
        </p>
      </details>
      {history.length > 0 && (
        <section className="receipt-history">
          <h2>ผลตรวจล่าสุด</h2>
          {history.map((r) => (
            <button disabled={busy} key={r.id} onClick={() => void openHistory(r)}>
              <Receipt size={16} />
              <span>{data.documents.find((d) => d.id === r.document_id)?.name || 'ใบเสร็จ'}</span>
              <small>
                {r.status === 'completed' ? 'ดูผลตรวจ' : errorView(r.error_code || 'RUN_INTERRUPTED').title}
              </small>
            </button>
          ))}
        </section>
      )}
      {consent && document && (
        <Modal title="ส่งใบเสร็จให้ AI อ่าน" onClose={() => setConsent(null)}>
          <p>
            ส่งภาพ “{document.name}” ให้ {consent.providerName} เพื่อตรวจข้อมูลและลายเซ็น ใช้วงเงิน AI
            ขององค์กร
          </p>
          <p className="muted">
            เก็บต้นฉบับไว้เสมอ ภาพที่ปรับก่อนอ่านเป็นสำเนา ผลที่อ่านได้ยังต้องตรวจเทียบก่อนนำไปใช้
          </p>
          <footer>
            <button onClick={() => setConsent(null)}>ยกเลิก</button>
            <button className="primary" onClick={() => void start()}>
              ยืนยันและเริ่มตรวจ
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
