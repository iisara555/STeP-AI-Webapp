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

## Gateway (ระยะ 3a)

`src/gateway/` เป็นทางเข้าเดียวของ Browser สู่ Cloud Workspace ตาม ADR 0001 §3 Browser ไม่เห็น port ของ runtime, IPC,
Docker socket หรือ SQLite

- `auth.ts` ตรวจ Google ID token (`Authorization: Bearer …`) จาก signing key ของ Google: audience ต้องเป็น client id ของเว็บ,
  อีเมลยืนยันแล้ว, `hd` และโดเมนอีเมลอยู่ในรายชื่อองค์กร และอีเมลอยู่ในไฟล์รายชื่อคนที่ได้รับเชิญ ซึ่งอ่านใหม่ทุกคำขอ
  ลบชื่อออกจากไฟล์แล้วเข้าไม่ได้ตั้งแต่คำขอถัดไป ผู้ใช้ได้ id `g<sub>` ซึ่งเป็นชื่อโฟลเดอร์ใต้ `users/`
- `runs.ts` งาน (run) เป็นของ Gateway ไม่ได้ผูกกับ HTTP request: ปิด Browser แล้ว runtime ยังทำต่อ ผลลัพธ์อยู่ในบทสนทนาของ
  Workspace และ event feed ต่อ Workspace เก็บ event ล่าสุด 2,000 รายการ ให้ client ที่กลับมาส่ง `Last-Event-ID`
  แล้วได้เฉพาะส่วนที่พลาด ถ้าเก่าเกินที่เก็บไว้จะได้ event `reset` ให้โหลดผลจาก API แทน
- ยกเลิกงาน: Gateway รอให้คำขอ ask ถูกส่งเข้า runtime ก่อนส่ง cancel (ช่อง IPC รักษาลำดับ) cancel ที่กดทันทีหลังเริ่มงานจึงไม่หลุด
- quota ต่อผู้ใช้: Workspace ไม่เกิน 10, งานพร้อมกันไม่เกิน 2, งานต่อวัน (UTC) ไม่เกิน 300 ตั้งได้ด้วย environment
- `audit.ts` บันทึก `<data>/audit/<วัน UTC>.jsonl` (0600) เฉพาะ actor, action, workspaceId, runId, outcome และ code
  ไม่มีช่องสำหรับคำถาม คำตอบ หรือชื่อ Workspace
- `GET /api/admin/health` สำหรับผู้ดูแลตาม `STEP_ADMINS`: นับ runtime และงานรายวัน ไม่มีชื่อ เจ้าของ หรือเนื้อหา และผู้ดูแลก็ยังเปิด
  Workspace ของคนอื่นไม่ได้

