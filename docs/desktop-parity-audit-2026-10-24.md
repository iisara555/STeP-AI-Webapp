# Audit: Webapp เทียบ Desktop 0.6.20

ตรวจวันที่ 24 ตุลาคม 2569 (Asia/Bangkok) โดยเทียบ Webapp `a5a99d216981a5527d4ee65630a9623ffb1e0d7e`
กับ Desktop `90ee71ca667c63284afe4996eddc7e8095b9a059` รุ่น 0.6.20
GitHub ยืนยันว่า Desktop main และ tag `desktop-v0.6.20` ยังอยู่ที่ commit นี้ในวันที่ตรวจ
อ่าน checkout Desktop อย่างเดียว ไม่มีการแก้ไข ย้ายข้อมูลส่วนตัว หรือเรียก AI/Google จริง

## ข้อสรุป

**ใกล้ Desktop ด้านหน้าตาและจุดเริ่มต้นของงาน แต่ยังใช้แทนความสามารถทั้งหมดของ Desktop ไม่ได้**
แชต แบบฟอร์มเอกสาร Skill โปรไฟล์ และการเตรียม Prompt สื่อภายในมี implementation จริง
ช่องว่างที่กระทบงานประจำมากที่สุดคือ editor/ประวัติร่าง/Office และความทนทานเมื่อเปลี่ยนหน้าหรือเครือข่ายสะดุด
งานใช้เครื่องมือหลายขั้นตอน งานตามรอบ และการเชื่อมต่อ native ยังห่างจาก Desktop อย่างมีนัยสำคัญ

รายการอ้างอิงในแอปแบ่ง 32 หมวดเป็น `web` 8, `partial` 17, `planned` 3 และ `desktop` 4
ตัวเลขนี้เป็นการจัดหมวดใน `packages/harness-core/src/desktop-reference.ts` ไม่ใช่คะแนนความสำเร็จ
หมวดมีขนาดไม่เท่ากัน และสถานะ `web` ไม่ได้ยืนยันว่าไม่มี bug หรือผ่าน production acceptance
การตรวจครั้งนี้พบ **P1 หนึ่งรายการ และ P2 สี่รายการ** แม้ชุดทดสอบเดิมผ่าน

## Findings ที่ทำซ้ำได้

### P1 · Worker ส่งบริบทต่อได้หลังถอนสิทธิ์หรือยกเลิกระหว่างเตรียมข้อมูล

