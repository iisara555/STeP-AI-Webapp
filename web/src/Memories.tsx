import { useState } from 'react';
import { Brain, Edit3, Plus, Trash2 } from './icons.tsx';
import type { Memory } from '../../packages/harness-core/src/contracts.ts';
import type { ViewProps } from './App.tsx';
import { Empty, Modal, Segmented, Visibility } from './components.tsx';
export function Memories({ host, data, tenant, workspace, refresh, fail }: ViewProps) {
  const [editing, setEditing] = useState<Memory | 'new' | null>(null),
    [deleting, setDeleting] = useState<Memory | null>(null),
    [filter, setFilter] = useState<'private' | 'workspace'>('private');
  const rows = data.memories.filter(
    (m) =>
      m.tenant_id === tenant &&
      m.visibility === filter &&
      (filter === 'private' ? m.owner_id === data.user.id : m.workspace_id === workspace?.id),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>ความจำ</h1>
          <p>แก้ไขหรือลบได้เสมอ ความจำส่วนตัวจะไม่ติดไปกับบทสนทนาที่แชร์</p>
        </div>
        <button className="primary" onClick={() => setEditing('new')}>
          <Plus size={17} />
          เพิ่มความจำ
        </button>
      </div>
      <Segmented
        label="ความจำที่แสดง"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'private', label: 'ส่วนตัว' },
          { value: 'workspace', label: 'แชร์ใน workspace', disabled: !workspace },
        ]}
      />
      <div className="card-grid">
        {rows.map((m) => (
          <article className="memory-card" key={m.id}>
            <div className="card-top">
              <Brain size={21} />
              <Visibility shared={m.visibility === 'workspace'} />
            </div>
            <h2>{m.title}</h2>
            <p>{m.body}</p>
            <footer>
              <span>{m.confirmed ? 'ยืนยันแล้ว' : 'รอยืนยัน'}</span>
              {m.owner_id === data.user.id && (
                <div className="inline-actions">
                  <button aria-label={'แก้ไข ' + m.title} onClick={() => setEditing(m)}>
                    <Edit3 size={16} />
                  </button>
                  <button aria-label={'ลบ ' + m.title} onClick={() => setDeleting(m)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </footer>
          </article>
        ))}
      </div>
      {!rows.length && (
        <Empty
          art="idea"
          title={filter === 'private' ? 'ยังไม่มีความจำส่วนตัว' : 'ยังไม่มีความจำที่แชร์'}
          detail="เริ่มจากความชอบที่ใช้ต่อได้ เช่น รูปแบบคำตอบหรือโครงสร้างเอกสารที่ต้องการ"
        />
      )}
      {editing && (
        <Modal title={editing === 'new' ? 'เพิ่มความจำ' : 'แก้ไขความจำ'} onClose={() => setEditing(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                await host.call('memory.save', {
                  tenant,
                  id: editing === 'new' ? undefined : editing.id,
                  workspace: filter === 'workspace' ? workspace?.id : null,
                  visibility: filter,
                  title: f.get('title'),
                  body: f.get('body'),
                  kind: 'preference',
                });
                await refresh();
                setEditing(null);
              } catch (err) {
                fail(err);
              }
            }}
          >
            <p className="muted">
              ไม่เก็บรหัสผ่าน API key หรือสถานะงานชั่วคราว การกดบันทึกคือการยืนยันให้ใช้ความจำนี้ในงานถัดไป
            </p>
            <label>
              ชื่อความจำ
              <input
                name="title"
                defaultValue={editing === 'new' ? '' : editing.title}
                required
                maxLength={120}
                autoFocus
              />
            </label>
            <label>
              สิ่งที่ต้องการจำ
              <textarea
                name="body"
                defaultValue={editing === 'new' ? '' : editing.body}
                required
                maxLength={4000}
                rows={6}
              />
            </label>
            <Visibility shared={filter === 'workspace'} />
            <footer>
              <button type="button" onClick={() => setEditing(null)}>
                ยกเลิก
              </button>
              <button className="primary">ยืนยันและบันทึก</button>
            </footer>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="ลบความจำ" onClose={() => setDeleting(null)}>
          <p>หยุดใช้ “{deleting.title}” ในงานถัดไป ข้อความในบทสนทนาเดิมจะยังอยู่</p>
          <footer>
            <button onClick={() => setDeleting(null)}>ยกเลิก</button>
            <button
              className="danger"
              onClick={() =>
                void host
                  .call('memory.delete', { tenant, id: deleting.id })
                  .then(refresh)
                  .then(() => setDeleting(null))
                  .catch(fail)
              }
            >
              ลบความจำ
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
