# server · engine ของ Desktop แบบไม่มี Electron

ระยะ 2 ของ [ADR 0001](../docs/adr/0001-server-engine-direction.md) เป็น headless spike
พิสูจน์ว่า `WorkService` ของ Desktop รันบน Node ได้โดยไม่ต้องมี Electron และไม่ต้อง copy โค้ด engine

- engine มาจาก submodule `harness/` ที่ล็อกไว้ที่ `desktop-v0.6.20` (`npm run check:engine-pin` ตรวจว่าเป็น release tag)
- `src/engine.ts` สร้าง engine ของผู้ใช้ 1 คน มีโฟลเดอร์ของตัวเอง (`<data>/users/<id>/workspace.sqlite`, สิทธิ์ 0700)
  ใช้ `serverPolicy()`: เปิด privacy check, ปิด tool loop, shell, sandbox, MCP, Copilot, Vault, autopilot และ staff Skills โดยปริยาย
- `src/register.mjs` แทน `@github/copilot-sdk` ด้วย module ที่ไม่ยอมเริ่มทำงาน เพราะ `providers.ts` import มาแบบ static
  แต่ Copilot ปิดบน server ทำให้ไม่ต้องติดตั้ง native client
- dependencies ของ server มีแค่ 2 ตัว คือ `mdast-util-from-markdown` และ `@xmldom/xmldom` เวอร์ชันเดียวกับ Desktop

## Cloud Workspace · Runtime Manager (ระยะ 1–2)

`src/workspace/` เป็นโครงของ Cloud Workspace ตาม ADR 0001:

- `contract.ts` รูปแบบ Workspace, สถานะ runtime (`stopped`/`starting`/`running`/`stopping`/`failed`) และ `RuntimeDriver`
- `storage.ts` โฟลเดอร์ `<data>/users/<user>/workspaces/<ws>/` สิทธิ์ 0700 ตรวจ id ก่อนสร้าง path ทุกครั้ง
- `manager.ts` `RuntimeManager` ทุกคำสั่งรับผู้ใช้ที่กระทำ และหา Workspace ใต้โฟลเดอร์ของผู้ใช้คนนั้นเท่านั้น
- `process-driver.ts` + `runtime-main.ts` driver สำหรับพัฒนา: หนึ่ง Workspace เป็นหนึ่ง Node process ที่ cwd อยู่ใน `files/`
  และได้ environment แค่ id กับโฟลเดอร์ของตัวเอง ยังไม่ใช่ container จึงห้ามใช้เป็น isolation ของ production
- ระยะ 2: runtime เปิด engine ของ Desktop บน `<ws>/workspace.sqlite` ของตัวเอง Manager ส่งคำขอผ่านช่องทางส่วนตัว
  (`connect`/`ask`/`conversations`) `ask` กับ Workspace ที่หยุดอยู่จะ resume ให้เอง และ runtime ที่ยังมีงานค้างจะไม่ถูกหยุดเพราะ idle
- AI endpoint และ token มาจาก `grant()` ทุกครั้งที่ start/resume token อยู่ใน memory ของ runtime เท่านั้น ไม่ลง SQLite
  และไม่อยู่ใน environment; Workspace ยังไม่ต่อ tool host สำหรับค้นเว็บ แม้ `publicSearch` จะเป็น true

ช่องว่างที่รู้แล้วของระยะ 2:

- คำถามที่ engine ส่งไปค้นเว็บผ่าน provider (เช่น "วันหยุดราชการปีนี้") จบด้วย `PROVIDER_CAPABILITY_UNSUPPORTED` เพราะ endpoint
  แบบ OpenAI-compatible ค้นเว็บไม่ได้ test จึงวัด 60/60 ข้อที่เหลือ และระบุข้อนี้ไว้ชัด รอ router proxy (ADR §7) หรือ engine
- AI skill selection (hybrid) ของ Desktop ทำงานเฉพาะเมื่อเปิด tool loop ซึ่ง server profile ยังปิด คำขอที่ router แบบกฎหา Skill
  ไม่เจอจึงได้คำตอบแบบ general assist แต่ยังไม่ใช้ขั้นตอนของ Skill

## ทดลองค้นเว็บสาธารณะผ่าน ToolLoop

