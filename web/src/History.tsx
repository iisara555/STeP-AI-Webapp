import { useEffect, useRef, useState } from 'react';
import { Search, MessageSquare } from './icons.tsx';
import type { Conversation } from '../../packages/harness-core/src/contracts.ts';
import type { ViewProps } from './App.tsx';
import { Busy, Empty, Visibility } from './components.tsx';
export function History({
  host,
  data,
  tenant,
  workspace,
  fail,
  onOpen,
  initialQuery = '',
}: ViewProps & { onOpen: (session: Conversation) => void; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery),
    [results, setResults] = useState<Conversation[] | null>(null),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const search = async (value: string) => {
    const current = ++generation.current;
    setBusy(true);
    try {
      const found = await host.call<Conversation[]>('session.search', { tenant, query: value });
      if (current === generation.current) setResults(found);
    } catch (error) {
      fail(error);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  // A search started from the sidebar runs on arrival.
  useEffect(() => {
    if (initialQuery.trim()) void search(initialQuery);
  }, []);
  const rows = (results || data.sessions).filter(
    (s) => s.tenant_id === tenant && (!workspace || s.workspace_id === workspace.id),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>ค้นงานเก่า</h1>
          <p>ค้นชื่อ บทสนทนา และร่างที่คุณมีสิทธิ์อ่าน โดยไม่ส่งคำค้นให้ AI</p>
        </div>
      </div>
      <form
        className="catalog-controls"
        onSubmit={(e) => {
          e.preventDefault();
          void search(query);
        }}
      >
        <label className="search">
          <Search size={16} />
          <input
            aria-label="คำค้นงานเก่า"
            value={query}
            maxLength={100}
            onChange={(e) => {
              setQuery(e.target.value);
              generation.current++;
              setBusy(false);
              setResults(null);
            }}
            placeholder="คำหรือประโยคที่จำได้"
          />
        </label>
        <button className="primary" disabled={busy || !query.trim()}>
          {busy ? <Busy label="กำลังค้น" /> : 'ค้นหา'}
        </button>
      </form>
      <p className="small muted">แสดงไม่เกิน 50 ผลต่อการค้น · งานล่าสุดแสดงจาก 200 รายการล่าสุด</p>
      <div className="history-results">
        {rows.map((s) => (
          <button key={s.id} onClick={() => onOpen(s)}>
            <MessageSquare size={21} />
            <div>
              <strong>{s.title}</strong>
              <Visibility shared={s.visibility === 'workspace'} />
            </div>
            <span>เปิดงาน</span>
          </button>
        ))}
      </div>
      {!rows.length && (
        <Empty
          icon={<Search size={30} />}
          title="ยังไม่พบงาน"
          detail="ลองใช้คำค้นที่สั้นลง หรือเริ่มงานใหม่จากเมนูด้านซ้าย"
        />
      )}
    </>
  );
}
