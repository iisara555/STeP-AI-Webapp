import { useState } from 'react';
import { Check } from './icons.tsx';
import type { MemberProfile } from '../../packages/harness-core/src/contracts.ts';
import {
  AVATAR_IDS,
  DEFAULT_ASSISTANT,
  DEFAULT_PROFILE,
  INTERACTION_STYLES,
  LANGUAGE_STYLES,
  PERSONALITIES,
  RETIRED_AVATAR_IDS,
  normalizeProfile,
  type InteractionStyleId,
  type Personality,
} from '../../packages/harness-core/src/assistant-profile.ts';
import { TEAMS } from '../../packages/harness-core/vendor/desktop/teams.ts';
import { Avatar, Busy } from './components.tsx';
import type { ViewProps } from './App.tsx';

type Draft = ReturnType<typeof normalizeProfile>;
const initial = (name: string) => name.trim().slice(0, 1).toUpperCase();
// Prepared examples from Desktop Settings: one request, worded in each style. No AI is called.
const example = (d: Draft) =>
  d.interaction_style === 'witty'
    ? 'ก่อนส่ง ตรวจให้ครบสามจุด: เนื้อหา ผู้รับ และไฟล์แนบ แล้วค่อยกดส่ง'
    : d.interaction_style === 'ob-oon'
      ? 'ถ้าผู้รับเปิดอ่านตอนนี้ เขาจะมีข้อมูลครบไหม? ลองตรวจเนื้อหา ผู้รับ และไฟล์แนบอีกครั้งก่อนส่ง'
      : d.personality === 'professional'
        ? 'กรุณาตรวจสอบความถูกต้องของเนื้อหา รายชื่อผู้รับ และไฟล์แนบให้ครบถ้วนก่อนส่งเอกสาร'
        : d.personality === 'concise'
          ? 'ตรวจเนื้อหา ผู้รับ และไฟล์แนบก่อนส่ง'
          : d.personality === 'custom'
            ? 'ตัวอย่างสไตล์กำหนดเองขึ้นอยู่กับคำอธิบายที่คุณใส่'
            : 'ก่อนส่ง ลองเช็กเนื้อหา ผู้รับ และไฟล์แนบอีกครั้งให้ครบครับ';