โหมดนี้ใช้กับ `engine:ask` และ `engine:bench` สำหรับเจ้าของโครงการคนเดียว โดยปิดเป็นค่าเริ่มต้น
เพิ่ม `--public-web` **เฉพาะรอบที่ผู้รันยินยอม** ให้ส่งข้อความคำถามสาธารณะทั้งข้อความไป Bing และให้ AI
อ่านหน้าสาธารณะที่อยู่ในผลค้นหา (รวม redirect ไปยังเว็บสาธารณะ) รวมถึงส่งผลค้นหา/เนื้อหาหน้าไปยัง AI endpoint
ที่ตั้งไว้ ใช้เฉพาะคำถามและเอกสารสาธารณะ ห้ามใส่ข้อมูลส่วนตัว ข้อมูลภายใน หรือ credential

```bash
STEP_AI_KEY=ollama STEP_AI_MODEL=gemma4:12b-32k STEP_AI_BASE_URL=http://127.0.0.1:11435/v1 \
  npm run engine:ask -- --public-web --user owner "วันหยุดราชการปีนี้"

STEP_AI_KEY=ollama STEP_AI_MODEL=gemma4:12b-32k STEP_AI_BASE_URL=http://127.0.0.1:11435/v1 \
  npm run engine:bench -- --public-web --question "วันหยุดราชการปีนี้"
```

ใช้ `11434` แทน `11435` เมื่อรันตรงบนเครื่อง Ollama; homelab ต้องมี reverse tunnel ตามตัวอย่างข้างล่าง
และต้องออกอินเทอร์เน็ตเพื่อค้น/อ่านเว็บได้เองด้วย การค้นเว็บไม่ได้ผ่าน tunnel ของ Ollama
`--question` เลือกคำถามที่ตรงทั้งข้อความจากชุด benchmark; ละตัวเลือกนี้เพื่อรันครบ 61 ข้อ

- Host เปิดเฉพาะ `web_search`/`web_fetch` และให้ค้นได้เฉพาะคำถามปัจจุบันตามตัวอักษร ไม่ส่ง query ที่ AI แต่งขึ้น
  อ่านได้เฉพาะ URL ที่ปรากฏในผลค้นหาของรอบนั้น ไม่เกิน 2 ครั้งค้นและ 5 ครั้งอ่าน เครื่องมืออื่นถูกปฏิเสธ
  และ AI skill selection ยังปิดในโหมดทดลองนี้
- ใช้ `searchPublicWeb` และ `fetchPublic` ของ Desktop เพื่อตรวจ public URL, DNS และ redirect;
  ผ่าน privacy scan ทั้งคำถาม URL ผลค้นและหน้าเว็บ หากต้องตรวจเพิ่มจะปฏิเสธแทนการส่งต่อ
- ผลเว็บเป็นข้อมูลที่ไม่น่าเชื่อถือ ไม่ใช่คำสั่ง AI ต้องตรวจแหล่งอ้างอิงและคำตอบเอง รายงาน benchmark เพิ่ม
  `webSearchSucceeded`, `webReadSucceeded`, `webToolFailures`, `webSources` และ `webCited`; การนับนี้ไม่ยืนยันว่าข้อมูลถูกต้อง
  หรือ URL ที่อ้างเป็น URL เดียวกับหน้าที่อ่าน หากโมเดลไม่ขอใช้ tool หรือค้นไม่สำเร็จ ต้องตรวจคำตอบเป็นพิเศษ
- เมื่อเปิดโหมดนี้ CLI แสดงคำตอบหลังจบงาน เพื่อไม่ให้คำขอ tool ระหว่างทางปะปนกับคำตอบ ค่า latency และ token
  อาจเพิ่มจากการเรียกโมเดลหลายรอบ และต้อง benchmark กับโมเดลจริงอีกครั้ง `firstTextP50Seconds` คือข้อความแรก
  ของ provider ซึ่งอาจเป็นคำขอ tool ไม่ใช่เวลาเริ่มตอบให้ผู้ใช้
- นี่เป็นทดลอง CLI ยังไม่เปิดบน Cloud Workspace: `publicSearch` grant ยังไม่ใช่หน้ารับ consent สำหรับ
  การส่ง query ไป Bing และการส่งผลเว็บไป provider ต้องมี gateway และ consent ก่อนเปิดให้ผู้ใช้หลายคน

## ตรวจ

```bash
git submodule update --init harness
npm ci
npm run test:engine        # 61/61 คำถามพนักงานผ่าน engine ทั้งเส้น, แยก SQLite รายคน, server profile, Runtime Manager
npm run check              # รวม type check ของ server (ส่วน engine ให้ CI ของ Desktop ตรวจ)
npm run check:engine-pin   # ต้องต่อเน็ตเพื่ออ่าน tag ของ Harness
```

