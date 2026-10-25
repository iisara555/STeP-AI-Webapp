# ADR 0001 · เว็บเป็นตัวกลาง งานจริงรันบน engine เดียวกับ Desktop บน server ขององค์กร

- สถานะ: ยอมรับแล้ว (accepted) 2026-10-25
- ผู้ตัดสิน: เจ้าของโครงการ (Itsara) จากการทบทวนเอกสารพัฒนาร่วมกับ coding agent
- แทนที่: ไม่มี ADR ก่อนหน้า ส่วน "Centralized STeP PWA" ใน [architecture.md](../architecture.md)
  ยังอธิบายระบบ pilot ปัจจุบันถูกต้อง แต่ไม่ใช่ปลายทางอีกต่อไป

## บริบท

Webapp ปัจจุบัน (React PWA + Supabase Auth/Postgres/Storage/Edge Functions) เขียน logic ฝั่ง server ใหม่
แยกจาก Desktop จึงต้องไล่ทำ parity ทีละส่วน audit 2026-10-24 จัด 32 หมวดเป็น `web` 8, `partial` 17,
`planned` 3 และ `desktop` 4 และพบ findings ที่เกิดจากการเขียนซ้ำ (ร่าง ความจำ OCR และ worker)

สำรวจ STeP-AI-Harness `90ee71c` (Desktop 0.6.20) แล้วพบว่า `desktop/electron/` มีไฟล์ TypeScript
ที่ไม่ใช่ test 128 ไฟล์ ประมาณ 28k บรรทัด มีเพียง 8 ไฟล์ที่ import `electron`
(`main`, `preload`, `splash`, `browser-agent`, `browser-dock`, `html-preview`, `pdf-pages`,
`receipt-image-input`) ส่วนแกนกลาง เช่น `service.ts`, `tool-loop.ts`, `policy.ts`, `permissions.ts`,
`providers.ts`, `memory.ts` และ `knowledge.ts` ใช้แค่ Node แต่ `Store` เป็น `node:sqlite` ไฟล์เดียว
ต่อเครื่อง ไม่มีแนวคิดผู้ใช้หรือ tenant

server ขององค์กรยังอยู่ระหว่างจัดหา ปลายทางคือ hardware ที่องค์กรซื้อเอง ไม่ใช่ cloud ของ Supabase หรือ GCP

## การตัดสินใจ

### ปลายทาง

1. **เว็บเป็นแค่หน้าจอและตัวกลาง** งานจริงรันบน **engine ของ Desktop** บน server ขององค์กร
   Desktop กับ server ใช้ engine ชุดเดียวกัน แทนการเขียน logic สองชุด
2. **ทุกส่วนของระบบ server อยู่ใน repo นี้** ได้แก่หน้าเว็บ, `server/` (gateway), router proxy และ
   Docker Compose engine เข้ามาเป็น **git submodule ของ STeP-AI-Harness ที่ล็อกไว้ที่ release tag
   `desktop-v*`** CI ต้องตรวจว่า submodule ชี้ไปที่ tag เท่านั้น ห้าม copy โค้ด engine เข้ามา
   การแก้ engine ทำผ่าน PR ใน Harness แล้วเลื่อน tag ที่นี่
3. **1 ผู้ใช้ = 1 engine process + SQLite ของตัวเอง** (`/data/users/<id>/workspace.sqlite`
   บนดิสก์ที่เข้ารหัส) process ที่ไม่ได้ใช้ปิดอัตโนมัติ ข้อมูลแยกกันระดับไฟล์และพฤติกรรมตรงกับ Desktop
   ถ้าวันหนึ่งผู้ใช้มากจนทรัพยากรไม่พอ ค่อยพิจารณา engine ร่วมบน PostgreSQL ใน ADR ใหม่