/** Profile, assistant and speaking style, as in Desktop Settings › ทั่วไป. */
export function ProfileSettings({
  host,
  data,
  tenant,
  refresh,
  fail,
  onSaved,
}: ViewProps & { onSaved: () => void }) {
  const stored = data.profiles?.find((p) => p.tenant_id === tenant);
  const [draft, setDraft] = useState<Draft>(normalizeProfile(stored || DEFAULT_PROFILE));
  const [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const fallback = initial(draft.display_name || data.user.name || data.user.email || 'S');
  const changed = JSON.stringify(draft) !== JSON.stringify(normalizeProfile(stored || DEFAULT_PROFILE));
  const save = async () => {
    setBusy(true);
    try {
      await host.call<MemberProfile>('profile.save', { tenant, ...draft });
      await refresh();
      onSaved();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const styleCards: [string, string, string][] = [
    ...(['coworker', 'professional', 'concise', 'custom'] as Personality[]).map(
      (id): [string, string, string] => [id, PERSONALITIES[id].label, PERSONALITIES[id].summary],
    ),
    ...Object.values(INTERACTION_STYLES).map((s): [string, string, string] => [
      s.id,
      `${s.thaiName} (${s.displayName})`,
      s.summary,
    ]),
  ];
  return (
    <>
      <h2>โปรไฟล์และทีม</h2>
      <div className="settings-card">
        <div className="profile-summary">
          <Avatar id={draft.avatar} fallback={fallback} className="large" />
          <button type="button" aria-expanded={picker} onClick={() => setPicker(!picker)}>
            เปลี่ยนรูป
          </button>
        </div>
        {picker && (
          <div className="avatar-section">
            <p className="small muted">
              เลือกภาพวาดที่ชอบ ภาพเป็นลายเส้นประกอบ ไม่ใช่รูปถ่ายของใคร เก็บเฉพาะภาพที่เลือกไว้กับบัญชีของคุณ
            </p>
            <div className="avatar-picker" role="radiogroup" aria-label="รูปโปรไฟล์">
              <button
                type="button"
                role="radio"
                aria-checked={!draft.avatar}
                aria-label="ใช้ตัวอักษรแรกของชื่อ"
                title="ใช้ตัวอักษรแรกของชื่อ"
                className="avatar-option"
                onClick={() => set('avatar', '')}
              >
                <Avatar fallback={fallback} />
              </button>
              {AVATAR_IDS.filter((id) => !RETIRED_AVATAR_IDS.includes(id) || id === draft.avatar).map(
                (id, i) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={draft.avatar === id}
                    aria-label={`ภาพที่ ${i + 1}`}
                    title={`ภาพที่ ${i + 1}`}
                    className="avatar-option"
                    onClick={() => set('avatar', id)}
                  >
                    <Avatar id={id} fallback="" />
                  </button>
                ),
              )}
            </div>
          </div>
        )}
        <div className="form-grid">
          <label>
            ชื่อเรียกของคุณ
            <input
              value={draft.display_name}
              maxLength={60}
              placeholder={data.user.name || 'เช่น ต้น'}
              onChange={(e) => set('display_name', e.target.value)}
            />
          </label>
          <label>
            ทีมหลัก
            <select value={draft.team} onChange={(e) => set('team', e.target.value)}>
              <option value="">ยังไม่แน่ใจ · เลือกภายหลัง</option>
              {TEAMS.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.id.toUpperCase()} · {team.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="small muted">
          ทีมใช้เลือกงานตัวอย่างและเป็นบริบทให้ผู้ช่วย ไม่ได้เปลี่ยนสิทธิ์เข้าถึงข้อมูล
        </p>
      </div>
      <h2>ผู้ช่วยของคุณ</h2>
      <div className="settings-card">
        <div className="form-grid">
          <label>
            ชื่อผู้ช่วย
            <input
              value={draft.assistant_name}
              maxLength={60}
              placeholder={DEFAULT_ASSISTANT}
              onChange={(e) => set('assistant_name', e.target.value)}
            />
          </label>
          <label>
            ภาษาในแชต
            <select
              value={draft.chat_language}
              onChange={(e) => set('chat_language', e.target.value as Draft['chat_language'])}
            >
              <option value="auto">ตามภาษาที่พิมพ์</option>
              <option value="th">ไทย</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <h3>สไตล์การพูดของผู้ช่วย</h3>
        <p className="small muted">
          เปลี่ยนเฉพาะวิธีพูดในแชต ข้อเท็จจริง แหล่งอ้างอิง สิทธิ์ และมาตรฐานเอกสารยังเหมือนเดิม
          และไม่ได้สวมบทเป็นบุคคลจริง
        </p>
        <div className="style-grid" role="radiogroup" aria-label="สไตล์การพูดของผู้ช่วย">
          {styleCards.map(([id, label, summary]) => {
            const documented = id in INTERACTION_STYLES;
            const active = documented
              ? draft.interaction_style === id
              : draft.interaction_style === 'standard' && draft.personality === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                className="style-card"
                onClick={() =>
                  documented
                    ? set('interaction_style', id as InteractionStyleId)
                    : setDraft((d) => ({
                        ...d,
                        personality: id as Personality,
                        interaction_style: 'standard',
                      }))
                }
              >
                <strong>{label}</strong>
                <small>{summary}</small>
              </button>
            );
          })}
        </div>
        <div className="style-example" aria-live="polite">
          <strong>ตัวอย่างจากโจทย์เดียวกัน: ช่วยเตือนให้ตรวจเอกสารก่อนส่ง</strong>
          <p>{example(draft)}</p>
          <small>ตัวอย่างที่เตรียมไว้ ไม่มีการเรียก AI</small>
        </div>
        {draft.interaction_style === 'standard' && draft.personality === 'custom' && (
          <label>
            สไตล์ที่ต้องการ
            <input
              value={draft.assistant_tone}
              maxLength={300}
              placeholder="เช่น ตอบเป็นข้อ ๆ และสรุปสิ่งที่ต้องทำท้ายคำตอบ"
              onChange={(e) => set('assistant_tone', e.target.value)}
            />
          </label>
        )}
        <h3>สำเนียงภาษา</h3>
        <p className="small muted">ใช้ร่วมกับสไตล์ด้านบนได้</p>
        <div className="style-grid" role="radiogroup" aria-label="สำเนียงภาษา">
          {(
            [
              ['standard', 'ภาษาไทยมาตรฐาน', 'ไม่เพิ่มสำเนียงท้องถิ่น'],
              ...Object.values(LANGUAGE_STYLES).map((s) => [s.id, s.displayName, s.summary]),
            ] as [Draft['language_style'], string, string][]
          ).map(([id, label, summary]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={draft.language_style === id}
              className="style-card"
              onClick={() => set('language_style', id)}
            >
              <strong>{label}</strong>
              <small>{summary}</small>
            </button>
          ))}
        </div>
        <p className="small muted">
          ชื่อเรียก ทีม และสไตล์นี้ส่งไปกับคำขอถึง AI เพื่อจัดถ้อยคำ หน้ายืนยันก่อนส่งจะแจ้งทุกครั้ง
          ผู้ดูแลองค์กรไม่เห็นข้อมูลนี้
        </p>
      </div>
      <div className="settings-save">
        <button className="primary" disabled={busy || !changed} onClick={() => void save()}>
          {busy ? <Busy label="" /> : <Check size={16} />}
          บันทึกโปรไฟล์และผู้ช่วย
        </button>
      </div>
    </>
  );
}