`test:engine` ใช้ adapter สังเคราะห์ที่บันทึก prompt ไว้ ไม่เรียก AI จริง ข้อที่ตรวจคือเอกสารอันดับแรกใน
`<organization_knowledge>` ที่ engine จะส่งให้ AI ต้องตรงกับคำตอบที่คาดไว้ ถ้าไม่มีเอกสาร engine ก็ต้องไม่ส่งเอกสาร
ซึ่งเข้มกว่า benchmark เดิมใน Desktop ที่วัดแค่ `OrganizationKnowledge.search`

## ลองบน homelab (เจ้าของโครงการคนเดียว)

```bash
export STEP_AI_KEY=…            # อ่านจาก environment เท่านั้น ห้ามใส่ในไฟล์ที่ commit
export STEP_AI_MODEL=…          # ชื่อรุ่นของ endpoint
# STEP_AI_BASE_URL ตั้งต้นที่ https://openrouter.ai/api/v1 ใช้ endpoint ที่เข้ากับ OpenAI ได้ทุกตัว
npm run engine:ask -- --user owner "ติดต่อฝ่ายบุคคลช่องทางไหน"
```

ข้อมูลอยู่ใน `.data/users/owner/` (มีใน .gitignore แล้ว) เปลี่ยนที่เก็บได้ด้วย `STEP_AI_DATA`

`npm run engine:bench` (environment เดียวกัน, `-- --limit n` รันแค่ n ข้อแรก) ถามคำถามพนักงานชุด 61 ข้อกับ provider จริง
แต่ละรอบใช้โฟลเดอร์ผู้ใช้ใหม่แล้วลบทิ้ง ตรวจอัตโนมัติว่า engine ส่งเอกสารถูก ได้คำตอบ และคำตอบอ้างเอกสารที่ควรอ้าง
(ข้อที่ไม่ควรมีเอกสารต้องไม่อ้างเอกสารใด) พร้อมเวลาและ token ชุดคำถามไม่มีคำตอบอ้างอิง ความถูกต้องของเนื้อหา
จึงต้องให้คนอ่านจากรายงานเต็มใน `.data/bench/`

### local LLM ผ่าน Ollama

ไม่ต้องใช้คีย์จริง (adapter ต้องมีค่า จึงใส่อะไรก็ได้) และข้อมูลไม่ออกนอกเครื่อง Ollama เปิดรุ่นที่ context 4,096 token
ซึ่งสั้นกว่า prompt ของ engine จะล้มด้วย `PROVIDER_STREAM_INCOMPLETE` ให้สร้างรุ่นที่ context 32k ก่อน:

```bash
printf 'FROM gemma4:12b\nPARAMETER num_ctx 32768\n' > Modelfile.32k
ollama create gemma4:12b-32k -f Modelfile.32k
STEP_AI_KEY=ollama STEP_AI_MODEL=gemma4:12b-32k STEP_AI_BASE_URL=http://127.0.0.1:11434/v1 \
  npm run engine:ask -- --user owner "ติดต่อฝ่ายบุคคลช่องทางไหน"
```

homelab ไม่มี GPU ให้รัน engine บน homelab แล้วเรียก Ollama บนเครื่องที่มี GPU ผ่าน SSH reverse tunnel
ซึ่งเปิดเฉพาะระหว่างคำสั่ง (`ssh -R 127.0.0.1:11435:127.0.0.1:11434 <user>@homelab` แล้วใช้
`STEP_AI_BASE_URL=http://127.0.0.1:11435/v1`) ไม่ต้องเปิด Ollama ออกเครือข่าย

ข้อจำกัดของ spike นี้:

- ยังไม่บังคับนโยบายข้อมูลของ provider (`data_collection: deny`) งานนี้เป็นของ router proxy ในระยะ 4
  ระหว่างนี้ให้ถามเฉพาะคำถามที่ไม่ลับ
- เมื่อไม่เปิด `--public-web` endpoint แบบ compatible ไม่มี web search ของ provider และคำถามที่ต้องค้นเว็บจะไม่สำเร็จ
- tool loop เปิดเฉพาะการทดลอง CLI เมื่อเลือก `--public-web`; ยังไม่เปิดเครื่องมืออื่นหรือ Cloud Workspace
- ยังไม่มี gateway, login หรือการแยกผู้ใช้ระดับ process ตอนนี้เป็น process เดียวต่อคำสั่ง

## หน้าเว็บทดลอง engine สำหรับเจ้าของ