ตำแหน่ง: [worker.ts:214](../supabase/functions/_shared/worker.ts#L214)
และ [gemini.ts:85](../supabase/functions/_shared/gemini.ts#L85)

`worker_payload` ตรวจสิทธิ์ตอนเริ่มงานที่ worker บรรทัด 59 จากนั้นอาจรอ Calendar/Drive
และอ่านโปรไฟล์ด้วย service role ก่อน `ai.generate` โดยไม่ตรวจ lease/สมาชิก/สิทธิ์ทรัพยากรซ้ำ
Gemini ส่งบริบททั้งชุดไป `countTokens` แล้ว `generateContent` จึงต้องคุมสิทธิ์ที่ทั้งสองจุด
รวมถึง retry; การตรวจเฉพาะก่อนบันทึกผลไม่เรียกคืนข้อมูลที่ส่งออกไปแล้ว

วิธีทำซ้ำแบบสังเคราะห์: เรียก `processOne` ด้วย fetcher ที่ intercept ทุก URL
ให้ payload และ Google membership check ครั้งแรกผ่าน หยุด response ของ Drive `alt=media` ไว้
ถอนสิทธิ์/ยกเลิกงาน แล้วปล่อย response โดยให้การตรวจสิทธิ์ครั้งถัดไปปฏิเสธหากถูกเรียก
ผลที่ได้คือ `countTokens` และ `generateContent` ถูกเรียกหลังถอนสิทธิ์ และทั้งสอง body
มี marker ของความจำส่วนตัวและข้อความ Drive; ตอนท้าย `committed:false`
ไม่มีคำขอออกเครือข่ายจริงหรือใช้ข้อมูลพนักงานในการทำซ้ำนี้

ผลกระทบ: งานที่ถูกถอนสิทธิ์ระหว่างรอ I/O ยังเปิดเผยบริบทให้ provider ได้
ไม่ได้พบการอ่านข้าม tenant จาก RLS ในการตรวจนี้
แนวแก้: ตรวจ active lease, cancellation, membership และสิทธิ์เอกสารก่อน external request ทุกครั้ง
หลัง I/O ที่รอ และก่อน retry พร้อมหยุดการส่งเมื่อสิทธิ์เปลี่ยน
เพิ่ม test ที่หยุด Drive/countTokens/retry แล้วถอนสิทธิ์ และ assert ว่าไม่มี upstream request ถัดไป
[test เดิม](../test/database/jobs.test.ts#L116) ตรวจเฉพาะการปฏิเสธ `finish_run`

### P2 · ร่างที่แก้แล้วหายเมื่อไปหน้าอื่นโดยยังไม่กดบันทึก

ตำแหน่ง: [App.tsx:559](../web/src/App.tsx#L559),
[Chat.tsx:121](../web/src/Chat.tsx#L121) และ [Chat.tsx:300](../web/src/Chat.tsx#L300)

Chat เก็บร่างที่แก้ใน component state และถูก unmount เมื่อเปิด Settings/เครื่องมือ
กลับมาจะอ่าน `session.draft` ที่บันทึกไว้ ไม่มี dirty navigation guard หรือการเก็บร่างข้ามหน้า
ทำซ้ำใน Chromium กับ demo จริง: เตรียมเอกสาร → แทนที่ร่างด้วย marker → Settings → เปิดงานเดิม
ผล `restoredOriginal:true` และไม่มี external request: marker หายโดยไม่มีคำถามก่อนออก

Desktop เก็บ editor state ที่ App และ `selectSession` รอ `save()`
([ต้นทาง:667](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/App.tsx#L667))
แนวแก้: เก็บ dirty draft แยกตามงาน หรือบันทึก/ยืนยันก่อนเปลี่ยนหน้า งาน และ workspace
รวมถึงป้องกันการ reload/อัปเดตที่ทำให้ร่างหาย

### P2 · ผลบันทึกร่างที่มาช้าดึงผู้ใช้กลับไปงานเก่า

ตำแหน่ง: [Chat.tsx:304](../web/src/Chat.tsx#L304)

`saveDraft` เรียก `setSession(s)` เมื่อ promise สำเร็จ โดยไม่ตรวจว่ายังอยู่ที่งานนั้น
ทำซ้ำด้วย component จริงและ Host สังเคราะห์: บันทึก A โดยค้าง response → เลือก B → ปล่อย response A
หัวงานเปลี่ยนจาก `SYNTHETIC TASK B` กลับเป็น `SYNTHETIC TASK A`
การเปลี่ยนงานนี้ยัง reset ข้อความ/ร่างที่กำลังพิมพ์ใน B ได้
แนวแก้: ผูก response กับ session และ navigation generation แล้วอัปเดต cache ของ A โดยไม่เลือก A
เพิ่ม delayed-response test ครอบคลุมการเปลี่ยนงาน workspace และ tenant

### P2 · แก้ความจำที่หมดอายุแล้วทำให้กลับมาใช้ได้ตลอดไป

ตำแหน่ง: [Memories.tsx:149](../web/src/Memories.tsx#L149)
และ [api.ts:362](../supabase/functions/_shared/api.ts#L362)

`daysLeft` แปลงวันหมดอายุที่ผ่านมาแล้วเป็น `0` ซึ่งฟอร์มใช้เป็นค่าเริ่มต้น
การแก้เฉพาะชื่อ/ประเภทแล้วบันทึกจึงส่ง `ttlDays:0`; API แปลเป็น `expires_at:null`
ทำซ้ำผ่าน `memory.save` dispatcher จริงกับ DB สังเคราะห์:
`selectedBefore:0`, `untouchedFormTtl:0`, `savedExpiry:null`, `selectedAfter:1`
ความจำที่หมดอายุถูกใช้กับ AI ได้อีกโดยไม่ได้เลือกเปลี่ยนอายุความจำ

Desktop เก็บ `ttl_days` เดิมในฟอร์ม
([ต้นทาง:144](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/memory.tsx#L144))
แม้การแก้อาจต่ออายุแบบจำกัดวัน ก็ไม่เปลี่ยนจากจำกัดวันเป็นตลอดไปโดยปริยาย
แนวแก้: คง expiry/duration เมื่อไม่ได้เปลี่ยนอายุ และให้การต่ออายุเป็นการเลือกที่ชัดเจน
ทดสอบทั้งความจำหมดอายุและเหลืออายุไม่ถึงหนึ่งวัน

### P2 · OCR เลิกติดตามผลหลังอ่านสถานะไม่สำเร็จครั้งเดียว

ตำแหน่ง: [ReceiptView.tsx:92](../web/src/ReceiptView.tsx#L92)

catch ของ polling ตั้ง `busy=false` แต่ไม่ตั้ง timer ใหม่ และ effect ใช้ `run.id` เดิม
ทำซ้ำใน Chromium ด้วย ReceiptView จริงและ Host สังเคราะห์ที่ให้ `run.read` ครั้งแรกเกิด `NETWORK_ERROR`
ผ่านไป 3.5 วินาทีได้ `readCount:1`, `startEnabled:true`; งานฝั่ง server ยังทำอยู่แต่หน้าจอไม่รับผลต่อ
ต้องออกแล้วเปิดใหม่จึงกู้การติดตามได้

แนวแก้: คงสถานะว่างานยัง active และ retry การอ่านสถานะแบบมีระยะพัก พร้อมทางกลับมาติดตามงานเดิม
ไม่ควรสรุปว่ามีค่าใช้จ่ายซ้ำพร้อมกัน เพราะ
[SQL:79](../supabase/migrations/20261022164909_shared_openrouter_admission.sql#L79)
ปฏิเสธ run ใหม่ขณะที่มี run active

## ส่วนที่ใกล้เคียงแล้ว

- **Shell และการเริ่มงาน:** theme tokens, แถบเมนู/แถบย่อ, ภาพประกอบ, team starters,
  command search และผลงานข้างบทสนทนาอิง Desktop มี Playwright ทั้ง desktop/mobile
  ดู `web/src/TitleBar.tsx`, `Sidebar.tsx`, `Chat.tsx` และ `web/DESIGN.md`
- **โปรไฟล์:** ชื่อเรียก ทีม อวตาร ชื่อผู้ช่วย personality ภาษาแชต speaking style และภาษาเหนือ
  มี implementation ใน `web/src/ProfileSettings.tsx` และ `assistant-profile.ts`
  ยังขาด installed output styles, UI อังกฤษ และเสียง
- **แบบฟอร์ม 5 แบบ:** TOR/บันทึกข้อความ/หนังสือราชการ/โครงการ/รายงานประชุม
  ใช้ชุด field/variant และ `documentRequest` จาก Desktop จริง ผ่าน `desktop-workflows.ts`
  เตรียมงานส่วนตัวและร่างก่อน consent ไม่ใช่ปุ่ม mock
- **Skill และความรู้:** ค้น/กรอง/ดูรายละเอียดและแหล่งบังคับ มี source gap และ provenance
  working references ไม่ปะปนเป็นนโยบายองค์กร แหล่งบังคับที่ใหญ่เกินหยุดก่อน provider
  สิ่งนี้ยืนยัน implementation/ชุดทดสอบสังเคราะห์ ไม่ใช่ผลประเมินคำตอบ AI จริง
- **สื่อภายใน:** ใช้ compiler และ validation เดิม เตรียม/คัดลอก/ดาวน์โหลด Prompt ในเครื่อง
  หน้า media ของ Desktop เองก็เน้นเตรียม Prompt; image generation เป็นอีก tool หนึ่ง
  ไม่ควรนับว่าการย้ายหน้า media ขาดเพียงเพราะยังไม่สร้างภาพ
- **ขอบเขตข้อมูล:** migration โปรไฟล์ตรวจ owner และ active membership ทั้งอ่าน/เขียน
  ไม่ให้ tenant admin อ่านโปรไฟล์ส่วนตัว และไม่อนุญาตเปลี่ยน ownership columns
  DB tests ครอบคลุม tenant/private/workspace/Storage และการสงวนวงเงิน

## ช่องว่างจาก Desktop ที่ยังมีผลต่อการเลือกใช้งาน

- **Editor/Office:** เว็บเป็น Markdown textarea และ Word/TXT พร้อม A4 presets/ตาราง/เลขหน้า
  Desktop ใช้ Tiptap rich JSON, รูป/คำบรรยาย/template, ประวัติย้อนเวอร์ชัน,
  AI proposal accept/reject และ export DOCX/PDF/XLSX/PPTX/Markdown
  เว็บมีเลข version ป้องกัน conflict แต่ยังไม่มีประวัติร่างให้ย้อนคืน
  ดู [เว็บ](../web/src/Chat.tsx#L684), [Word exporter](../web/src/extract.ts#L118),
  [Desktop editor](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/App.tsx#L410)
  และ [Desktop exporter](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/electron/export.ts#L39)
- **ประวัติ/ไฟล์:** เว็บค้น title/message/draft และ export บทสนทนา Markdown ได้
  ยังไม่มี fork/JSON export/attachment-text search และ general image chat vision
  PDF extraction จำกัด 30 หน้า การแนบ Office/PDF และ OCR มีจริงแต่ไม่เท่าการจัดการไฟล์ native
- **ความจำ/learning:** ประเภท ที่มา และ TTL มีแล้ว ยังไม่มี importance, AI proposals,
  upkeep/maintenance board และ Good/Needs fixing → บทเรียน → curator approval
- **Google:** เว็บอ่าน Calendar และ Drive ที่เลือกผ่าน OAuth แยกจาก login
  ยังไม่มี Tasks/Gmail writes, Morning brief แบบรวม Tasks และการเขียนทรัพยากร Google
  การไม่มี write เป็นขอบเขตที่ตั้งใจไว้ใน `docs/architecture.md`
- **งานอัตโนมัติ:** durable jobs/leases ของเว็บคือคิวงานที่ผู้ใช้เริ่ม
  ยังไม่ใช่ recurring user schedules และยังไม่มี bounded tool loop, plan/trace/approval UI
  แบบ [Desktop ToolLoop](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/electron/tool-loop.ts#L123)
- **Skill ส่วนตัว:** เว็บนำเข้า organization pack ผ่าน operator ยังไม่มี personal install,
  enable/disable และเสนอองค์กรตรวจแบบ Desktop
- **Native:** browser/Vault/MCP/process/Docker/เครื่องมือ dev ต้องใช้ Desktop
  ไม่มีเหตุผลให้เปิด shell หรือย้าย credential ของเครื่องเข้า PWA เพื่อเพิ่มจำนวนหมวดที่เท่ากัน
- **AI ส่วนตัว/ภาพ/เสียง:** เว็บใช้ AI ส่วนกลาง ไม่ได้ย้าย model picker/thinking/API/OAuth ส่วนตัว
  ยังไม่มี image generation และ local voice แบบ Desktop
- **ใบเสร็จ:** UI สามส่วนและ human review ใกล้เคียง แต่ privacy/offline/cost ต่างกัน
  Desktop policy ตั้ง `receiptLocalOnly:true`
  ([ต้นทาง:280](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/electron/policy.ts#L280))
  ส่วน [เว็บ](../supabase/functions/_shared/worker.ts#L269) ส่งภาพให้ Gemini หลัง consent
  ยังไม่มี AFP purpose/category handoff ครบ และผล OCR ไม่ใช่การอนุมัติเบิกจ่าย
- **Offline/install:** PWA cache เฉพาะ public shell; งาน/เอกสารไม่อ่าน offline
  ขณะที่ Desktop มีข้อมูลและความสามารถ local ตาม policy ของเครื่อง

## สถานะ hosted ที่ตรวจแบบอ่านอย่างเดียว

Supabase connector ยืนยัน migration ทั้ง 13 รุ่น รวม `20261023120000_member_profiles`
ติดตั้งแล้ว; `api` และ `worker` เป็น ACTIVE version 18 อัปเดต 24 ตุลาคม 2569 เวลา 19:52 น.
ส่วน `google-callback` เป็น ACTIVE version 14
ตรวจเฉพาะ migration metadata และ deployed source ไม่อ่าน rows เอกสาร/พนักงาน secrets หรือ OAuth grants

เทียบ deployed files กับ checkout หลัง normalize CRLF/LF:
worker ตรงกัน 19/22 ไฟล์ และ API 22/25 ไฟล์
ความต่างคือ `contracts.ts` ถูก strip เพราะมีแต่ type และอีกสองไฟล์ยังไม่มี patch Gemini busy ล่าสุด:
`gemini.ts` ไม่มี 503 retry และ `harness-core/src/index.ts` ไม่มี `AI_BUSY` catalogue
จึงยืนยันได้ว่าโปรไฟล์มี backend แล้ว แต่ยังห้ามสรุปว่าฟังก์ชัน deployed ตรงกับ main ทุกไฟล์
Frontend บน homelab ไม่ได้ตรวจ bundle ใหม่ในรอบนี้
บันทึก progress เดิมที่ว่า profile migration ยังไม่ติดตั้งเป็นสถานะในอดีต

ยังไม่ได้ทดสอบ Google account จริง, hosted Auth/Storage permissions, OAuth revocation,
Gemini/receipt accuracy, billing, Word ในโปรแกรมขององค์กร, multi-connection contention
หรือ backup/restore ในรอบนี้ การมี source/deployment ไม่เท่ากับผ่าน acceptance เหล่านี้

## ผลการตรวจในรอบนี้

- Node `25.2.1`, npm `11.6.2` (CI กำหนด Node 24)
- `npm test`: **45/45 ผ่าน** ไม่มี live AI
- `npm run test:db`: **29/29 ผ่าน** ใช้ PostgreSQL/PGlite + pgvector และข้อมูลสังเคราะห์
  ไม่มี isolation test ที่ล้มเหลวถูกข้าม
- `npm run build`: **ผ่าน**
- `npm run test:e2e -- --workers=2`: **36/36 ผ่าน** Chromium desktop/mobile
- `npm run check`: TypeScript ผ่าน แต่ Prettier ล้มเหลว 64 ไฟล์ใน Windows checkout
  เมื่อตรวจ `--end-of-line auto` เหลือเพียง ignored `.claude/settings.local.json`
  ตรวจซ้ำด้วยคำสั่งเดิมใน worktree แยกที่ใช้ LF และเอกสารชุดเดียวกันแล้ว **ผ่าน**
  ไม่แก้ local settings หรือจัดรูปแบบไฟล์ runtime ทั้ง repo ในงาน audit
- `npm run harness:reference -- --source ...`: **ล้มเหลว `SOURCE_INVENTORY_DRIFT`** เพราะ CRLF
  ตรวจ SHA-256 ซ้ำกับ Git blobs ของ baseline แล้ว **ตรงครบ 91/91**
  และ normalize LF ของ checkout แล้วตรง 91/91 จึงไม่พบ source drift จริง
  `npm run harness:reference` แบบไม่ระบุ source ผ่านใน clean worktree แต่ไม่ตรวจ source bytes
- Browser reproductions เพิ่มเติม: dirty draft navigation, delayed save และ transient OCR polling
  ใช้ component จริงกับ demo/Host สังเคราะห์ และไม่มี external request
- Worker revocation และ expired-memory probes ใช้ dispatcher/worker จริงกับ fake I/O ที่ intercept ทุก URL
  เป็นหลักฐาน findings ข้างต้น ไม่ใช่ชุด regression tests ที่ถูกเพิ่มแล้ว
- Canvas ประกอบรายงานผ่าน TypeScript check กับ SDK `cursor/canvas`; ไม่รวมใน runtime ของ Webapp

## ลำดับงานถัดไป

1. แก้ P1 การถอนสิทธิ์ก่อนส่งบริบท และเพิ่ม test ที่ assert ว่าไม่มี upstream request หลัง revoke/cancel
2. แก้การรักษาร่าง/response ที่มาช้า, TTL และ polling ตาม P2 ทั้งสี่ พร้อม regression tests
3. ยกระดับ editor/ประวัติร่าง/Office และทำ acceptance ด้วยเอกสารสังเคราะห์ในโปรแกรมที่องค์กรใช้
4. Deploy ชุด Gemini busy ให้ API/worker ตรงกับ source แล้วทำ real-account acceptance แยกต่างหาก
5. จัดลำดับ personal Skills, Tasks/Morning brief, schedules และ learning ตามงานผู้ใช้จริง
   native browser/Vault/MCP คงเป็นความต่างทางสถาปัตยกรรมจนกว่าจะมีโจทย์และขอบเขตสิทธิ์ที่ชัดเจน

การตรวจนี้ส่งมอบรายงานและแก้ข้อความอ้างอิงที่ล้าสมัย ไม่ได้แก้ runtime findings ทั้งห้ารายการ