| Method | Path                                                  | ทำอะไร                                                      |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/healthz`                                            | liveness ไม่ต้อง login                                      |
| GET    | `/api/me`                                             | ตัวตนที่ Gateway เห็น                                       |
| GET    | `/api/workspaces`                                     | Workspace ของตัวเอง                                         |
| POST   | `/api/workspaces`                                     | สร้าง `{ name }`                                            |
| GET    | `/api/workspaces/:ws`                                 | สถานะ                                                       |
| POST   | `/api/workspaces/:ws/start` · `/stop`                 | เปิด/หยุด runtime (ข้อมูลอยู่ครบ)                           |
| GET    | `/api/workspaces/:ws/conversations`                   | บทสนทนา (Workspace ที่หยุดอยู่อ่านจากดัชนี ไม่ปลุก runtime) |
| POST   | `/api/workspaces/:ws/conversations`                   | สร้างบทสนทนาเปล่า                                           |
| GET    | `/api/workspaces/:ws/conversations/:session/messages` | ข้อความในบทสนทนา                                            |
| POST   | `/api/workspaces/:ws/runs`                            | เริ่มงาน `{ text, sessionId? }` ได้ 202 ทันที               |
| GET    | `/api/workspaces/:ws/runs` · `/runs/:run`             | สถานะงาน                                                    |
| POST   | `/api/workspaces/:ws/runs/:run/cancel`                | ยกเลิก                                                      |
| GET    | `/api/workspaces/:ws/events`                          | SSE: `run`, `delta`, `discard`, `activity`                  |
| GET    | `/api/admin/health`                                   | ตัวเลขสำหรับผู้ดูแล                                         |

```bash
STEP_DATA_ROOT=/srv/step/data \
STEP_INVITES_FILE=/srv/step/invites.txt \
STEP_GOOGLE_CLIENT_ID=… STEP_ALLOWED_DOMAINS=step.cmu.ac.th STEP_ADMINS=… \
STEP_APP_ORIGIN=https://… STEP_AI_BASE_URL=… STEP_AI_MODEL=… STEP_AI_KEY=… \
npm run gateway        # ฟังที่ 127.0.0.1:8787 ให้ reverse proxy/Cloudflare Tunnel อยู่ข้างหน้า
```

ข้อจำกัดของ 3a:

- สถานะงานและ event feed อยู่ใน memory ของ Gateway: restart แล้วงานที่ค้างหายและ quota รายวันนับใหม่ ส่วนบทสนทนาในแต่ละ
  Workspace ยังอยู่ครบ
- ยังไม่ได้ทดสอบกับบัญชี Google จริง และ event stream ใช้ header `Authorization` จึงต้องอ่านด้วย `fetch` ไม่ใช่ `EventSource`
- ยังไม่มีช่องอนุมัติ เพราะ server ยังไม่มีเครื่องมือเขียนข้อมูลภายนอก (tool loop ปิด) จะทำพร้อมเครื่องมือในระยะ 4 ตาม ADR 0002
- process driver ยังไม่ใช่ security boundary ระดับ host เหมือนเดิม

## หน้าเว็บโหมด Cloud Workspace (ระยะ 3b)

หน้าจอเดิมของ Webapp ใช้ Gateway แทน Supabase เมื่อ build ด้วย 2 ค่านี้ ถ้าไม่ตั้ง แอปทำงานกับ Supabase เหมือนเดิมทุกอย่าง

```bash
VITE_GATEWAY_URL=https://…/gateway   # แนะนำให้ reverse proxy เสิร์ฟ Gateway ใต้ origin เดียวกับหน้าเว็บ
VITE_GOOGLE_CLIENT_ID=….apps.googleusercontent.com   # client id เดียวกับ STEP_GOOGLE_CLIENT_ID ของ Gateway
```

- `web/src/gateway.ts` เป็น `Host` แบบที่สามของหน้าจอ (คู่กับ Supabase และ demo) แปลงคำสั่งเดิม (`snapshot`, `session.create`,
  `session.read`, `run.start`, `run.read`, `run.cancel`, `workspace.create`) ไปเป็น API ของ Gateway และตาม event stream เพื่อให้
  `run.read` มีข้อความที่กำลัง stream เหมือนเดิม คำสั่งอื่นตอบ `CLOUD_NOT_AVAILABLE`
- Workspace แรกของผู้ใช้เก็บงานของหน้าแรก (สร้างให้เมื่อเริ่มงานแรก ชื่อ "งานของฉัน") Workspace อื่นอยู่ในตัวเลือก workspace เดิม
  ทุกงานเป็นส่วนตัว และไม่มีปุ่มแชร์
- เมนูที่แสดง: แชต, ค้นงานเก่า, คู่มือ ส่วนความจำ เอกสาร ใบเสร็จ Skill แบบฟอร์ม สื่อภายใน และการตั้งค่า ถูกซ่อน และในแชตไม่มีปุ่ม
  เลือกเอกสาร ใช้ความจำ บันทึกความจำ หรือใช้เป็นร่าง จนกว่า server จะรองรับ (ระยะ 4–5)
- Login: ปุ่ม Google Identity Services ให้ ID token ที่ Gateway ตรวจ เก็บไว้ใน `sessionStorage` ของแท็บเท่านั้น หมดอายุราวหนึ่งชั่วโมง
  แล้วต้องลงชื่อใหม่ (Google อาจทำให้เองโดยไม่ต้องกด)
- CSP ของหน้าเว็บโหมดนี้ต้องเพิ่ม `https://accounts.google.com` ใน `script-src` และ `style-src` และ origin ของ Gateway ใน `connect-src`
  (ไม่ต้องเพิ่มถ้าเสิร์ฟใต้ origin เดียวกัน) `deploy/homelab/nginx.conf` ของ pilot ยังไม่ได้เปลี่ยน
- Test: `test/gateway-host.test.ts` เรียกคำสั่งของหน้าจอกับ Gateway จริง และ `test/e2e/cloud-workspace.spec.ts` เปิดหน้าจอจริงในโหมดนี้กับ
  Gateway ทดสอบ (`server/test/support/e2e-gateway.ts`) ส่งคำถาม ดูคำตอบ stream แล้ว reload กลางทาง และได้คำตอบที่จบแล้ว

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