รัน `npm run engine:owner-trial` บน homelab แล้วเปิด URL ที่แสดงใน terminal ผ่าน SSH local
port forwarding (`ssh -L 8766:127.0.0.1:8766 <user>@homelab`); เปิด URL บนเครื่องเจ้าของ
เท่านั้น อย่าส่ง URL ให้ผู้อื่น token ใน URL เปลี่ยนทุกครั้งที่เริ่มใหม่และเก็บไว้ในหน่วยความจำ
ของหน้าเว็บ หลัง reload ให้เปิด URL จาก terminal อีกครั้ง ใช้ Ctrl-C เพื่อหยุด

หน้านี้แยกจาก Supabase pilot และรับฟังเฉพาะ `127.0.0.1`; gateway ตรวจ token, Host และ Origin
และส่งคำขอไปยัง Workspace ของ owner ผ่าน Runtime Manager และ Desktop engine ตัว provider จำลอง
ทำงานใน process เดียวกัน รับข้อมูลเฉพาะในเครื่องและตอบข้อความคงที่ ไม่สามารถตั้ง provider จริง
หรือเปิด public web ในหน้านี้ได้ ใช้เฉพาะข้อมูลสังเคราะห์ ข้อมูลบทสนทนายังคงอยู่ใน
`.data/owner-trial` (เปลี่ยนได้ด้วย `STEP_TRIAL_DATA`) และไม่ได้เข้ารหัสโดยตัวทดลอง
ลบทิ้งเมื่อไม่ต้องการแล้ว `STEP_TRIAL_PORT` เปลี่ยนพอร์ตได้ (ต้องปรับ SSH forwarding ให้ตรงกัน)

นี่ไม่ใช่ระบบ login หรือ isolation สำหรับพนักงาน ผู้ที่เข้าถึงเครื่องหรือ URL อาจใช้การทดลองได้
process driver ไม่ใช่ขอบเขตความปลอดภัย และยังไม่ได้ทดสอบบน homelab จริง ไม่มีการ deploy จากงานนี้

## ทดลอง Google identity กับ gateway

`npm run engine:identity-trial` เป็นการทดลองแยกจาก owner trial และ Supabase pilot ใช้ provider จำลอง
ในเครื่องเท่านั้น ตั้งค่า `STEP_GOOGLE_CLIENT_ID`, `STEP_GOOGLE_DOMAIN` และ `STEP_INVITATIONS_FILE`
(absolute path ของไฟล์ JSON ที่ operator ดูแล ไม่ commit) ก่อนรัน ใช้พอร์ต `127.0.0.1:8767` หรือ
`STEP_IDENTITY_PORT`; เปิดผ่าน SSH local forwarding และลงทะเบียน origin localhost ที่ตรงกับพอร์ตใน
Google OAuth client โดยเปิด `http://localhost:8767` บนเครื่องเจ้าของ ข้อมูลให้ใช้สังเคราะห์เท่านั้น

ไฟล์คำเชิญเป็น JSON array เช่น (ข้อมูลสมมติ):

```json
[
  {
    "id": "unique-random-id-123456",
    "email": "alice@example.org",
    "expiresAt": "2099-01-01T00:00:00.000Z",
    "revoked": false
  }
]
```

ใช้ ID สุ่มใหม่ทุกครั้งที่ออกคำเชิญ ตั้งสิทธิ์ไฟล์ให้เฉพาะ operator อ่าน/แก้ได้ และแก้แบบ atomic
gateway ตรวจลายเซ็นและ audience ของ Google ID token ผ่าน Google auth library ตรวจ `email_verified`,
`hd`, email และคำเชิญที่ยังไม่หมดอายุ; ทุกคำขอและก่อนตอบจะอ่านคำเชิญซ้ำ การลบหรือ revoke คำเชิญ
ตัดสิทธิ์ session เดิม session อยู่ในหน่วยความจำและหมดอายุใน 8 ชั่วโมงหรือเมื่อ server หยุด
ผู้ใช้ไม่สามารถเลือก owner หรือ workspace ID; runtime manager ใช้ Google subject ที่ hash เป็น owner ID
และ SQLite แยกต่อ workspace

ยังไม่มีระบบจัดการคำเชิญผ่านเว็บ ไม่มี HTTPS สำหรับเผยแพร่ ไม่มี process isolation ที่ปลอดภัยสำหรับหลายคน
และยังไม่ได้ทดสอบ Google บัญชีจริง การผ่าน synthetic test ไม่ใช่การอนุมัติเปิดให้พนักงานใช้
ข้อมูลทดลองอยู่ใน `.data/identity-trial` หรือ `STEP_IDENTITY_DATA`; ลบเมื่อไม่ใช้และอย่าใส่ข้อมูลจริง