4. **gateway ทำเฉพาะงานระดับองค์กรที่ Desktop ไม่มี**: login Google เฉพาะโดเมนองค์กรและรายชื่อคนที่ได้รับเชิญ,
   ส่งคำขอไป engine ของผู้ใช้, เพดานการใช้ AI รายคน/รายเดือน, หน้า admin (เชิญ/ลบ/ยอดใช้) และ
   audit log ที่บันทึกแค่ใคร/อะไร/เมื่อไร ไม่เก็บเนื้อหา consent, policy, ความจำ และ Skill อยู่ใน engine
5. **เครื่องมือบน server กำหนดด้วย policy ของ engine ไม่ใช่แค่ซ่อนปุ่ม**
   - เปิด: ความรู้ STeP และ Skill, เอกสาร/ร่าง/export, ความจำ, Google (อ่าน และเขียนเมื่อผู้ใช้อนุมัติทีละครั้ง),
     ใบเสร็จ OCR, public web search
   - ปิด: browser agent, MCP, process/sandbox/code worker, ค้นไฟล์ในเครื่อง, Antigravity, Copilot
6. **รุ่นแรกไม่มี shared workspace** แชร์ผลงานผ่าน export Word หรือ Google Drive
   ระหว่าง pilot ให้นับว่ามีการใช้การแชร์จริงหรือไม่ เพื่อยืนยันการตัดสินใจนี้
7. **Desktop ทำงานแยกในเครื่องต่อไป ไม่ sync กับ server** งาน native และ provider ส่วนตัวใช้ Desktop
8. **hardware ขององค์กร**: Linux + Docker Compose, HTTPS reverse proxy, backup ทุกคืนไปไว้นอกเครื่อง
   ซื้อเครื่องที่พร้อมใส่ GPU (PSU/ช่อง/ระบายความร้อน) ก่อน แล้วซื้อ GPU ตามผล benchmark
   พนักงานเข้าใช้ผ่าน **Cloudflare Tunnel + Access** ตามนโยบาย IT (ทางสำรองคือ VPN องค์กร)
   gateway เป็น HTTP ธรรมดา ไม่ผูกกับช่องทางใดช่องทางหนึ่ง

### AI provider และ routing

9. engine เห็น provider ตัวเดียวคือ **router proxy แบบ OpenAI-compatible ใน repo นี้** proxy เป็นคนเลือกปลายทาง
   - ช่วงแรกส่งทุกงานไป API ที่เสียเงินและไม่เก็บข้อมูล เช่น OpenRouter รุ่นเสียเงินพร้อม
     `data_collection: deny` และ provider ที่ไม่เก็บข้อมูล (zero data retention)
   - เมื่อมี local LLM ใช้กฎตายตัว (rule-based) ก่อน: ถามตอบสั้นจากเอกสาร STeP, สรุป, จัดหมวด, แปล และขัดเกลา
     ทำที่ local ส่วนร่างหนังสือราชการ/TOR/โครงการ, context ยาวเกิน local, งานใช้เครื่องมือหลายขั้นตอน
     และงานที่ local ตอบไม่ผ่านเกณฑ์ ส่งต่อ API
   - ถ้า Privacy Gate พบข้อมูลส่วนบุคคล ให้อยู่ที่ local เสมอ หรือขอให้ผู้ใช้ยืนยันก่อนส่งออก
10. เลือก provider จริงด้วยเกณฑ์: ไม่ train ด้วยข้อมูลองค์กร, ตอบภาษาไทยจากเอกสาร STeP ได้ดี
    (ชุดคำถามพนักงาน 61 ข้อ) และค่าใช้จ่ายรายเดือน ตัวเลือก: Gemini API แบบเสียเงิน, Claude API, OpenRouter
    และ local LLM ต้องทดสอบ local LLM บน GPU ที่มีอยู่ก่อนยื่นข้อเสนอ hardware 2 ทางเลือก
    (A: ไม่มี GPU ใช้ API, B: มี GPU รัน local) พร้อมผล benchmark และราคา

### ระหว่างทาง

