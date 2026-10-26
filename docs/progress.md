# Progress

## 2026-10-26 · Cloud Workspace ระยะ 2: engine ของ Desktop รันใน runtime ของแต่ละ Workspace

- `runtime-main.ts` เปิด engine headless (`server/src/engine.ts`) บน `<ws>/workspace.sqlite` ของ Workspace นั้น และตอบ Manager
  ผ่าน IPC แบบ request/reply (`connect`, `ask`, `conversations`, `health`) ส่งออกเฉพาะ error code ไม่ส่งข้อความที่อาจมีเนื้อหาผู้ใช้
- `RuntimeManager` เพิ่ม `ask`/`conversations` (resume Workspace ที่หยุดให้เอง), `grant()` ที่ออก endpoint/token ทุกครั้งที่ start
  และไม่หยุด runtime ที่มีงานค้างแม้เกินเวลา idle (ปิด Browser แล้วงานยังทำต่อ)
- test ใหม่ 4 ตัว ใช้ endpoint สังเคราะห์บน loopback (ไม่เรียก AI จริง): คำถามพนักงานผ่าน process จริง 60/60 ข้อที่ไม่ต้องค้นเว็บ,
  stop แล้ว resume บทสนทนาเดิมต่อได้และ token ไม่อยู่ใน SQLite, ใช้ session ของอีกคนไม่ได้, งานค้างไม่ถูกหยุดเป็น idle
- ช่องว่าง: คำถาม "วันหยุดราชการปีนี้" ต้องใช้ web search ของ provider ซึ่ง endpoint แบบ compatible ไม่มี และ AI skill selection
  ยังปิดเพราะผูกกับ tool loop (ดู server/README.md) ยังไม่มี Gateway/HTTP/event stream (ระยะ 3), ไม่มี deploy หรือ secret ใหม่

## 2026-10-26 · Cloud Workspace ระยะ 1: Workspace contract และ Runtime Manager

- เพิ่ม `server/src/workspace/`: contract ของ Workspace (id, เจ้าของ, สถานะ runtime, error code), โฟลเดอร์ตาม ADR 0001 §2
  (`users/<user>/workspaces/<ws>/{workspace.json,files,snapshots}` สิทธิ์ 0700) และ `RuntimeManager` ที่สั่ง
  create/list/get/start/stop/resume/health/touch ได้เฉพาะเจ้าของ Workspace; id ของคนอื่นตอบเหมือนไม่มีอยู่ (`WORKSPACE_NOT_FOUND`)
- Runtime ผ่าน `RuntimeDriver` contract: ตอนนี้มี process driver (หนึ่ง Workspace = หนึ่ง Node process, cwd อยู่ใน `files/`,
  environment มีแค่ 5 ค่า ไม่สืบทอด key ของ provider/Supabase) ส่วน Docker/Podman/systemd sandbox ยังรอตัดสินตาม ADR
- มี admission control (`maxRunning`), หยุด runtime ที่ idle (`sweepIdle`), runtime ล้มแล้วสถานะเป็น `failed` และ start ใหม่ได้
- `npm run test:engine` เพิ่ม 6 test: ผู้ใช้สองคนแยกกันและเรียก Workspace ของอีกคนไม่ได้, id ที่พยายามออกนอก data root ถูกปฏิเสธ,
  process แยกและไม่รับ secret, stop/resume แล้วไฟล์อยู่ครบ, crash แล้วกู้ได้, capacity และ idle
- ข้อจำกัด: process driver ไม่ใช่ security boundary ระดับ host (ไม่มี namespace/cgroup/network policy); runtime ยังไม่เปิด engine
  (ระยะ 2) และยังไม่มี Gateway/login/HTTP (ระยะ 3) ไม่มีการ deploy, migration หรือ secret ใหม่

## 2026-10-26 · ปรับ ADR 0001 เป็น STeP Cloud Workspace

- เปลี่ยนปลายทางจากการคิดเป็น engine เดียวต่อผู้ใช้ ไปเป็น Cloud Workspace แบบ Codex/Claude Cloud:
  Web เป็น client/gateway, Linux Server ใช้ทรัพยากรร่วมกัน และแต่ละ Workspace มี Runtime, filesystem,
  SQLite และสิทธิ์แยกกัน ผู้ใช้หนึ่งคนสร้างได้หลาย Workspace และกลับมา Resume หลังปิด Browser ได้
- ระบุขอบเขตว่าเป็น headless cloud workbench ไม่ใช่ Windows/Linux VDI: รุ่นแรกไม่ส่งภาพ Desktop และไม่เปิด
  Host filesystem, privileged Docker, raw VNC/CDP หรือสิทธิ์ข้าม Workspace
- เพิ่ม Runtime Manager, queue/quota, persistent volume, backup, event stream, approval, audit metadata,
  Local LLM router และลำดับพัฒนา ตั้งแต่ headless isolation จนถึง optional Browser/MCP runner
- งานนี้แก้เอกสาร ADR/progress เท่านั้น ยังไม่มีการเปลี่ยน runtime, migration, deployment หรือ secret

## 2026-10-26 · Web App ปรับการส่งออก TOR และเอกสารราชการให้ตรงกับ Desktop

- แก้ browser DOCX/PDF exporter ให้ชื่อเรื่องอยู่กึ่งกลาง แต่บล็อกหน่วยงาน/ข้อมูลต้นเรื่องและเนื้อหา TOR ชิดซ้ายอย่างชัดเจน
  ตารางข้อความกำหนดชิดซ้ายและตัวเลขชิดขวาเหมือนกันทั้ง Word และหน้า PDF
- เพิ่ม `th-TH` ทั้ง language และ East Asian line-breaking metadata ใน DOCX เพื่อให้ Word ตัดบรรทัดภาษาไทยถูกต้องขึ้น
  โดยยังคงใส่ zero-width break เฉพาะสำเนาส่งออก ไม่แก้ร่างต้นฉบับ
- เพิ่ม source-backed organization reference สำหรับการร่าง: ใช้ชื่อเต็ม
  `อุทยานวิทยาศาสตร์และเทคโนโลยี มหาวิทยาลัยเชียงใหม่` และที่อยู่ของอุทยานเมื่อเอกสารมีช่องหน่วยงานที่รับผิดชอบ/ผู้ส่ง
  พร้อมคงหน่วยงานอื่นที่ผู้ใช้ระบุและแจ้งความขัดแย้ง ไม่เติมช่องหน่วยงานขึ้นมาเอง
- Validation: `check`, `build`, unit/API/PWA 91/91, PostgreSQL 29/29, engine 3/3 และ engine pin `desktop-v0.6.20`
  ผ่าน; targeted document tests 25/25 ผ่าน
- หลัง merge main รันซ้ำบน Windows: check, build, unit/API/PWA 96/96, PostgreSQL 29/29, engine pin และ
  Playwright desktop/mobile 76/76 ผ่าน; engine isolation ล้มเฉพาะ POSIX mode 0700 ที่ Windows ไม่รองรับ
  (ข้อจำกัดเดิม) และผ่าน 3/3 ใน Linux CI ของ PR
- ต้อง rebuild/deploy frontend และ deploy `worker` (และ `api`) ด้วย เพราะ `document-contract.ts` และ
  `documentRequest` ที่เพิ่ม organization reference อยู่ในเส้นทางร่างของ worker ไม่มี migration
- Merge main หลัง #32/#33 เข้ามาแล้ว (คู่มือ TOR content-by-type และ saraban guide) ขัดแย้งเฉพาะ progress นี้

## 2026-10-25 · Rollout คู่มือ TOR/หนังสือราชการและปิด PR ที่ค้าง

- Harness #235 merge เป็น `2874bf1` หลัง CI ผ่านทุกระบบ (รวม Windows และ macOS Electron)
  และ Webapp #32 merge เป็น `4844e2a` หลัง Verify PWA ผ่านครบ รวม engine isolation บน Linux 3/3,
  unit/API/PWA 94/94, PostgreSQL 29/29, engine pin, reference, check, build และ Playwright 76/76
  ทดสอบหน้าเครื่องมือเอกสารซ้ำหลังจัดลำดับไฟล์รอบสุดท้ายบน Windows ผ่าน 18/18
- Deploy `api` v24 และ `worker` v25 จาก main `4844e2a` ด้วย CLI 2.122.0, `--no-verify-jwt --use-api`
  และ shared import map ทั้งสอง ACTIVE เทียบ source ที่ deploy กับ main แล้วตรงทุกไฟล์ runtime
  (API 25 ไฟล์, worker 26 ไฟล์; ยกเว้น type-only `contracts.ts`) callback ยัง v14 ไม่มี migration/secret เปลี่ยน
- นำเข้า Harness pack `2874bf1` ให้ STeP แบบ atomic: 108 sources / 48 Skills ตรวจ body/instructions
  และ source version ทุกรายการกับ pack แล้วตรงกัน ก่อนนำเข้ามีสำรองข้อมูลเดิมจริง 106 sources / 48 Skills
  ไว้เฉพาะ `.exports/production-before.json` ที่ Git ignore คีย์ operator อยู่เฉพาะใน process และล้างหลังใช้
