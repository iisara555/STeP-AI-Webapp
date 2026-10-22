import { useRef, useState } from 'react';
import {
  Download,
  FileText,
  FolderOpen,
  Link2,
  Plus,
  Search,
  Trash2,
  Upload,
  Image as ImageIcon,
} from 'lucide-react';
import type { DocumentRecord, Run } from '../../packages/harness-core/src/contracts.ts';
import type { ViewProps } from './App.tsx';
import { Busy, Empty, Modal, Visibility, bytes } from './components.tsx';
import { saveBlob } from './host.ts';
import { uploadFile } from './uploads.ts';
export function Documents({ host, data, tenant, workspace, refresh, fail }: ViewProps) {
  const [filter, setFilter] = useState<'private' | 'workspace'>('private'),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState<DocumentRecord | null>(null),
    [consent, setConsent] = useState<
      (DocumentRecord & { providerName: string; providerConsent?: string }) | null
    >(null),
    [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const rows = data.documents.filter(
    (d) =>
      d.tenant_id === tenant &&
      d.visibility === filter &&
      (filter === 'private' ? d.owner_id === data.user.id : d.workspace_id === workspace?.id) &&
      d.name.toLowerCase().includes(search.toLowerCase()),
  );
  const upload = async (file: File) => {
    setBusy(true);
    setNotice('');
    try {
      await uploadFile(host, tenant, filter === 'workspace' ? workspace?.id || null : null, filter, file);
      await refresh();
      setNotice('เก็บไฟล์แล้ว · ยังไม่ได้ส่งให้ AI');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const chooseDrive = async () => {
    setBusy(true);
    try {
      const config = await host.call<{ accessToken: string; apiKey: string; appId: string }>(
        'google.picker',
        { tenant },
      );
      await new Promise<void>((resolve, reject) => {
        if ((window as unknown as { gapi?: unknown }).gapi) return resolve();
        const script = document.createElement('script');
        script.src = 'https://apis.google.com/js/api.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('GOOGLE_PICKER_UNAVAILABLE'));
        document.head.append(script);
      });
      const googleWindow = window as unknown as {
        gapi: { load(name: string, callback: () => void): void };
        google: {
          picker: {
            PickerBuilder: new () => {
              setOAuthToken(token: string): any;
              setDeveloperKey(key: string): any;
              setAppId(id: string): any;
              setOrigin(origin: string): any;
              addView(view: unknown): any;
              setCallback(callback: (data: { action: string; docs?: { id: string }[] }) => void): any;
              build(): { setVisible(value: boolean): void };
            };
            ViewId: { DOCS: string };
          };
        };
      };
      googleWindow.gapi.load('picker', () => {
        new googleWindow.google.picker.PickerBuilder()
          .setOAuthToken(config.accessToken)
          .setDeveloperKey(config.apiKey)
          .setAppId(config.appId)
          .setOrigin(location.origin)
          .addView(googleWindow.google.picker.ViewId.DOCS)
          .setCallback((result: { action: string; docs?: { id: string }[] }) => {
            if (result.action === 'picked' && result.docs?.[0])
              void host
                .call('document.drive', { tenant, workspace: null, fileId: result.docs[0].id })
                .then(refresh)
                .catch(fail);
          })
          .build()
          .setVisible(true);
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const index = async () => {
    if (!consent) return;
    setBusy(true);
    try {
      const job = await host.call<Run>('run.start', {
        tenant,
        document: consent.id,
        kind: 'document',
        requestId: crypto.randomUUID(),
        consent: true,
        providerConsent: consent.providerConsent,
      });
      setConsent(null);
      setNotice('เริ่มอ่านเอกสารแล้ว คุณเปิดงานอื่นต่อได้');
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const state = await host.call<Run>('run.read', { tenant, id: job.id });
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(state.status)) {
          if (state.status !== 'completed') throw new Error(state.error_code || 'RUN_INTERRUPTED');
          await refresh();
          setNotice('เตรียมเอกสารแล้ว กรุณาตรวจข้อมูลที่อ่านจากต้นฉบับ');
          break;
        }
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">เอกสารอยู่เป็นที่ ใช้ต่อได้</p>
          <h1>เอกสาร</h1>
          <p>เก็บไฟล์ส่วนตัว หรือเลือกแชร์เฉพาะใน workspace</p>
        </div>
        <div className="inline-actions">
          <button disabled={busy} onClick={() => void chooseDrive()}>
            <Link2 size={17} />
            เลือกจาก Google Drive
          </button>
          <button className="primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            <Upload size={17} />
            อัปโหลดไฟล์
          </button>
        </div>
      </div>
      <input
        aria-label="เลือกไฟล์อัปโหลด"
        className="visually-hidden"
        ref={fileInput}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,.pptx,.txt,.md"
        onChange={(e) => {
          if (e.target.files?.[0]) void upload(e.target.files[0]);
        }}
      />
      <div className="filter-bar">
        <div className="tabs">
          <button className={filter === 'private' ? 'active' : ''} onClick={() => setFilter('private')}>
            ส่วนตัว
          </button>
          <button
            className={filter === 'workspace' ? 'active' : ''}
            disabled={!workspace}
            onClick={() => setFilter('workspace')}
          >
            แชร์ใน workspace
          </button>
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="ค้นหาเอกสาร"
            placeholder="ค้นหาชื่อเอกสาร"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {busy && <Busy label="กำลังจัดการเอกสาร" />}
      {notice && (
        <p className="success-notice" role="status">
          {notice}
        </p>
      )}
      <div className="document-list">
        {rows.map((d) => (
          <article key={d.id} className="document-row">
            <div className="document-icon">
              {d.mime.startsWith('image/') ? <ImageIcon size={24} /> : <FileText size={24} />}
            </div>
            <div className="document-info">
              <h2>{d.name}</h2>
              <p>
                <Visibility shared={d.visibility === 'workspace'} />
                <span>{d.source_kind === 'drive' ? 'ต้นฉบับอยู่ใน Google Drive' : bytes(d.bytes)}</span>
                <span>
                  {d.status === 'ready'
                    ? 'พร้อมใช้'
                    : d.status === 'uploading'
                      ? 'ยังอัปโหลดไม่เสร็จ'
                      : d.status === 'processing'
                        ? 'กำลังอ่านเอกสาร'
                        : 'ต้องตรวจสอบ'}
                </span>
              </p>
            </div>
            <div className="inline-actions">
              {d.source_kind === 'upload' && d.status === 'ready' && (
                <>
                  <button
                    disabled={busy || data.ai?.textOnly}
                    onClick={() =>
                      setConsent({
                        ...d,
                        providerName: data.ai?.displayName || 'Google Gemini API',
                        providerConsent: data.ai?.consentId,
                      })
                    }
                  >
                    เตรียมให้ AI ค้น
                  </button>
                  <button
                    aria-label={'ดาวน์โหลด ' + d.name}
                    onClick={() =>
                      void host
                        .download(d.object_path!)
                        .then((blob) => saveBlob(blob, d.name))
                        .catch(fail)
                    }
                  >
                    <Download size={17} />
                  </button>
                </>
              )}
              {d.owner_id === data.user.id && (
                <button aria-label={'ลบ ' + d.name} onClick={() => setDeleting(d)}>
                  <Trash2 size={17} />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!rows.length && (
        <Empty
          icon={<FolderOpen size={34} />}
          title="เริ่มเก็บเอกสารที่ใช้ทำงาน"
          detail="รองรับ PDF รูปภาพ Word Excel PowerPoint และไฟล์ข้อความ ไม่เกิน 10 MB ต่อไฟล์"
        >
          <button onClick={() => fileInput.current?.click()}>
            <Plus size={17} />
            เลือกไฟล์จากเครื่อง
          </button>
        </Empty>
      )}
      <div className="info-card">
        <Link2 size={19} />
        <p>
          ไฟล์จาก Google Drive ใช้สิทธิ์บัญชีของคุณ ไม่คัดลอกทั้ง Drive
          และไม่เปิดให้สมาชิกคนอื่นอ่านผ่านบัญชีคุณ
        </p>
      </div>
      {deleting && (
        <Modal title="ลบเอกสาร" onClose={() => setDeleting(null)}>
          <p>
            ลบ “{deleting.name}” และข้อมูลที่เตรียมไว้สำหรับค้นหาออกจาก STeP{' '}
            {deleting.source_kind === 'drive' && 'ต้นฉบับใน Google Drive จะยังอยู่'}
          </p>
          <footer>
            <button onClick={() => setDeleting(null)}>ยกเลิก</button>
            <button
              className="danger"
              onClick={() =>
                void host
                  .call('document.delete', { tenant, id: deleting.id })
                  .then(refresh)
                  .then(() => setDeleting(null))
                  .catch(fail)
              }
            >
              ลบเอกสาร
            </button>
          </footer>
        </Modal>
      )}
      {consent && (
        <Modal title="เตรียมเอกสารให้ AI อ่าน" onClose={() => setConsent(null)}>
          <p>
            ส่ง “{consent.name}” ให้ {consent.providerName} เพื่ออ่านข้อความหรือเตรียมการค้นหา ใช้วงเงิน AI
            ขององค์กร
          </p>
          <p className="muted">
            ข้อมูลที่อ่านจากรูปภาพยังต้องตรวจเทียบกับต้นฉบับ เอกสารยังมีสิทธิ์เข้าถึงเหมือนเดิม
          </p>
          <footer>
            <button onClick={() => setConsent(null)}>ยกเลิก</button>
            <button className="primary" disabled={busy} onClick={() => void index()}>
              ยืนยันและเริ่มอ่าน
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