11. **ระบบ Supabase ปัจจุบันหยุดเพิ่ม feature (feature freeze) แก้เฉพาะ bug** และใช้ pilot กับ 3–5 คน
    ในทีมเดียวประมาณ 2 สัปดาห์ บน Gemini free tier เงื่อนไข: ใช้เฉพาะเอกสาร STeP ที่ไม่ลับ (ระเบียบ คู่มือ แบบฟอร์ม)
    ห้ามข้อมูลส่วนบุคคล เงินเดือน หรือสัญญา และต้องมีหนังสืออนุมัติจากหัวหน้าก่อนเปิด
12. engine server ช่วงพัฒนารันบน homelab ให้เจ้าของโครงการใช้คนเดียว พนักงานไม่ใช้จนกว่าจะอยู่บนเครื่ององค์กร
    ข้อมูลพนักงานจริงจึงไม่อยู่บนเครื่องส่วนตัว
13. **ย้ายข้อมูลด้วย script ครั้งเดียวต่อผู้ใช้**: อ่านจาก Supabase แล้วเขียนลง SQLite ตามรูปแบบ `Store` ของ Desktop
    ครอบคลุมบทสนทนา ร่าง ความจำ ใบเสร็จพร้อมไฟล์ต้นฉบับ และโปรไฟล์ แล้วตรวจนับรายการให้ตรงกันรายคน
    เอกสารองค์กรและ Skill import ใหม่จาก Harness ส่วน OAuth token ไม่ย้าย ผู้ใช้เชื่อม Google ใหม่
14. Google Cloud project สำหรับ OAuth/Picker อยู่ใต้ Workspace ขององค์กรแล้ว แต่เจ้าของโครงการเป็นพนักงาน
    ไม่มีสิทธิ์ admin ต้องให้กลุ่มผู้ดูแลขององค์กรเป็น Owner ก่อนเริ่ม pilot ระบบจะได้ไม่ผูกกับบัญชีคนเดียว

## ลำดับงาน

| ระยะ | ผู้ทำ           | งาน                                                                                                                         |
| ---- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | เจ้าของโครงการ  | ทดสอบถอนสิทธิ์ระหว่างงานด้วยบัญชีจริง, ให้ admin เป็น Owner ของ Google Cloud project, หนังสืออนุมัติ, เชิญทีม pilot         |
| 1    | agent           | ADR นี้ + `progress.md` + `AGENTS.md`                                                                                       |
| 2    | agent           | headless spike: submodule Harness ที่ `desktop-v0.6.20`, รัน `service.ts` ไม่มี Electron 1 ผู้ใช้บน homelab เกณฑ์ผ่าน 61/61 |
| 2′   | agent (คู่ขนาน) | benchmark local LLM บน RTX 4070 Super → ข้อเสนอ hardware A/B (ยื่นเร็วเพราะจัดซื้อใช้เวลานาน)                               |
| 3    | agent           | gateway (ข้อ 4) + server tool policy (ข้อ 5) + หน้าเว็บคุยกับ gateway                                                       |
| 4    | agent           | router proxy (ข้อ 9)                                                                                                        |
| 5    | ร่วมกัน         | script ย้ายข้อมูล (ข้อ 13) → เครื่ององค์กร + Cloudflare Tunnel                                                              |

## ผลที่ตามมา

- งานใหม่ใน `supabase/` และ feature ใหม่ในหน้าเว็บที่ผูกกับ Supabase หยุดไว้ ยกเว้น bug fix และสิ่งที่ pilot ต้องใช้
- การแชร์ workspace, ความจำร่วม และ consent/budget ฝั่ง Postgres ของระบบปัจจุบันจะไม่ย้ายไปเป็น feature ของ server
  รุ่นแรก ระบบปัจจุบันยังใช้ได้ตามเดิมจนกว่าจะย้าย
- กติกาเดิมที่ห้ามแตะ STeP-AI-Harness เปลี่ยนเป็น: Harness เข้ามาเป็น submodule ที่ล็อกไว้เท่านั้น
  การแก้ engine ทำใน Harness ตามกติกาของ repo นั้น
- ยังเปิดอยู่: ผล benchmark และ provider จริง, spec และงบ hardware, นโยบาย IT เรื่อง Cloudflare Tunnel และวันที่เครื่องมาถึง
