# รายละเอียด Desktop ที่ถ่ายทอดเข้า Webapp

อ้างอิง [STeP-AI-Harness Desktop 0.6.20](https://github.com/iisara555/STeP-AI-Harness/tree/90ee71ca667c63284afe4996eddc7e8095b9a059)
commit `90ee71ca667c63284afe4996eddc7e8095b9a059` ตรวจจากโค้ดหน้าจอ เอกสารนโยบาย และเครื่องมือของต้นทาง
ไม่แก้ checkout Desktop และไม่ย้ายข้อมูลส่วนตัวของพนักงานโดยอัตโนมัติ

## ขอบเขตความครบถ้วน

รายการอ้างอิงครอบคลุม **32 หมวด และโมดูลระดับบนใน `desktop/src` ทั้ง 91 ไฟล์**
รวมโครงสร้างข้อมูลและองค์ประกอบ UI ไม่รวมภาพ/อวตาร ไอคอนเคลื่อนไหว และไฟล์แปลที่เป็นทรัพยากรประกอบ
แต่ละไฟล์มี SHA-256 และหมวดเจ้าของใน [desktop-inventory.json](desktop-inventory.json)
รายละเอียดแบบอ่านในแอปอยู่ที่ **คู่มือและความสามารถ** และข้อมูลต้นฉบับที่แสดงมาจาก
[desktop-reference.ts](../packages/harness-core/src/desktop-reference.ts)
ซึ่งแยกข้อความอธิบาย Desktop สถานะเว็บ ข้อจำกัด และลิงก์ไฟล์ที่ commit เดียวกัน

นี่คือความครบถ้วนของรายการอ้างอิงและการถ่ายทอด workflow ที่ระบุด้านล่าง
ยังไม่ใช่ความเท่าเทียมของความสามารถทุกอย่างใน Electron
รายการที่ยังไม่เปิดบนเว็บแสดงตรงกันทั้งในแอปและเอกสาร ไม่ใช้ปุ่มจำลองว่าทำงานได้แล้ว

## ส่วนที่ใช้งานเพิ่มได้

| งาน                                                               | พฤติกรรมในเว็บ                                                                                  | หลักฐาน/ข้อจำกัด                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ร่าง TOR / บันทึกข้อความ / หนังสือราชการ / โครงการ / รายงานประชุม | ใช้ field, variant และการระบุ `USER_INPUT` จากโมดูลเดิม เตรียมร่างและคำขอในบทสนทนาส่วนตัว       | ยังไม่ส่ง AI จนผู้ใช้ตรวจบริบทและยืนยัน ช่องที่ขาดคงรอยืนยัน ใช้เอกสารแนบผ่านตัวเลือกเดิม                                                 |
| สื่อภายใน                                                         | ภาพประกอบ ประกาศ คู่มือ ความรู้ พร้อมสไตล์ สัดส่วน พื้นที่ข้อความ ฟอนต์ โครงวาง และ Prompt เดิม | สร้าง Prompt ในเครื่อง คัดลอก/ดาวน์โหลดได้เมื่อกรอกครบ การสร้างภาพผ่าน API ยังไม่เปิด                                                     |
| Skill                                                             | ค้นชื่อ/คำเรียก กรองทีม อ่านคำแนะนำ ขอบเขต แหล่งบังคับ ไฟล์ประกอบ เวอร์ชัน และข้อมูลที่ขาด      | Skill ที่ต้องใช้ native browser แสดงข้อจำกัดและใช้บนเว็บไม่ได้ Developer Skills ไม่แสดงใน staff hub                                       |
| คำขอตามทีม                                                        | เลือกทีมและคำขอเริ่มต้นจาก Desktop                                                              | เตรียมข้อความให้ตรวจ ไม่มีการส่ง AI อัตโนมัติ ไม่ใช้การเลือกทีมเป็นสิทธิ์เข้าถึงข้อมูล                                                    |
| ค้นงานเก่า                                                        | ค้นชื่อ ข้อความ และร่างด้วย user-scoped Data API                                                | ตรวจ tenant/สมาชิกและ RLS ทั้ง messages/sessions ไม่ส่งคำค้นไป AI แสดงสูงสุด 50 ผล บางกรณีที่ match ข้อความซ้ำจำนวนมากอาจได้ผลน้อยกว่า 50 |
| ร่าง/Word                                                         | แทรกหัวข้อ รายการ ตาราง ส่งออก Word ด้วย preset สารบรรณ/รายงาน/หนังสือ ขนาด A4 และเลขหน้า       | เป็นตัวแก้ไข Markdown ยังไม่ฝังฟอนต์ ตราครุฑ สารบัญ รูปภาพ หรือรักษา template Office เดิม                                                 |
| UI                                                                | สี CI #FFC709 / #231F20 สัญลักษณ์ต้นฉบับ ธีมระบบ/สว่าง/มืด ย่อแถบเมนู ค้นคำสั่ง                 | เก็บเฉพาะธีมใน localStorage ใช้ Ctrl/⌘+K, Ctrl/⌘+Alt+N, Ctrl/⌘+Shift+M และ Ctrl/⌘+,                                                       |
| คู่มือและปัญหา                                                    | ค้นทั้ง 32 หมวด ดูสถานะและต้นทาง ดาวน์โหลดแบบรายงานปัญหา                                        | ไม่ส่งรายงานหรือเนื้อหางานไป GitHub/บริการอื่นอัตโนมัติ                                                                                   |

## รายละเอียดที่คงเป็นงาน Desktop หรือยังต้องพัฒนา

| หมวด           | รายละเอียดต้นทางที่ต้องรักษาหากพัฒนาต่อ                                                                  | สถานะเว็บ                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Skill ส่วนตัว  | ตรวจ Skill v2/ความเสี่ยง ผู้สร้าง enable/disable ข้อเสนอให้องค์กรตรวจ                                    | operator import เท่านั้น ยังไม่มี personal pack UI/approval                                                  |
| ประวัติ        | ค้น attachment text, fork ที่ล้างสิทธิ์/consent/trace และ JSON export ที่ตัดข้อมูลบัญชี                  | ค้นชื่อ/ข้อความ/ร่าง และ Markdown export มีแล้ว ส่วนอื่นยังไม่เปิด                                           |
| Rich draft     | โครง rich text, nested lists, รูป/คำบรรยาย, template, review แยกจากตัวเอกสาร, versioned export           | รองรับ Markdown และแยกร่างจาก envelope เมื่อมี ยังไม่เทียบเท่า editor ของ Desktop                            |
| Google         | บัญชีแยกจาก login, scope/status, consent ต่อคำขอ, Calendar/Tasks/Gmail/Drive และผลเขียนที่ตรวจจริง       | Calendar read-only และ Drive ที่เลือกไว้เท่านั้น ห้ามอ้างว่าส่งเมลหรือสร้าง task ได้                         |
| Morning brief  | Calendar + Tasks พร้อมสิ่งที่ต้องทำในวันนี้และสถานะบริการ                                                | ถาม Calendar ในแชตได้ ยังไม่มีหน้า brief หรือ Tasks                                                          |
| ความจำ         | หลักฐานคำพูดผู้ใช้, importance, TTL, proposals, privacy, upkeep board                                    | ยืนยัน/แก้ไข/ลบ/เลือกใช้ความจำได้ ยังไม่มี UI TTL, autodream หรือ maintenance board                          |
| Learning       | Good/Needs fixing บทเรียนรอยืนยัน curator และตัวชี้วัด                                                   | ยังไม่เปิดวงจร learning                                                                                      |
| ตั้งเวลา       | เวลา/วันใน local timezone, cron UTC, บัญชีและบริบทที่ผูกไว้, revocation, missed/interrupted run          | มีคิวงานที่ผู้ใช้สั่ง ยังไม่มี recurring user schedules หรือ consent ให้ส่งบริบทตามรอบ                       |
| Tool loop      | แผน draft-only, bounded turns, trace ที่ไม่เก็บความลับ, permission/destination approval และถามก่อน write | ใช้ named API actions ไม่เปิด arbitrary tool execution                                                       |
| Browser/Vault  | รายการ host, ป้องกัน credential path, browser vision/extract, กรอกและ submit หลังยืนยัน                  | ต้องใช้ Desktop ไม่ย้ายรหัสผ่าน/credential ของเครื่องเข้าเว็บ                                                |
| MCP/Docker/dev | discovery และ execution consent แยกกัน, managed servers, sandbox isolation และ Git authority             | ต้องใช้ Desktop ไม่มี shell/local MCP/process/Docker ใน PWA                                                  |
| AI ส่วนตัว     | API/OAuth หลายค่าย, model/thinking, ทดสอบ capability จริง, developer-only subscription                   | เปลี่ยนเป็น AI ส่วนกลางฝั่งเซิร์ฟเวอร์ ไม่รับ transcript key หรือ Desktop OAuth grants                       |
| ภาพ/เสียง      | API สร้างภาพแยกจาก OAuth, vision consent/OCR และ voice ตาม capability จริง                               | OCR/receipt ผ่าน Gemini มีเงื่อนไข ยังไม่เปิดสร้าง/แก้ภาพ ภาพแชตทั่วไป หรือเสียง                             |
| ใบเสร็จ        | type/completeness/next steps, buyer, signature, provenance, purpose/category และผลเทียบต้นฉบับ           | ยังไม่มี AFP category/purpose handoff ครบ ตัวจำแนก 4 ประเภทในต้นทางยังเป็น prototype ไม่ใช่การรับรองเบิกจ่าย |
| บริบท          | ไม่ตัด standing/mandatory sources เงียบ, summary untrusted, task-state และ transcript เดิม               | คุม token/ค้นส่วนเกี่ยวข้อง ไม่ย่อประวัติด้วย AI/hook                                                        |
| โปรไฟล์/ภาษา   | persona/output styles, อวตาร, speaking style, UI ไทย/อังกฤษ และเงื่อนไข                                  | UI ไทย/ชื่อจาก Google ยังไม่ย้ายไฟล์ persona หรือทำฟีเจอร์ส่วนตัวเหล่านี้                                    |
| Install/update | Windows/macOS installer/native acceptance                                                                | PWA/แจ้งอัปเดต shell ต้องออนไลน์เพื่ออ่านข้อมูลงาน                                                           |

## ชุดความรู้และไฟล์ประกอบ Skill

ตัวส่งออกเดิมมี 38 เอกสาร + 2 governance registries และ 48 Skills แต่ยังไม่รวบรวมไฟล์ประกอบใน
`references/`, `templates/`, `examples/` ของแต่ละ Skill
ตัวส่งออกที่ปรับแล้วได้ **106 sources / 48 Skills** จาก baseline นี้ (66 ไฟล์ประกอบเพิ่ม)
ไฟล์ทั้งหมดอยู่เฉพาะ private pack ที่ ignored ไม่มี body ของเอกสารหรือชื่อพนักงานใน repository นี้

- อ่านเฉพาะ text allowlist ใต้ Skill ที่ลงทะเบียน ไม่รันสคริปต์ ไม่ตาม symlink ไม่ออกนอก canonical root
  และไม่ข้ามรายการ restricted/retired/withdrawn/not-provided ของ registry
- คง source commit, path, hash, owner, lifecycle, version, triggers, scope, mandatory/optional/support IDs
  และรายการ mandatory source ที่ยังไม่มีต้นฉบับ ไม่ตีความว่า lifecycle pilot คือการอนุมัติแล้ว
- Working examples/templates มี `provenance.kind=skill-support` แยกออกจาก organization retrieval
  ใช้เฉพาะ Skill ที่เลือก มีป้ายว่าเป็นแบบทำงาน ไม่ใช่ข้อกำหนดที่อนุมัติแล้ว และจำกัด excerpt
- แหล่งบังคับที่มีอยู่ส่งครบ ถ้าใหญ่เกินบริบทหยุดด้วยข้อผิดพลาด ถ้าไม่มีให้แสดง source gap
  และห้ามอ้างว่าตรวจข้อกำหนดปัจจุบันครบแล้ว
- จำกัด pack 20 MiB / 500 sources / 200 Skills ใช้ service-only atomic import เดิม
  ปฏิเสธ import ขณะมีงาน active และ reimport pack ก่อนหน้าเพื่อ rollback เนื้อหาได้

คำสั่งสำหรับเครื่อง operator ที่มีสิทธิ์:

```bash
npm run harness:reference
npm run harness:reference -- --source /path/to/authorized/STeP-AI-Harness
npm run harness:export -- --source /path/to/authorized/STeP-AI-Harness --out .exports/reviewed-pack.json
npm run harness:verify -- --source /path/to/authorized/STeP-AI-Harness --pack .exports/reviewed-pack.json
# ตรวจ pack เป็นการส่วนตัว แล้วใช้ credentials ฝั่ง operator เท่านั้น
npm run harness:import -- --file .exports/reviewed-pack.json --tenant TENANT_UUID
```

อัปเดต baseline ครั้งต่อไปต้องทบทวนรายการ source ใหม่ ก่อนเรียก `harness:reference --source ... --write`
และคง retrieval 61/61 + buyer identity 3/3 ของต้นทาง ห้ามใส่ corpus ลง Git

## การส่งมอบและสถานะจริง

Frontend และ API/worker ต้องมาจากชุดเปลี่ยนแปลงเดียวกัน เพื่อใช้ `session.search`, `skill.read`
และ Skill support context ใหม่ ไม่ต้องเพิ่ม schema migration
อัปเดต Functions ด้วยขั้นตอน deployment เดิม แล้วนำเข้า pack ที่ตรวจแล้วแยกต่างหาก
PR นี้ต่อจาก backend pilot (#5); homelab packaging (#4) ต้องรวม source ใหม่นี้ก่อน build

ตรวจด้วยข้อมูลสังเคราะห์ ไม่มี live AI หรือการเขียน Google resources
การติดตั้ง homelab, Google OAuth, live provider, Word ในโปรแกรมขององค์กร และ source import บน hosted tenant
ยังเป็นขั้นตอน acceptance แยกจากการผ่าน local tests ดูสถานะล่าสุดใน [progress.md](progress.md)

## สารบัญอ้างอิงทั้ง 32 หมวด

| หมวด                            | สถานะบนเว็บ      | หลักฐาน                                                                                                                                  |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| พื้นที่ทำงาน 3 ส่วน             | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/App.tsx)                 |
| ค้นงานเก่าและส่งออกบทสนทนา      | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/docs/desktop-context-memory.md)      |
| แก้ไขและส่งออกร่าง              | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/draft.ts)                |
| แบบฟอร์มร่างเอกสาร 5 แบบ        | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/document-tools.ts)       |
| รูปแบบ Word และภาษาไทย          | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/document-layout.ts)      |
| ศูนย์รวม Skill และขอบเขตงาน     | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/skills.tsx)              |
| Skill ส่วนตัวและการเสนอ Skill   | ยังไม่เปิดบนเว็บ | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/packs.tsx)               |
| คำขอเริ่มต้นตามทีม              | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/starters.ts)             |
| สื่อภายใน                       | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/internal-media.ts)       |
| สร้างและอ่านภาพ                 | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/image-routing.ts)        |
| ตรวจใบเสร็จ AFP                 | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/receipt.tsx)             |
| เอกสารแนบและ OCR                | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/docs/desktop-context-memory.md)      |
| ค้นความรู้ STeP ก่อนตอบ         | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/docs/desktop-context-memory.md)      |
| อำนาจ หน้าที่ และการยืนยัน      | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/docs/desktop-policy.md)              |
| ความจำที่เจ้าของยืนยัน          | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/memory.tsx)              |
| ข้อเสนอแนะและบทเรียน            | ยังไม่เปิดบนเว็บ | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/learning.tsx)            |
| Google Workspace                | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/google-services.ts)      |
| สรุปเช้าวันนี้                  | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/morning-brief.tsx)       |
| บัญชี AI โมเดล และระดับคิด      | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/ai-connections.tsx)      |
| การใช้งาน วงเงิน และคิว         | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/usage.tsx)               |
| งานตามรอบ                       | ยังไม่เปิดบนเว็บ | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/schedules.ts)            |
| แผนงาน เครื่องมือ และการอนุมัติ | ใช้ผ่าน Desktop  | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/work-plan.tsx)           |
| เว็บ ค้นหา และช่วยกรอกฟอร์ม     | ใช้ผ่าน Desktop  | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/browser.tsx)             |
| Vault และบัญชีเว็บไซต์          | ใช้ผ่าน Desktop  | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/credential-settings.tsx) |
| MCP Docker และงานนักพัฒนา       | ใช้ผ่าน Desktop  | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/automations.tsx)         |
| งบบริบทและการย่อประวัติ         | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/docs/context-performance.md)         |
| ธีม สัญลักษณ์ และแถบย่อ         | ใช้บนเว็บได้     | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/DESIGN.md)                           |
| คำสั่งและคีย์ลัด                | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/commands.ts)             |
| คู่มือ เริ่มต้น และแจ้งปัญหา    | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/setup.tsx)               |
| โปรไฟล์ ภาษา และเสียง           | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/settings.tsx)            |
| การติดตั้งและอัปเดต             | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/update.tsx)              |
| โครง UI และการเข้าถึง           | รองรับบางส่วน    | [ต้นทาง](https://github.com/iisara555/STeP-AI-Harness/blob/90ee71ca667c63284afe4996eddc7e8095b9a059/desktop/src/ui.tsx)                  |