- หน้าเว็บ build บน homelab จาก tree ของ `e5a816c` (ตรงกับ PR #32 ที่ merge แล้ว) และสลับ container ใหม่
  `step-ai-pilot-web-1` healthy โดยคง `.local/homelab.env` และ origin HTTPS ของ tailnet เดิม
  image เก่าเก็บเป็น `step-ai-webapp:pilot-pre32-1a857b7` และ source เดิมอยู่ที่
  `~/STeP-AI-Webapp.prev-pre32-1a857b7` ไม่ลบของเดิม
- Smoke หลัง rollout: hosting/CSP/PWA/cache/callback/missing assets ผ่าน, API origin ที่อนุญาตได้ 401
  เมื่อไม่มี identity, origin อื่นได้ 403 และ worker ไม่มี dispatch secret ได้ 403
  Chromium ผ่าน HTTPS จริงทั้ง desktop/mobile: anonymous protected route ไป login, แบบฟอร์มเตรียมร่างส่วนตัว,
  Word มีฟอนต์ฝังครบสี่ไฟล์และตราครุฑ 1.5 ซม., consent ก่อนส่ง AI, ไม่มี page error และไม่มี external request
  ใช้เฉพาะข้อมูลสังเคราะห์ใน demo ไม่เรียก Google/Gemini จริง
- ย้อนกลับ: tag image ข้างต้นกลับเป็น `pilot` แล้ว compose up แบบ `--no-build --wait`, deploy API/worker
  จาก `1a857b7` และ import private backup ด้วย operator หากต้องย้อน pack ไม่มี schema เปลี่ยน
- ข้อจำกัดที่ยังอยู่: ยังไม่ได้ทำ real-account acceptance หลัง rollout, ตรวจคุณภาพร่างด้วย Gemini หรือไฟล์ใน Word จริง
  `docs/thai-data-formatting.md` ยังไม่ถูก export และ TOR ยาวอาจข้ามแหล่งอ้างอิงทั่วไปโดยแจ้งในผลตรวจ
  การเปิดให้พนักงาน pilot ยังต้องทำตามเงื่อนไขใน ADR 0001

## 2026-10-25 · เชื่อมคู่มือ TOR และหนังสือราชการจาก Harness ที่ merge แล้ว

- Harness #233/#234 รวมแล้ว และ #235 merge เป็น `2874bf1` หลัง CI ทุกระบบผ่าน ไม่มี PR เปิดค้างในทั้งสอง repo
  ก่อนเปิด PR ของชุดแก้นี้ ไม่แก้ checkout Desktop และไม่เลื่อน engine pin จาก `desktop-v0.6.20`
- แก้งานค้างที่อ้าง `WORKING_FILE_CHARS` โดยยังไม่ประกาศค่า (ทำให้ document tests ล้ม 6 ข้อ) และให้เส้นทาง
  Skill กับเครื่องมือร่างอ่านไฟล์ประกอบได้ถึง 16,000 ตัวอักษร ส่วนแชตทั่วไปยัง 6,000 ไฟล์ที่ยาวกว่ายังแจ้งว่าบางส่วน
- เพิ่มเฉพาะ path ของ `tor-content-by-type.md` ให้ TOR และ `saraban-writing-guide.md` ให้บันทึก/หนังสือ
  ตาม upstream พร้อม provenance ไม่มีเนื้อหาคู่มือหรือเอกสารองค์กรเข้า Git คู่มือ TOR ได้ลำดับก่อนแหล่งอ้างอิงทั่วไป
  ภายในงบบริบทเดิม ไฟล์ที่ไม่พอยังต้องแจ้งใน `document_review` เพดานจริง 32,000 token ยังตรวจด้วย `countTokens`
- ตรวจ pack ใหม่แบบ private: 108 sources / 48 Skills ที่ `2874bf1`, retrieval 61/61 และ buyer identity 3/3
  ผ่าน worker จริงด้วย provider จำลองพบว่าคู่มือใหม่ของ TOR/บันทึก/หนังสือเข้าครบและครั้งเดียว TOR คอมพิวเตอร์ AI
  ยังข้าม `tor-drafting-guide.md` และ `procurement-source-map.md` เมื่อบริบทเต็ม ส่วนบันทึก/หนังสือไม่ข้าม
- แก้ `check-server-types.mjs` ให้เรียก compiler ด้วย Node โดยตรงแทน `npx` ที่ spawn ไม่ได้บน Windows
  และรายงานข้อผิดพลาดการเริ่ม process แทนการล้มตอนอ่าน stdout
- Validation: check, build, unit/API/PWA 94/94, PostgreSQL 29/29 และ Playwright desktop/mobile 76/76
  ใช้ข้อมูลสังเคราะห์ ไม่เรียก AI/Google จริง engine pin ผ่าน แต่ engine isolation test บน Windows ยังล้มที่
  POSIX directory mode (Windows ไม่รองรับ 0700 แบบ Linux) จึงต้องผ่าน Linux CI ก่อน merge ห้ามข้าม isolation test
- ยังต้อง rollout: deploy API/worker, rebuild หน้าเว็บ homelab และ import pack ใหม่ ก่อนหน้านี้ตรวจ source ของ
  worker v24 แล้วตรง main `1a857b7` ทุกไฟล์ที่ใช้งาน (ยกเว้น type-only contracts) มี pack เดิมสำหรับย้อนกลับ
  `docs/thai-data-formatting.md` ยังไม่ถูก export และยังต้องทดสอบคุณภาพร่างกับบัญชีจริงหลัง deploy

## 2026-10-25 · หน่วยงานเจ้าของเรื่องเริ่มเป็นองค์กรของผู้ใช้

- เจ้าของโครงการรายงาน: หน่วยงานรับผิดชอบเป็น STeP อยู่แล้ว ไม่ควรถูกปล่อยเป็น `[รอยืนยัน: หน่วยงานเจ้าของเรื่อง]`
- Desktop เองให้พิมพ์ช่องนี้เอง (agent ของ Desktop เห็นชื่อหน่วยงานจากตัวอย่าง) เว็บจึงเติมช่อง "หน่วยงานเจ้าของเรื่อง"
  / "ส่วนราชการ" / "หน่วยงาน / ที่อยู่ผู้ส่ง" ด้วยชื่อองค์กรของผู้ใช้ (`tenants.name` ตอนนี้คือ "STeP") ตั้งแต่เปิดแบบฟอร์ม
  ผู้ใช้เห็นและแก้หรือเติมชื่อฝ่ายได้ มีข้อความกำกับว่าเป็นค่าเริ่มต้นจากองค์กร
- ชื่อองค์กรอย่างเดียวไม่ทำให้ปุ่มเตรียมร่างกดได้ ต้องกรอกเรื่องของงานอย่างน้อยหนึ่งช่องเหมือนเดิม
- Validation (Node 25.2.1, demo สังเคราะห์): TypeScript, build, unit/API/PWA 89/89, PostgreSQL 29/29,
  Playwright 76/76 (ใหม่: ช่องหน่วยงานเริ่มเป็นองค์กร แก้ได้ และค่าที่แก้ไปถึงข้อความที่ส่งให้ AI)
- ต้อง rebuild หน้าเว็บ homelab เท่านั้น ไม่มี API, worker หรือ migration ยังไม่ได้ทำ

## 2026-10-25 · ร่าง TOR อ่านตัวอย่างที่ตรงงานทั้งไฟล์

- อาการ: ร่าง TOR สำเร็จแล้ว (worker v23 แยกร่างกับผลตรวจ ไม่ถูกตัด) แต่โครง ขนาด ย่อหน้า รายละเอียด และชื่อหน่วยงาน
  ไม่เหมือนตัวอย่างของ Harness metadata ของ run แสดงว่าตัวอย่าง `tor-goods-ai-computer-master-example.md` ไม่ได้ถูกโหลด
- สาเหตุ:
  - Skill มีตัวอย่างนี้เป็นไฟล์ตัวชี้ 438 ตัวอักษร การจัดอันดับนับคำที่ตรงในไฟล์ จึงได้คะแนนต่ำกว่าคู่มือยาว ๆ เสมอ
  - ถ้าได้ ก็ถูกตัดที่ 6,000 จาก 14,811 ตัวอักษร
  - engine ของ Desktop เปิดไฟล์ที่ Skill อ้างถึงทั้งไฟล์เองได้ แต่เว็บต้องเลือกไฟล์ให้ล่วงหน้าในรอบเดียว
  - ตัวส่งออกเป็นตัวเดียวกับ Desktop บทบาทของบรรทัด (บล็อกหัวเรื่องกึ่งกลาง, หัวข้อ, ย่อหน้า) จึงขึ้นกับว่าร่างวางโครงตามตัวอย่างหรือไม่
- แก้:
  - ไฟล์ตัวชี้ถูกจัดอันดับด้วยเนื้อหาของไฟล์ปลายทาง
  - งานร่างเอกสารอ่านตัวอย่างที่เลือกได้ถึง 16,000 ตัวอักษร (แชตทั่วไปยังตัดที่ 6,000)
  - งบประมาณของงานร่างเป็น 48,000 token ประมาณ (ราว 27,000 token จริงตามสัดส่วนที่วัดจาก run จริง 2 ครั้ง)
    เพดานจริง 32,000 ยังตรวจด้วย `countTokens` ก่อนทุกครั้ง
- Validation (Node 25.2.1, ข้อมูลสังเคราะห์, ไม่เรียก AI จริง): TypeScript, build, unit/API/PWA 89/89 (ใหม่: คำขอ TOR
  คอมพิวเตอร์ AI ได้ตัวอย่างเต็มไฟล์ครั้งเดียว ซึ่งล้มกับโค้ดเดิม, นอกงานร่างยังตัดที่ 6,000), PostgreSQL 29/29
  ไม่ได้รัน Playwright เพราะไม่เปลี่ยน UI
- ยังไม่ได้ทำ: แม่แบบ DOCX ของหน่วยงาน (`document-template.ts` ของ Desktop) ซึ่ง Desktop ใช้รักษารูปแบบของหน่วยงานทั้งฉบับ
- ต้อง deploy `worker` (และ `api`) ยังไม่ได้ทำ

## 2026-10-25 · เก็บเหตุผลที่ Gemini ปฏิเสธ เพื่อแยก overload กับคำขอใหญ่

- อาการบน pilot หลัง #28: ร่าง TOR ล้มด้วย `AI_BUSY` 2 ครั้งติดกัน (worker v22) โดยผ่านด่านบริบทและ countTokens แล้ว
  แต่ generate ได้ 503 ทั้งสองครั้ง ครั้งหนึ่งใช้ 64 วินาทีก่อนล้ม ส่วนแชตสั้นช่วงเดียวกันผ่านปกติ จึงน่าจะล้มเฉพาะคำขอใหญ่
  ที่ใช้เวลานาน แต่ log เก็บแค่รหัส 503 จึงยืนยันไม่ได้
- ตอนนี้ log ของ Gemini เก็บ step, HTTP status, `status` และ `message` จาก error body ของ Google (ตัดที่ 200 ตัวอักษร
  และแทนสิ่งที่หน้าตาเหมือน key ด้วย `[key]`), เวลาที่ใช้ต่อครั้ง และว่าเป็นครั้งที่ลองซ้ำหรือไม่ ครั้งแรกที่ได้ 503 ก็ถูกบันทึก
  ไม่มี prompt คำตอบ หรือ key
- Validation (Node 25.2.1, ไม่เรียก AI จริง): TypeScript, build, unit/API/PWA 87/87, PostgreSQL 29/29 ไม่ได้รัน
  Playwright เพราะไม่เปลี่ยน UI
- ต้อง deploy `worker` (และ `api`) ยังไม่ได้ทำ

## 2026-10-25 · ร่าง TOR ล้มด้วย CONTEXT_LIMIT หลัง rollout #26

- อาการบน pilot: ร่าง TOR ได้ "แหล่งข้อมูลบังคับใหญ่เกินบริบทที่รองรับ" ระบบไม่ส่งงานให้ AI
- สาเหตุ (วัดจากขนาดไฟล์ใน production ไม่ได้เปิดเนื้อหา): #26 ใส่ Skill หลัก, Skill ร่วม
  `thai-official-documents` (11,141 ตัวอักษร), แม่แบบ และเอกสารอ้างอิงทั้งหมด รวมได้ราว 37,000 token ประมาณ
  เกินเพดาน 27,000 ของ worker และมีไฟล์ซ้ำ 4 ไฟล์ที่ทั้ง Skill หลักและเครื่องมือโหลด (แม่แบบ ๑๖ หัวข้อ, คู่มือร่าง,
  แผนที่แหล่งจัดซื้อ, task-adaptations)
- ตัวประมาณนับอักษรไทย 1.1 ตัวต่อ token ซึ่งสูงกว่าที่ Gemini นับจริงราว 2 เท่า (run จริง: ประมาณ ~15,000
  นับจริง 8,211)
- แก้:
  - ไม่โหลดไฟล์ที่ Skill หลักโหลดแล้วซ้ำ
  - งานร่างเอกสารใช้เพดานประมาณ 40,000 (แชตทั่วไปยัง 27,000) เพดานจริง 32,000 token ยังตรวจด้วย `countTokens`
    ก่อนทุกครั้ง 40,000 จะเกินเพดานจริงก็ต่อเมื่อเอกสารนับจริงเกิน 0.8 token ต่อ token ประมาณ
  - Skill ร่วมและแม่แบบเป็นของบังคับ เอกสารอ้างอิงเติมตามลำดับจนเต็มงบ โดยกันที่ไว้ 3,000 สำหรับคำตอบจาก
    เอกสารองค์กร ความจำ ประวัติ และร่างปัจจุบัน (ตอนแก้ร่าง) ไฟล์ที่ไม่พอจะถูกระบุว่า "ข้ามเพราะบริบทเต็ม"
    ให้บันทึกใน `document_review` ไม่หยุดทั้งงาน
- TOR ขนาดเท่า production (ข้อความสังเคราะห์) ตอนนี้ได้ไฟล์ครบทุกไฟล์ ไฟล์ละครั้ง ใช้ราว 31,000 token ประมาณ
- Validation (Node 25.2.1, ข้อมูลสังเคราะห์, ไม่เรียก AI จริง): TypeScript, build, unit/API/PWA 87/87 (ใหม่:
  TOR ขนาดจริงผ่าน worker, งบไม่พอยังคงแม่แบบและระบุไฟล์ที่ข้าม, ไม่โหลดซ้ำ), PostgreSQL 29/29,
  Playwright 74/74
- Rollout: merge #28 (`5cb5970`) หลัง CI ผ่าน แล้ว deploy จาก main ด้วย `--no-verify-jwt --use-api --import-map`
  `worker` เป็น v22 (bundle ใหม่) `api` เป็น v21 (bundle hash เท่า v20 เพราะโค้ด api ไม่เปลี่ยน) ไม่มี migration
  หน้าเว็บ homelab ไม่ต้อง rebuild ตรวจเฉพาะรายการฟังก์ชัน/เวอร์ชัน/สถานะ ยังไม่ได้ลองร่างจริงด้วย Gemini
- ย้อนกลับ: deploy `worker` จาก `b1fe31a` (กลับไปเป็นอาการ CONTEXT_LIMIT) หรือจาก `203cff8` (ก่อน #26)

## 2026-10-25 · Rollout ของ #26 และ #16 (คุณภาพร่าง ตราครุฑ การจัดหน้า)

- Merge #26 (`40231f7`) แล้ว #16 (`b1fe31a`) หลัง CI ผ่าน ทั้งสองเป็นข้อยกเว้นของ feature freeze ใน ADR 0001
  ข้อ 11 ที่เจ้าของโครงการอนุมัติ #16 ถูก rebase ซ้อนบน #26 เพื่อให้ diff มีเฉพาะส่วนการจัดหน้า/ส่งออก
- Supabase (ผู้ดูแลสั่งผ่าน CLI จาก main `b1fe31a` ด้วย `--no-verify-jwt --use-api --import-map`):
  `worker` เป็น v21 และ `api` เป็น v20 ACTIVE `google-callback` ยัง v14 ไม่มี migration ตรวจเฉพาะรายการ
  ฟังก์ชัน/เวอร์ชัน/สถานะ ไม่ได้เทียบ source ที่ deploy และไม่ได้เรียก API จริง
- Homelab: ก่อนแทนที่ ตรวจว่าโค้ดที่รันอยู่ตรงกับ `b9d5f6b` (เทียบ hash ของ `Chat.tsx`, `App.tsx`,
  `package.json` หลังตัด CR) แล้ว tag image เดิมเป็น `step-ai-webapp:pilot-b9d5f6b` เก็บแหล่งเดิมไว้ที่
  `~/STeP-AI-Webapp.prev-b9d5f6b` แล้ว build จาก `git archive` ของ `b1fe31a` โดยคง `.local/homelab.env`
  container `step-ai-pilot-web-1` healthy
- Smoke ผ่าน HTTPS บน tailnet origin เดิม: shell 200, `/healthz` 200, asset ที่ไม่มี 404, CSP คงอยู่,
  ไฟล์ฟอนต์ TH Sarabun ให้บริการจากเว็บเอง และ `manifest.json` ของฟอนต์ตรงกับ hash ที่ตรึงไว้ (`8bafe458…`)
- ย้อนกลับ: แท็ก image `pilot-b9d5f6b` กลับเป็น `pilot` แล้ว `compose up -d --wait` และ deploy `api`/`worker`
  จาก commit `203cff8` (v19/v20 ก่อนหน้าเทียบเท่ากับโค้ดของ `e381eb8`/`203cff8`)
- ยังไม่ทำ: ทดสอบร่างจริงด้วยบัญชีจริงและ Gemini (TOR และบันทึกข้อความ) real-account acceptance และ
  การแก้ `docs/thai-data-formatting.md` ที่ยังไม่ได้นำเข้า (ร่างจะแจ้งเป็นช่องว่าง)

## 2026-10-25 · Garuda, page layout and Desktop's Word/PDF export

- The draft pane now exports with Desktop's exporter instead of the web's simple Markdown-to-Word:
  layout roles for every document tool (title, front matter, sender, date, ที่/วันที่ on one line,
  signature block, first-line indents), the สารบรรณ A4 page (top 2.5, bottom 2, left 3, right 2 cm),
  Thai page numbers, header/footer text, a table of contents, Thai word breaks, and tables sized for
  Thai headers and right-aligned figures.
- ตราครุฑ as Desktop places it: 1.5 cm beside "บันทึกข้อความ" on a memo, 3 cm centred on an external
  letter, first page only; none on TOR, proposals and minutes; "ไม่ใส่ตราครุฑ" for other agency forms.
  The image is Desktop's pinned 800 × 800 PNG with its provenance notice; it carries no authority to
  issue letters, and the pane says the layout must be checked against the agency's form.
- Fonts: TH Sarabun New (memo) or TH SarabunPSK (other official drafts), selectable. The pinned font
  files are served by the site and embedded in the Word file, so it opens the same on computers without
  them. The export result states the font, Garuda height and whether embedding succeeded.
- PDF goes through the browser's print dialog using Desktop's A4 page HTML with the same fonts. A
  "หน้ากระดาษ" view shows that page beside the editor before exporting. Markdown export replaces .txt.
- The export code (including the Garuda) loads only when a draft pane opens; startup JavaScript is
  unchanged (about 740 kB before and after, split differently). Small IBM Plex font subsets are no longer
  inlined as `data:` URIs, which the production CSP (`font-src 'self'`) had been blocking.
- Stacked on the drafting-quality change (#26). Validation under Node 25.2.1: TypeScript, build, 84
  unit/API/PWA tests (new: Garuda bytes, memo, letter and no-Garuda layouts, margins, fonts, PDF page
  escaping), 29 PostgreSQL tests and 74 desktop/mobile Playwright tests (Word with embedded fonts and the
  Garuda header, page preview, PDF print, axe on the pane in both themes). A one-off run of a production build with the homelab nginx
  headers showed the preview, fonts, print and Word export work with no CSP violation.
- Not carried over yet: agency DOCX templates (Desktop's `document-template.ts`), Excel/PowerPoint
  export, images in drafts, and saving export settings with the task. Requires only a homelab frontend
  rebuild; no API, worker or migration change.

## 2026-10-25 · Document drafts follow the Skill, template and drafting contract

- Observed after #25 fixed the canned reply: a TOR run with Skill `tor-government-writing` reached the model
  but the draft was below standard. Run metadata only (no message text) showed it received just the Skill's
  own three support files. The Skill's template is a 349-character pointer to the central 16-section
  template (5,523 characters, present in production) that was never followed; the supporting Skill
  `thai-official-documents` (layout and drafting checks) and the 14.8k-character TOR master example it
  points to were not loaded; the answer used 4,092 of 4,096 output tokens, so it was probably cut short;
  and the answer was not split into draft and review.
- A run now records its document tool (`input.documentTool`, validated against Desktop's five tools).
  The worker loads Desktop's `<document_tool_contract>` (copied verbatim) between organization rules
  and personal preferences, the supporting Skill `thai-official-documents`, the tool's working template
  and drafting references by imported path, and follows short pointer files one hop to the central
  copy. Files the Harness pack lacks are named as gaps the review must record, never filled from
  general knowledge. A revision sends the current draft as untrusted content.
- Document runs may answer with up to 8,192 tokens, only as far as the existing reservation covers:
  the reservation assumes 64k input tokens while context stays capped at 32k. No budget rule changed.
- The answer uses Desktop's `<document_draft>`/`<document_review>` envelope: the draft opens in the
  ผลงาน pane, and the conversation shows only the review and what still needs confirmation. The
  document tool page shows which Skills and template it uses.
- Validation under Node 25.2.1: TypeScript, build, 48 unit/API/PWA tests (new: context assembly,
  pointer files, contract order, output cost bound, and a mocked worker run proving a TOR reaches the
  model with its contract), 29 PostgreSQL tests and 38 desktop/mobile Playwright tests (new: draft goes
  to the pane, review stays in the chat). No live AI call was made.
- Known gap in the imported Harness pack: `docs/thai-data-formatting.md` (date guide) is not imported, so
  drafts list it as missing. Every other template and reference the five tools name is in production.
- Scope: drafting quality only. Garuda, page layout and Word/PDF export stay in #16, held under the
  ADR 0001 feature freeze.
- Requires redeploying the worker and the API and rebuilding the homelab frontend (the web sends the
  document tool). No migration. Not yet done.

## 2026-10-25 · แบบฟอร์มร่างเอกสารได้ข้อความ "ไม่พบเอกสาร" แทนร่าง

- ทำซ้ำได้บน main ด้วย worker จริงและข้อมูลสังเคราะห์: ข้อความจากแบบฟอร์ม TOR (ทั้ง 2 แบบ), บันทึกข้อความ และข้อเสนอโครงการ
  มีคำอย่าง "งบประมาณ" หรือ "พัสดุ" ซึ่งตรงกับเงื่อนไขคำถามเกี่ยวกับ STeP เมื่อค้นเอกสารองค์กรไม่เจอ worker จึงตอบ
  "ยังไม่พบเอกสารองค์กรที่ยืนยันเรื่องนี้ครับ…" ทันที ไม่ส่งงานให้ AI เลย หนังสือภายนอกกับรายงานการประชุมไม่โดน
- แก้: ถ้างานมี Skill ที่เลือกและลงทะเบียนในองค์กรจริง (ทุกแบบฟอร์มส่ง Skill ของตัวเองมา) ถือเป็นการร่างตาม Skill
  ไม่ใช่คำถามที่ต้องตอบจากเอกสาร ส่วนชื่อ Skill ที่ไม่มีในองค์กรไม่ทำให้ข้ามกฎนี้ คำถามเรื่อง STeP ที่ไม่มีเอกสาร
  และไม่มี Skill ยังได้ข้อความเดิม เงื่อนไขเดียวกับส่วนที่ 1 ของ #16 แต่ไม่รวมตราครุฑ การจัดหน้า และ document contract
  ซึ่งเป็น feature (feature freeze ตาม ADR 0001)
- Validation (cloud container, Node 22.22.0, ข้อมูลสังเคราะห์, ไม่เรียก AI จริง): test ใหม่ 8 ข้อใน `worker-revocation.test.ts`
  ไม่มีการแก้ 4 ข้อล้ม มีการแก้ผ่านทั้งหมด; `npm run check`, `npm test`, `npm run test:db`, `npm run build`
- ต้อง deploy `worker` (และ `api` ถ้าต้องการให้ตรงกัน) จึงจะมีผลบน homelab ยังไม่ได้ deploy

## 2026-10-25 · รวมบันทึกจาก PR ที่ค้าง

- นำบันทึก rollout จาก #9 (#7/#8, 2026-10-23), #13 (#12, 2026-10-24) และ #15 (Gemini free tier, 2026-10-24)
  มาใส่ตามลำดับวันที่ เนื้อหาเดิมไม่แก้ PR เหล่านั้น conflict กับ main เพราะเพิ่มบันทึกไว้บนสุดของไฟล์เดียวกัน
- แก้คู่มือ deploy ตาม #9: คำสั่ง deploy ต้องมี `--use-api --import-map supabase/functions/deno.json`
  และชื่อ secret ของ Picker คือ `GOOGLE_PROJECT_NUMBER` ตามที่ `supabase/functions/_shared/api.ts` อ่านจริง
  (คู่มือเดิมเขียน `GOOGLE_PICKER_APP_ID`) ถ้าเคยตั้ง secret ด้วยชื่อเดิม ต้องตั้ง `GOOGLE_PROJECT_NUMBER` เพิ่ม
- ย้ายกติกา "ยืนยันการเขียนข้อมูลภายนอกเป็นรายครั้ง" จาก #19 มาเป็น [ADR 0002](adr/0002-confirm-each-external-write.md)
  ส่วนแผน web-only parity ใน #19 ถูกแทนด้วย ADR 0001 แล้ว
- เปลี่ยนเฉพาะเอกสาร ไม่มี deploy หรือ secret

## 2026-10-25 · Protected routes reconciled with the Desktop-parity shell and draft protection

- Merged main `7aaa7d6` (through #23) into the protected-route branch. The shell keeps its lazy-loaded
  tool pages; its `replaceState` page state is replaced by `web/src/routes.ts`, so pages follow
  browser history and anonymous visitors go to `/login?next=…`.
- Main's unsaved-draft protection is kept: an account change clears drafts and the discard prompt
  inside the verified-identity handler, and sign-out still asks before discarding a draft, then
  clears the return path and opens `/login`.
- The Auth browser tests use the new shell: the Skill page opens from the sidebar's เครื่องมือ
  navigation, sign-out runs from เมนู STeP, and "no private view" checks look for that navigation in
  the DOM. The old เมนูหลัก label no longer exists, so those checks would otherwise pass vacuously; the
  sign-in test first asserts the navigation is present.
- Validation (cloud container, Node 22.22.0): TypeScript/Prettier, 65 unit/API/PWA tests, 29 PostgreSQL
  tests, 3 engine tests, production build and 70 of 72 desktop/mobile Chromium checks, including all
  16 Auth checks and the draft regression suites. The two Word download checks fail the same way on
  unchanged main in this container (Chromium 141 names the file `download`); GitHub CI remains
  authoritative.
- The Supabase system is under feature freeze (ADR 0001); this is pilot sign-in hardening, for the owner
  to accept or close. Left: human review, then rebuilding the homelab frontend after merge and
  repeating real-account sign-in, reload and sign-out there.

## 2026-10-25 · ระยะ 2: engine ของ Desktop รันแบบ headless

- เพิ่ม submodule `harness/` ที่ `desktop-v0.6.20` (`90ee71c`) และ `server/` ที่สร้าง `WorkService` ของ Desktop
  โดยไม่มี Electron ไม่ได้ copy หรือแก้โค้ด engine เลย ผู้ใช้แต่ละคนมี SQLite ของตัวเองในโฟลเดอร์ 0700
- เกณฑ์ผ่านของ spike: คำถามพนักงานชุดเดิม **61/61** ผ่าน engine ทั้งเส้น (router → ความรู้องค์กร → prompt)
  โดยเอกสารอันดับแรกที่จะส่งให้ AI ตรงกับคำตอบที่คาดไว้ ส่วนข้อที่ไม่ควรมีเอกสารก็ไม่มี ใช้ adapter สังเคราะห์
  ไม่เรียก AI จริง ทดสอบแล้วว่าตัวตรวจจับความผิดพลาดได้จริง (ตัวตรวจที่ผิดได้ 11/61)
- server profile: เปิด privacy check ส่วน authority check ใช้ค่าเดียวกับ Desktop (ปิด) ถ้าเปิด authority
  คำถาม "เอกสาร WI ฉบับไหนถูกยกเลิกแล้ว" จะติด `AUTHORITY_REVIEW_REQUIRED` ต้องตัดสินว่าจะเปิดหรือไม่ก่อนระยะ 3
- `@github/copilot-sdk` ถูกแทนด้วย module ที่ไม่ยอมเริ่มทำงาน (Copilot ปิดบน server) dependencies เพิ่มแค่
  `mdast-util-from-markdown` 2.0.2 และ `@xmldom/xmldom` 0.8.15 เวอร์ชันเดียวกับ Desktop
- `npm run engine:ask` ให้เจ้าของโครงการลองบน homelab กับ endpoint ที่เข้ากับ OpenAI ได้ ทดสอบกับ endpoint ปลอม
  ในเครื่องแล้วว่าใช้ `CompatibleAdapter` ของ Desktop ได้ทั้งเส้น ยังไม่ได้ลองกับ provider จริง
- CI: checkout submodule, `check:engine-pin` (ต้องเป็น tag `desktop-v*`), `test:engine` และ type check ของ `server/`
  (diagnostics ในไฟล์ engine ปล่อยให้ CI ของ Desktop ที่มี dependencies ครบเป็นคนตรวจ)
- Validation (cloud container, Node 22.22.0): `npm run check`, `npm test` 62/62, `npm run test:db` 29/29, `npm run build`,
  `npm run test:engine` 3/3, `check:engine-pin` ผ่าน และลองให้ pin ผิดแล้วตรวจจับได้ Playwright ไม่ได้รัน (ไม่มี UI เปลี่ยน)
- ยังไม่ทำ: gateway, process แยกต่อผู้ใช้, tool host ของ server, router proxy, ลองกับ provider จริงบน homelab

## 2026-10-25 · ทิศทางใหม่: engine ของ Desktop บน server องค์กร

- บันทึกการตัดสินใจใน [ADR 0001](adr/0001-server-engine-direction.md): เว็บเป็นตัวกลาง งานจริงรันบน engine ของ Desktop
  (git submodule ของ Harness ที่ release tag) บน hardware ที่องค์กรจะซื้อ 1 ผู้ใช้ = 1 engine process + SQLite
  มี gateway ทำ login/เพดาน/admin/audit และ router proxy เลือกระหว่าง API กับ local LLM
- ระบบ Supabase ปัจจุบัน **feature freeze**: แก้เฉพาะ bug และสิ่งที่ pilot ต้องใช้
- เจ้าของโครงการรายงานว่าใช้งานจริงด้วยบัญชีจริงได้แล้ว: Google login, เชื่อม Drive/เลือกไฟล์, แชต Gemini กับเอกสาร STeP,
  ร่างและ export Word, OCR ใบเสร็จจริง agent ไม่ได้ตรวจซ้ำและไม่ได้เห็นหลักฐาน (log/ภาพหน้าจอ) ด้วยตัวเอง
  ยังไม่ได้ทดสอบ: ถอนสิทธิ์หรือยกเลิกระหว่างงานด้วยบัญชีจริง
- รอเจ้าของโครงการก่อนเปิด pilot 3–5 คน: ทดสอบการถอนสิทธิ์ด้วยบัญชีที่สอง (งานต้องจบด้วย `ACCESS_DENIED`
  และไม่มีคำตอบ), ให้กลุ่มผู้ดูแลองค์กรเป็น Owner ของ Google Cloud project, หนังสืออนุมัติใช้ Gemini free tier
  กับเอกสารที่ไม่ลับ และเชิญผู้ใช้ pilot
- ถัดไป (agent): headless spike ของ engine และ benchmark local LLM คู่ขนาน ตามลำดับงานใน ADR
- เปลี่ยนเฉพาะเอกสาร ไม่มีการเปลี่ยนโค้ด, deploy หรือ secret

## 2026-10-25 · แก้ findings จาก audit runtime

- P1 worker: ก่อนส่งบริบทไป AI ทุกครั้ง (หลังรอ Drive/Storage, หลัง countTokens และระหว่าง backoff 503
  ของ countTokens/generateContent/embedContent) worker ตรวจสิทธิ์และ lease ซ้ำ ถ้า revoke หรือ cancel
  จะไม่ส่งบริบทและไม่ retry; ปิดงานด้วย `answer: null` และโค้ด `ACCESS_DENIED`/`RUN_INTERRUPTED`
- P2 ร่าง: ร่างแยกตามงาน คงอยู่เมื่อเปลี่ยนหน้าโดยไม่ใช้ browser storage, response ที่บันทึกช้าหรืออ่านช้า
  ไม่ย้อนข้อความที่พิมพ์ใหม่, มี dialog เตือนก่อนออกจากระบบและ `beforeunload` เมื่อมีร่างที่ยังไม่บันทึก
- P2 ความจำ: แก้ความจำที่หมดอายุหรือเหลือบางส่วนไม่เปลี่ยนวันหมดอายุเดิม เปลี่ยนอายุได้เมื่อผู้ใช้เลือกเอง
- P2 OCR: polling ใบเสร็จลองอ่านงานเดิมซ้ำหลัง network/server error โดยไม่เริ่ม OCR ใหม่ และหยุดเมื่อถูกปฏิเสธสิทธิ์
- Validation (Windows, ข้อมูลสังเคราะห์, ไม่มีการเรียก AI/Google จริง): `tsc --noEmit` ผ่าน, build ผ่าน,
  unit/API/PWA 62/62 (ใหม่ 17 รวม worker-revocation), PostgreSQL/PGlite 29/29, Playwright desktop/mobile 56/56
  `prettier --check` ยังรายงาน 57 ไฟล์จาก CRLF ใน checkout นี้ (ไฟล์ที่ไม่ได้แตะก็ติด) ไม่ใช่ปัญหาเนื้อหา
- Deploy 2026-10-25: operator deploy `api` และ `worker` จาก main `e381eb8` ด้วย
  `supabase functions deploy … --no-verify-jwt --use-api --import-map supabase/functions/deno.json`
  ตอนนี้ทั้งสองเป็น v19 ACTIVE (`verify_jwt=false` ตามเดิม) `google-callback` ยัง v14 เพราะไม่ได้แก้
  ครั้งแรกที่ไม่ใส่ `--import-map` bundle ล้มเหลวที่ `zod` และไม่มีการเปลี่ยนเวอร์ชัน
  v19 รวม Gemini busy retry/`AI_BUSY` จากรอบก่อนด้วย ตรวจเฉพาะรายการฟังก์ชัน/เวอร์ชัน/สถานะ
  ไม่ได้เทียบ source ที่ deploy และไม่ได้เรียก API จริง
- ยังไม่ทำ: real-account acceptance (Google, Gemini, การ revoke ระหว่างงานจริง) และเทียบ source ที่ deploy

## 2026-10-24 · Audit เทียบ Desktop 0.6.20

- ตรวจ Webapp `a5a99d2` เทียบ Desktop `90ee71c` (main/tag `desktop-v0.6.20` ที่ตรวจจาก GitHub)
  หน้าตา โปรไฟล์ แบบฟอร์ม Skill และการเตรียม Prompt ใกล้เคียง แต่ editor/Office/history,
  tool loop, personal Skills, learning และ recurring schedules ยังไม่เทียบเท่า
  ดู [รายงาน audit](desktop-parity-audit-2026-10-24.md) สำหรับหลักฐานและข้อจำกัด
- ทำซ้ำได้ด้วยข้อมูลสังเคราะห์: P1 worker ส่งบริบทหลัง revoke/cancel ระหว่างรอ Drive;
  P2 ร่างหายเมื่อเปลี่ยนหน้า, response บันทึกช้าดึงกลับงานเก่า, แก้ความจำหมดอายุเป็นไม่หมดอายุ
  และ OCR เลิก polling หลัง network error ครั้งเดียว รายงานนี้ยังไม่ได้แก้ runtime findings เหล่านี้
- แก้ข้อความ reference ที่ยังบอกว่าไม่มี TTL UI/โปรไฟล์ และค่า sandbox output limit เป็น 2048
  ไม่เปลี่ยนพฤติกรรมแอปหรือ checkout Desktop
- ตรวจ hosted แบบอ่านอย่างเดียว: migration ครบ 13 รุ่นรวม member_profiles; API/worker ACTIVE v18
  และ callback v14; deployed source โปรไฟล์ตรงกับ checkout แต่ Gemini busy retry/AI_BUSY ยังไม่ deployed
  ไม่อ่านข้อมูลพนักงาน/เอกสาร/grants ไม่ deploy และไม่เรียก AI/Google จริง
- Validation: build ผ่าน, unit/API/PWA 45/45, PostgreSQL/PGlite 29/29 และ Chromium desktop/mobile
  36/36 ผ่าน TypeScript ผ่าน แต่ `npm run check` ติด CRLF และ ignored local settings;
  reference check ติด CRLF เช่นกัน ตรวจ Git-blob SHA-256 แล้วตรงกับ inventory ครบ 91/91
  ตรวจ `npm run check` และ reference แบบไม่ระบุ source ใน clean LF worktree แล้วผ่าน
  ผลเหล่านี้ไม่ยืนยัน real-account/deployment acceptance หรือการแก้ findings

## 2026-10-24 · Gemini busy responses

- Observed on the hosted pilot: two chat runs (13:46 and 13:56 UTC) failed with `AI_SERVICE_ERROR` within
  four seconds, with no document attached; the same short request succeeded a minute later. The worker
  did not record Google's status, so the cause could not be confirmed; a temporary overload (503) of the
  free-tier model fits the pattern.
- Gemini failures now log only the step and HTTP status (never prompt, answer or key). 503 UNAVAILABLE,
  which Google returns when it did not process the request, is retried once after 1.5 s; other failures
  are not retried. 5xx responses that remain are reported as `AI_BUSY` (บริการ AI ไม่ว่างชั่วคราว,
  send again later) instead of the admin-facing service error; countTokens 401/403 now report
  `AI_NOT_CONFIGURED` like generation does.
- A failed run still keeps its reservation in the monthly budget, as before (7 cents at 75/375).
- Validation under Node 25.2.1: TypeScript, build, 45 unit/API/PWA tests (new: retry, busy, logging and
  status mapping), 29 PostgreSQL tests and 36 Playwright tests. Requires redeploying the worker (and the
  API for the shared code); not yet done.

## 2026-10-24 · Gemini free-tier trial enabled

- Merged #14 and deployed API/worker from main `b9d5f6b` (CLI 2.122.0, `--use-api`, shared import map,
  `verify_jwt` false); rebuilt the homelab frontend from the same commit. Rollback image:
  `step-ai-webapp:pilot-408604d`.
- The operator created a Google AI Studio key in a project without billing and set `GEMINI_API_KEY` from
  their own terminal; the key never passed through the agent session. Server settings now select
  `AI_PROVIDER=gemini`, `GEMINI_TIER=free` and `GEMINI_MODEL=gemini-3.6-flash` (a stable model the
  pricing page lists as free of charge). Values were checked by their SHA-256 digests only.
- Settings were switched only after the disclosure build was live, so every consent screen names the
  free AI Studio tier and says Google may use what is sent; use synthetic or non-confidential material.
- Smoke: API 401 for the homelab origin, 403 for a foreign origin, worker 403 without its secret; hosting
  smoke passed and the served bundle contains the free-tier notice.
- Not yet accepted: the tenant budget/rates (set by the owner in Settings), a real chat answer, receipt
  OCR and document indexing. Embedding free-tier availability for `gemini-embedding-2` is unconfirmed.

## 2026-10-24 · Production rollout of #12 (profile, assistant and answer style)

- Merged #12 after CI passed. Before changing anything, hosted migrations matched the 12 in the repo and
  the deployed API source matched main file-for-file (only the type-only `contracts.ts` differs).
- Applied `20261023120000_member_profiles` through the Supabase connector because the CLI had no
  database password in this session; the history row was then renamed from the connector's timestamp
  to `20261023120000` so `supabase migration list` matches the repo. Verified on the hosted database:
  RLS on with read/insert/update policies, no `anon` grants, authenticated updates limited to the
  data columns (not `tenant_id`/`user_id`), memory kinds include `project`, 0 profile rows. The
  security advisor raised nothing for the new table.
- Deployed API and worker version 14 from main `408604d` with Supabase CLI 2.122.0 (`--use-api`,
  shared import map, `verify_jwt` false). google-callback was unchanged and not redeployed. Smoke: API
  401 for the homelab origin, 403 for a foreign origin, worker 403 without its secret.
- Rebuilt the homelab frontend from the same commit; it is healthy and hosting smoke passed over HTTPS.
  The previous image is tagged `step-ai-webapp:pilot-a78b769` for rollback. The synthetic demo saves a
  profile and shows it in the sidebar on the live origin.
- Not yet accepted: saving a profile with a real Google account and a real AI answer using the chosen
  style.

## 2026-10-24 · Profile, assistant, answer style and memory types from Desktop

- Settings opens on โปรไฟล์และผู้ช่วย, as Desktop's ทั่วไป: the 56 Desktop avatar drawings (53 offered),
  the name to be called, main team, assistant name, chat language, the four personality presets,
  คมคาย (Witty) and ชวนคิด (Ob-Oon), and the ภาษาเหนือ language style, with Desktop's prepared
  examples (no AI call). The sidebar shows the avatar, name and "ผู้ช่วย … · ทีม …"; the greeting,
  starters and answer labels use the chosen name, team and assistant.
- Preferences are stored per employee and tenant in `member_profiles` (migration
  `20261023120000`). RLS lets only the employee read or change their own row; tenant admins cannot,
  ownership columns are not updatable, and values are bounded in SQL and the API. Names and the custom
  tone pass the same credential checks as messages.
- The worker appends the run owner's preferences after `SYSTEM_RULES`, opening with a line that ranks
  them below organization rules, sources, authority, approvals and privacy. Speaking-style text is
  Desktop's verbatim. The consent preview lists "ชื่อเรียก ทีม และสไตล์การตอบที่คุณตั้งไว้" when a
  profile exists; nothing else about the employee is added to the request.
- Memories gain Desktop's types (adds บริบทโครงการ), a lifetime in days, their origin (พิมพ์เอง/จากแชต)
  and Desktop's guidance. The consent preview now leaves out expired memories, matching the worker.
- Validation under Node 25.2.1: TypeScript, build, 41 unit/API/PWA tests, 29 PostgreSQL tests (new
  owner-only profile and memory-type checks) and 36 desktop/mobile Playwright tests passed; axe is clean
  on 40 page/theme/viewport combinations. No live AI or Google call was made.
- Requires before it works on the homelab: applying the migration to the hosted project and redeploying
  the API and worker (the frontend alone shows Settings but cannot save). Not yet done.
- Not carried over: Desktop's installed output styles, importance, AI-proposed memories, the lessons box,
  English UI and voice.

## 2026-10-23 · Homelab rollout of #10 (Desktop-parity interface)

- Merged #10 after CI passed. The second CI run followed a fix for a theme-switch contrast flicker
  (button backgrounds no longer animate between themes); CI's first run had caught it at 3.67:1.
- The homelab frontend was rebuilt from main `a78b769` (source copied with `git archive`) and is
  healthy behind Tailscale Serve at the same tailnet origin. The previous image is tagged
  `step-ai-webapp:pilot-8cd4a23` for rollback; earlier source trees were kept, not deleted.
- Hosting smoke passed over HTTPS (static shell, OAuth callback, PWA cache headers, CSP, missing
  assets). The served bundle contains the new interface, and the synthetic demo renders without page
  errors. No Supabase function, migration or secret changed; the contract edit is type-only.
- Not yet accepted: the new interface with a real Google account, Gemini, receipt OCR and the
  OpenRouter sandbox after this rollout.

## 2026-10-23 · Desktop-parity interface and audit fixes

- The web shell now follows Desktop 0.6.20 (`90ee71c`) DESIGN.md: Desktop's theme tokens verbatim,
  a 40px title bar (STeP menu with theme, sidebar toggle, workspace switcher, command bar), a 246px
  sidebar (symbol and MAKE INNOVATION SIMPLE, เริ่มงานใหม่, search, งานทั้งหมด/มีผลงาน, tasks grouped
  by date, folding เครื่องมือ, การตั้งค่า, profile), a folded icon rail, page headers and a status bar.
- Chat matches Desktop: greeting and two-line promise with illustration, team starters that fill the
  composer, and a composer on the home screen. Sending there creates a private task and opens the
  existing consent preview; no AI call happens before consent. Workspace-shared tasks still start from
  เริ่มงานใหม่. The draft opens as a right-hand ผลงาน pane with save and Word/text export.
- Receipt review uses Desktop's layout (original on the left, review sections on the right) and keeps
  the ทดลอง status. Pages lose their eyebrow labels; the command palette also searches tasks.
- Desktop's hand-drawn illustrations are reused in empty and waiting states, cropped to WebP with the
  source and licence note in `web/src/assets/illustrations/README.md`. Sidebar rail icons use Desktop's
  lucide-animated set (MIT, `motion` 14.1.0) plus brain, folder-open and history from upstream; every
  other icon plays Desktop's short hover/focus movement. Both stop under reduced motion.
- Audit fixes: dark-mode contrast for selected tasks, avatars, success/found/missing states, notices and
  the sign-in screen (lowest measured 5.6:1); `aria-current` on navigation and tab semantics on filters;
  44px touch targets on coarse pointers; a 12px floor for Thai text; an in-app update dialog instead of
  `window.confirm`; a keyboard-reachable receipt preview; tool pages load on first open (main bundle
  188 → 147 KB gzip).
- Validation under Node 25.2.1: TypeScript, build, 38 unit/API/PWA and 27 PostgreSQL tests, and 32
  desktop/mobile Playwright tests passed, including a new dark-theme state check. axe (WCAG 2.2 AA and
  best practice) is clean on 40 page/theme/viewport combinations. `prettier --check` reports only CRLF
  line endings in this Windows checkout; content formatting passes with `--end-of-line auto`.
- An independent design review against the Desktop screenshots ran two rounds; its fixes (draft-pane
  sources, Desktop's grey disabled send, drawer scroll, touch hints, menu and Skill copy) are applied.
  `web/PRODUCT.md` and `web/DESIGN.md` record the product and the inherited Desktop design.
- Not done here: no deployment, no real-account check. Desktop-only surfaces (tabs for เว็บ/งานเบื้องหลัง,
  model picker, งานตั้งเวลา, avatar pictures) are not imitated because the web has no such capability.

## 2026-10-23 · Function and homelab rollout of #7/#8

- Merged #7 and #8. API and worker were deployed from main `8cd4a23` with Supabase
  CLI 2.122.0 (`--use-api`, shared import map); both are ACTIVE with `verify_jwt`
  false. Deployed source matches main file-for-file except the type-only
  `contracts.ts`. google-callback was unchanged and not redeployed.
- The first CLI attempt without `--import-map` failed server-side bundling on `zod`
  and changed nothing; the deployment guide now passes the import map.
- The deployment guide named the Picker project-number secret `GOOGLE_PICKER_APP_ID`, but the API
  reads `GOOGLE_PROJECT_NUMBER`; the guide now uses the code's name. If the secret was set under the
  old name, the operator must add it as `GOOGLE_PROJECT_NUMBER` before Picker can work.
- Runtime smoke: API 401 for the homelab origin, 403 for a foreign origin, worker 403
  without its secret; function logs show clean boots.
- The homelab frontend was rebuilt from the same commit and is healthy; hosting smoke
  passed and the served bundle contains `AI_EMPTY_REPLY`. The previous image is kept as
  `step-ai-webapp:pilot-5f7d059` for rollback.
- Not yet accepted: a successful OpenRouter sandbox/chat reply after this deployment,
  Workspace connection, Gemini, worker dispatch through Vault and member denial.

## 2026-10-23 · Homelab origin, first owner and OpenRouter empty replies

- The frontend from main `5f7d059` runs on the homelab (Ubuntu 24.04) as a healthy,
  loopback-only container. Tailscale Serve publishes it inside the tailnet at
  `https://homelab.tail17add1.ts.net:8443`; hosting smoke passed over that origin.
  No public ingress or Funnel was created. Docker requires sudo on that host.
- Auth Site URL/redirect, Google login, disabled email/anonymous sign-in and the
  `APP_ORIGIN` secret were configured by the operator. The API returned 401 for the
  homelab origin and 403 `ORIGIN_DENIED` for a foreign origin. The first verified
  Google sign-in claimed the reserved owner membership; Auth holds only that account.
- Workspace OAuth, Picker and credential-encryption secrets were set by the operator;
  Workspace connection, Gemini, worker dispatch and a member denial test are not yet
  accepted. AI budget remains zero.
- The administrator OpenRouter sandbox reached the provider. One attempt received an
  upstream 429; another spent its 512-token output budget on reasoning and returned no
  text (522 tokens, $0 in OpenRouter Activity), surfacing as `OPENROUTER_RESPONSE_INVALID`.
  The sandbox now requests low, unreturned reasoning with 2048 output tokens, and both
  the sandbox and worker report empty text as `AI_EMPTY_REPLY`. The worker keeps
  `require_parameters` and does not send reasoning options, so non-reasoning pinned
  upstreams remain eligible. Requires API/worker redeployment.
- Validation: TypeScript, formatting, build, 38 unit/API/PWA and 27 PostgreSQL tests
  passed with synthetic provider responses under Node 25.2.1. No live AI call was made
  by tests; Playwright was not rerun because only an error catalogue entry changed.

## 2026-10-23 · Expanded Harness pack import

- Hosted migrations match all 12 local versions. API/worker version 5 are ACTIVE and
  their deployed source matches main after PR #6 (only the type-only `contracts.ts`
  is stripped by bundling); google-callback version 4 is unchanged since that rollout.
- Exported the reviewed baseline from a clean clone at
  `90ee71ca667c63284afe4996eddc7e8095b9a059`: 106 sources / 48 Skills. The upstream
  verifier passed original retrieval 61/61 and buyer identity 3/3. The operator imported
  it into the STeP tenant; hosted SQL confirmed 106 sources and 48 Skills at that version.
  The pack stayed in ignored `.exports/`; no source bodies entered Git.
- The import secret check rejected the pack because `sk` without a separator matched
  `skill-authoring-standard`. Key prefixes now require `sk-`/`sk_`, `ghp_` or
  `github_pat_`, matching the exporter. Synthetic tests keep real key shapes rejected.
  The deployed API/worker still use the earlier pattern for memory/prompt checks and
  need redeployment after merge.
- Export now normalizes Windows path separators, so `.exports/` output works there.
- Validation: TypeScript, formatting (line endings normalized for a CRLF checkout),
  production build, 38 unit/API/PWA and 27 PostgreSQL (PGlite) tests passed under
  Node 25.2.1, outside the declared engine range. Playwright was not run; no UI changed.
  No live AI, Google call, homelab installation or function deployment was performed.

## 2026-10-23 · Protected routes reconciled with Desktop workflows

- Merged the Desktop workflow pages into the protected-route branch. `web/src/routes.ts` is the
  single page list; `/document-tools`, `/media`, `/history` and `/help` now reload, follow browser
  history, redirect anonymous visitors to login and survive the Google sign-in return allowlist.
- Validation: TypeScript/Prettier, 41 unit/API/PWA tests, 27 PostgreSQL (PGlite) tests, production
  build and 44 of 46 desktop/mobile Chromium checks passed, including all 16 Auth checks covering
  the ten page URLs. The two Word download checks also fail on unchanged `main` in the cloud
  container (Chromium 141 reports the file name as `download`); GitHub CI remains authoritative.
- Hosted Auth settings, Google OAuth credentials and real-account acceptance remain pending, as below.

## 2026-10-23 · Desktop workflows and complete product reference

- Audited Desktop 0.6.20 at `90ee71ca667c63284afe4996eddc7e8095b9a059`.
  Added a searchable Thai reference covering 32 feature groups and all 91 top-level
  renderer modules, with pinned source links and a SHA-256 inventory. Statuses
  distinguish web support, partial support and capabilities still requiring Desktop.
- Added the original five document profiles/variants, team starters, internal-media
  Prompt compiler, Thai dates and Word presentation presets. Forms prepare private
  drafts/conversations and still require the existing per-request AI consent.
  Media preparation is local; no image-generation API or external publication is added.
- Added Skill search/team filters/details, source gaps and command search, title/body/draft
  history search under user RLS, theme selection before first paint, original symbol
  artwork, CI colours and a collapsible desktop rail. Word supports Markdown headings,
  bullets/tables, three A4 presets and page numbers; native rich editing/font embedding
  and institutional-template acceptance remain separate.
- Extended private Harness export with 66 non-executable Skill-local references,
  templates and examples: 106 sources / 48 Skills in the reviewed baseline pack.
  Paths/symlinks, restricted registry entries, size and credential checks remain enforced.
  Worker retrieval and the upstream verifier exclude working references from organization
  knowledge. Mandatory sources remain complete or stop on context limits; missing
  originals remain explicit gaps. No source bodies or staff records enter public Git.
- Validation: type/format and production build passed; 38 synthetic unit/API/PWA,
  27 PostgreSQL (PGlite) and 30 desktop/mobile browser tests passed. Browser checks
  include Word XML/layout, local media preparation, consent, history, Skill details,
  responsive layout and WCAG A/AA in both themes. Original private retrieval 61/61
  and buyer identity 3/3 passed; all 91 upstream module hashes were verified.
- The production Docker image built with TLS verification and the environment proxy/CA.
  Its dedicated local container is healthy, non-root (`101:101`) and read-only;
  static hosting/CSP/PWA/OAuth callback smoke passed. GitHub Actions run 39875584009
  passed on the reviewed implementation head. These are local/CI checks, not homelab
  or live provider acceptance.
- A later CI accessibility check caught an intermediate theme frame with yellow
  text over a transitioning light background. Button ink/background now switch
  together; only the border transition remains. Immediate theme checks are retained
  without sleeps, disabled contrast rules or automatic test retries.
- Main's existing homelab/backend changes (#4/#5) are integrated. Matching API/worker
  deployment and operator import of the expanded private pack are still required for
  the new routes/context. The hosted project remains on the previously recorded
  function/pack versions; no live inference, Google write, paid usage, source import
  or real homelab installation was performed for this change.
- The complete capability reference records remaining work: personal Skill approval,
  recurring user schedules, Tasks/Gmail writes, learning/maintenance, rich/native Office,
  browser/Vault/MCP/process tools, voice and image generation. No placeholder action
  claims these have been ported. See [Desktop details](desktop-reference.md).

## 2026-10-22 · Homelab pilot preparation

- Added a reproducible multi-stage Docker build and Compose service for the static
  frontend, with pinned Node/nginx image digests. Only a hosted Supabase URL and
  modern publishable key are accepted as browser configuration. Operator files,
  source credentials and local environment files are excluded from the build context.
- Runtime is a non-root nginx process on a read-only filesystem, with a loopback-only
  host port, bounded resources, PWA cache headers, security headers, SPA/OAuth callback
  routing and a health check. Supabase remains the backend; no database is self-hosted.
- Added Thai setup/rollback instructions for Tailscale Serve over a dedicated HTTPS
  port, plus a hosting smoke checker. The current pilot uses Tailscale; no Cloudflare
  DNS, Tunnel, Access policies or public ingress were created.
- Validation: type/format checks, 24 unit/API/PWA tests, 21 PostgreSQL tests, the
  production build and 16 desktop/mobile browser checks passed. The Docker image
  built and ran healthy; hosting checks verified callback fallback, cache/CSP headers
  and missing-asset handling. Its runtime contains no server credentials or build CA.
- The target homelab is not installed yet: this execution environment has
  `vpn_configured: false` and no TCP grants. SSH installation and testing from an
  actual tailnet device require that network connection first. No live AI was called.
- After combining the frontend consent update from PR #5, the production Docker
  image was rebuilt and ran healthy. Hosting smoke plus four desktop/mobile admin
  trial/accessibility checks passed. The download bundle contains the combined
  source and public Supabase configuration; the real homelab is still not installed.
- Supabase backend reconciliation is tracked in PR #5. The sandbox/shared-quota
  migrations are installed and API/worker/callback are now version 4. SQL verified
  service-only configuration/reservation RPCs, sandbox RLS, zero paid budget and
  disabled worker trial. Merge that frontend consent update before installing this
  checkout; the prepared bundle combines both PRs. The actual HTTPS origin,
  replacement trial credentials and live Google/AI acceptance are still pending.

## 2026-10-22 · Administrator OpenRouter free trial

- Added Settings → เชื่อมต่อ AI → ทดลอง OpenRouter Free for active tenant owners/admins.
  The separate channel accepts only explicitly consented synthetic text, without
  organization documents, memory, chat history or Google Workspace context.
- Server-only credentials and a single configured tenant gate access. Every call
  checks the live catalog for a zero-priced `:free` text model and sets zero price
  ceilings with provider fallbacks disabled. No paid AI budget or purchase is enabled.
- Service-only SQL reservations enforce idempotency and shared limits of 5 attempts
  per minute / 40 per UTC day, including failed attempts. Prompts/replies are temporary
  UI state; only reservation IDs/timestamps are persisted. Provider errors are sanitized.
- Validation: type/format checks and production build passed; 24 synthetic unit/API/PWA
  tests, 21 PostgreSQL isolation/accounting tests and 16 desktop/mobile Playwright tests
  passed, including consent reset, temporary result clearing and accessibility.
- Not activated in production: this environment has no Supabase credentials and its
  outbound policy does not permit OpenRouter. No transcript key was installed or
  committed and no live inference was attempted. Activation requires applying the new
  migration, deploying the API/frontend, setting a replacement `OPENROUTER_API_KEY`
  with `OPENROUTER_TRIAL_TENANT_ID`, then real-account authorization and $0 billing
  acceptance. Existing hosting/Google rollout requirements below remain applicable.

## 2026-10-22 · Supabase Auth and protected routes

- Added a public `/login`, PKCE callback handling, and stable URLs for all six workspace screens.
  Anonymous deep links preserve an allowlisted destination through Google sign-in; reload and
  browser back/forward follow the URL. The synthetic preview remains a separate Host.
- Auth.getUser validates restored and refreshed identities before loading workspace data.
  Account changes and sign-out clear private state; API 401 returns to login. Existing Google
  identity, invitation, tenant, resource and Storage authorization remain enforced server-side.
- A single-use callback exchange is shared across React StrictMode initialization effects.
  Failed/missing callback codes produce sanitized login errors without exposing provider details.
- Added configured-Auth browser checks with synthetic responses alongside the existing preview
  checks, plus unit coverage for redirect allowlists, token verification and callback replay.
- Local verification against main including OpenRouter: TypeScript/Prettier, 27 unit/API/PWA tests,
  21 PostgreSQL isolation tests, production build, and all 32 Chromium desktop/mobile checks passed.
  Chromium was installed
  after an initial missing-browser failure. No real Google identity was used in these checks.
- Read-only query of the existing hosted project confirmed all 16 public tables have RLS enabled.
  No hosted Auth settings, database schema, staff records or production deployment changed.
- Google OAuth credentials, a real Pages origin and real-account acceptance remain required.
  The Supabase connector has no Auth configuration update tool; the browser Dashboard requires
  sign-in. Follow [auth-setup.md](auth-setup.md) to complete the controlled setup in the Dashboard.

## 2026-10-22 · Supabase backend reconciliation

- Recovered the existing provider/Vault migrations and version-3 function behavior
  into source while retaining the administrator-only, temporary Settings sandbox.
  Worker chat remains a separate opt-in channel; paid budgets are unchanged.
- Added shared account admission for both OpenRouter paths: 40 attempts/day UTC
  and 15/minute, including failed/cancelled/purged jobs. The sandbox also retains
  its 5/minute tenant limit. Admission locks precede tenant locks for free jobs.
- Added the sandbox tenant restriction to the service-only Vault allowlist.
  Environment values take precedence; configuration failures return a sanitized 503.
  Browser confirmations bind provider/model/upstream consent, and the API/worker
  reject stale consent before sending context. Text-only mode disables OCR/indexing.
- Validation: type/format and production build passed; 31 unit/API/PWA, 26 real
  PostgreSQL (PGlite) and 16 desktop/mobile browser/accessibility checks passed.
  Vault tests use synthetic rows; multi-connection contention, actual OAuth and
  provider billing still require live acceptance. No live AI was called.
- The combined PR #4/#5 frontend built and ran as a healthy non-root, read-only
  Docker container. Hosting smoke and four desktop/mobile sandbox/accessibility
  checks passed against that production image. The operator bundle was refreshed
  with matching frontend source and public configuration only.
- Applied the sandbox and shared-quota migrations in the hosted project as
  `20261022164853` and `20261022164909`; local filenames match all 12 remote versions.
  The earlier sandbox migration had not been deployed and was renamed to its
  assigned version without rewriting remote history. API/worker/callback version 4
  are ACTIVE, with the sandbox route and provider consent verified in deployed source.
- Hosted SQL confirmed the service-only RPC ACLs, sandbox RLS, shared quota/Vault
  allowlist definitions, no public table without RLS, zero paid budget and disabled
  worker trial. Security advisors show only the documented 12 intentional RPC WARNs
  and four policy-free private-table INFOs. No server key was printed or installed.
- Direct HTTP smoke could not reach the hosted function URLs with the available
  network tools; deployment/source checks do not establish runtime or login acceptance.
  Homelab SSH, the real HTTPS origin, replacement trial credentials and real-account
  trial acceptance remain pending. The sandbox tenant restriction is unset in Vault.

## 2026-10-22 · Centralized PWA implementation

- Source baseline: STeP-AI-Harness `90ee71ca667c63284afe4996eddc7e8095b9a059`, Desktop 0.6.20.
- Separate repository: `iisara555/STeP-AI-Webapp`. Original Desktop repository is unchanged.
- Target: invited Google accounts, STeP tenant first, private workspaces with explicit sharing,
  owner-only memory/documents, centrally managed Gemini, Google Workspace and cloud receipt OCR.
- Public code includes no organization documents, employee records or API secrets.

### Implemented

- Invited, verified Google identities; service-only first-owner reservation and tenant bootstrap.
- SQL-enforced tenant/resource/Storage isolation; private workspaces and editor/viewer sharing.
- Personal and shared memory with confirmation, deletion, expiry and context limits.
- Authorized chat, source preview, consent, durable jobs, cancellation, drafts and Word/text export.
- Original Thai knowledge retrieval and authority factory adapted to per-tenant inputs.
- Central server-only Gemini, selected Drive text and read-only Calendar in private conversations.
- Private uploads, Office/PDF text extraction, bounded embedding indexing and explicit OCR.
- Receipt originals plus image derivatives, signature/buyer checks and separate human reviews.
- Installable shell, public-assets-only service-worker cache, mobile layout and accessible controls.
- Budget reservations/idempotency/leases, aggregate usage and deletion-safe accounting.
- Operator export/import/bootstrap tools, CI and a manually configured Pages deployment workflow.

### Verification

- TypeScript, formatting and production build passed; production dependency audit found no vulnerabilities.
- Unit/API/PWA checks: 19/19 passed, using synthetic provider responses and no live model calls.
- Real PostgreSQL (PGlite + pgvector) checks: 18/18 passed. Tests emulate permissive Supabase
  function defaults and synthetic Auth/Storage tables, including cross-tenant/private/admin isolation,
  worker RPC denial, shared-context scope, reservation accounting, cancellation/revocation, draft
  conflicts, owner bootstrap, receipt review and deletion. Full local Supabase stack was unavailable
  because its container registry was blocked; these do not replace real Auth/Storage acceptance.
- Chromium desktop/mobile checks: 14/14 passed, including consent, memory/document flows,
  receipt image preparation and saved edits, Word ZIP/content validation and WCAG A/AA checks.
  Browser tests use the explicitly labeled synthetic preview, not live Google or Gemini.
- Private upstream corpus: original retrieval/abstention 61/61 plus buyer identity 3/3 passed.
  Corpus/source files stayed outside Git; this does not measure generated-answer accuracy.

### Cloud state

- Dedicated Supabase project `zwwchjshmxdzhhotacte`, Singapore, provisioned after a $0/month quote.
  Existing Jorde project and Desktop repository were not changed.
- Eight schema migrations applied; local versions aligned with remote history. Vector, pg_net,
  Vault and cron verified installed; scheduler jobs registered but dispatch remains inert until
  its worker URL/secret are configured in Vault.
- STeP tenant created, requested owner reserved until verified Google login, AI budget zero.
- Baseline pack imported privately: 38 registered documents, two governance registries and 48 Skills.
  Staff titles reuse Desktop labels; developer-only/native-browser Skills are hidden from the web hub.
- API, worker and Google callback functions deployed. Live unauthenticated API smoke returned 401;
  worker returned 503 without configured credentials, before claiming work or calling AI.
- No public data table lacks RLS. Service worker/grant/import/bootstrap RPCs deny anonymous and
  ordinary authenticated execution. The intentional SECURITY DEFINER and private-table advisories
  are documented in operations.md. Permissive hosted function defaults were found and corrected.

### Required before staff rollout

- Create/connect the STeP Cloudflare Pages account/project and obtain its actual default URL.
- Configure Supabase Google login and Workspace web OAuth, real callback origins and Picker.
- Set server Gemini/worker/encryption credentials, Vault dispatch entries and reviewed token rates.
  No Gemini key from the conversation is embedded or enabled by this implementation.
- Verify real Google accounts and selected-file permissions; measure OCR on permitted labeled receipts;
  confirm generated Word files in the organization's editor; complete offsite backup/restore acceptance.
- Automated capacity alarms/database-size admission, binary Drive export and automated Desktop
  personal-history migration remain follow-up work; native execution stays in Desktop.
