# server · engine ของ Desktop แบบไม่มี Electron

ระยะ 2 ของ [ADR 0001](../docs/adr/0001-server-engine-direction.md) เป็น headless spike
พิสูจน์ว่า `WorkService` ของ Desktop รันบน Node ได้โดยไม่ต้องมี Electron และไม่ต้อง copy โค้ด engine

- engine มาจาก submodule `harness/` ที่ล็อกไว้ที่ `desktop-v0.6.20` (`npm run check:engine-pin` ตรวจว่าเป็น release tag)
- `src/engine.ts` สร้าง engine ของผู้ใช้ 1 คน มีโฟลเดอร์ของตัวเอง (`<data>/users/<id>/workspace.sqlite`, สิทธิ์ 0700)
  ใช้ `serverPolicy()`: เปิด privacy check, ปิด tool loop, shell, sandbox, MCP, Copilot, Vault, autopilot และ staff Skills
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
  และไม่อยู่ใน environment ส่วนการค้นเว็บสาธารณะปิดไว้จนกว่า Workspace จะให้ consent (`publicSearch`)

ช่องว่างที่รู้แล้วของระยะ 2:

- คำถามที่ engine ส่งไปค้นเว็บผ่าน provider (เช่น "วันหยุดราชการปีนี้") จบด้วย `PROVIDER_CAPABILITY_UNSUPPORTED` เพราะ endpoint
  แบบ OpenAI-compatible ค้นเว็บไม่ได้ test จึงวัด 60/60 ข้อที่เหลือ และระบุข้อนี้ไว้ชัด รอ router proxy (ADR §7) หรือ engine
- AI skill selection (hybrid) ของ Desktop ทำงานเฉพาะเมื่อเปิด tool loop ซึ่ง server profile ยังปิด คำขอที่ router แบบกฎหา Skill
  ไม่เจอจึงได้คำตอบแบบ general assist แต่ยังไม่ใช้ขั้นตอนของ Skill

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
- endpoint แบบ compatible ค้นเว็บไม่ได้ คำถามที่ engine เลือกส่งไปค้นเว็บ (เช่นวันหยุดราชการ) จะได้ `WEB_SEARCH_UNAVAILABLE`
- tool loop ปิดอยู่ จนกว่า server จะมี tool host ที่จำกัดเครื่องมือเฉพาะ ADR ข้อ 5 (ระยะ 3)
- ยังไม่มี gateway, login หรือการแยกผู้ใช้ระดับ process ตอนนี้เป็น process เดียวต่อคำสั่ง
