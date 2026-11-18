# AI ขององค์กร (OpenRouter ผ่าน gateway กลาง)

องค์กรซื้อเครดิต OpenRouter ไว้ใช้ร่วมกัน พนักงานไม่ได้รับ key เลย STeP Desktop และ Cloud Workspace เรียก AI ผ่าน
gateway บน `ik-node-01` ซึ่งถือ key ไว้ที่เครื่อง server เท่านั้น

```
STeP Desktop ── Google ID token ──┐
                                   ├─► AI gateway (ik-node-01, npm run ai-gateway) ── key ขององค์กร ──► OpenRouter
Cloud Workspace runtime ── token ──┘        ตรวจสิทธิ์ · เลือกโมเดล · บังคับ ZDR · นับเงินต่อคน/หน่วยงาน
```

## สิ่งที่ gateway ทำ

- **ตัวตน**: Google ID token ของบัญชีองค์กร (audience เป็น client ของเว็บหรือของ Desktop, `hd` ตรงโดเมน, อยู่ในไฟล์รายชื่อเชิญ
  ตัวเดียวกับ Gateway ของเว็บ) ลบชื่อออกจากไฟล์แล้วใช้ไม่ได้ตั้งแต่คำขอถัดไป runtime ของ Cloud Workspace ใช้ token ที่ Gateway ของเว็บ
  เซ็นให้ในชื่อเจ้าของ (`STEP_AI_INTERNAL_SECRET` ค่าเดียวกันทั้งสองฝั่ง) และถูกตรวจกับไฟล์รายชื่อทุกครั้งเช่นกัน
- **โมเดล**: พนักงานเห็นแค่ชื่อในไฟล์ตั้งค่า เช่น `step-chat` และ `step-long` gateway แปลงเป็นโมเดลจริงของ OpenRouter เอง
  ขอโมเดลอื่นจะถูกปฏิเสธ เปลี่ยนโมเดลจริงได้โดยไม่ต้องออก Desktop รุ่นใหม่
- **แยกงานตามประเภท (task-based routing)**: แต่ละโมเดลมีรายชื่อผู้ให้บริการ (`providers`) และความละเอียดของโมเดล
  (`quantizations` เช่น `["fp8"]` เพื่อไม่ให้ไปลงเจ้าที่ลดเป็น FP4) ของตัวเองได้ `routes.images` ส่งคำขอที่มีรูปหรือ PDF
  (เช่นใบเสร็จ) ไปโมเดลอ่านภาพเอง เฉพาะเมื่อพนักงานใช้โมเดลหลัก ถ้าพนักงานเลือกโมเดลเอง (เช่น `step-long`) จะไม่ถูกเปลี่ยน
  `fallback` ส่งต่อให้โมเดลสำรอง 1 ครั้งเมื่อผู้ให้บริการของตัวหลักล่ม หนาแน่น หรือไม่มีเจ้าที่ผ่านเงื่อนไข ZDR
  (ไม่ส่งต่อเมื่อเครดิตหรือโควตาหมด) ตัวอย่างใน `deploy/ai-gateway/ai-gateway.trial-routing.example.json`
- **ข้อมูล**: ทุกคำขอส่ง `provider: { zdr: true, data_collection: "deny" }` และรายชื่อผู้ให้บริการที่อนุญาต (`providers`)
  ส่งชื่อผู้ใช้ไป OpenRouter เป็นรหัสแฮชเท่านั้น ไม่มีอีเมล ไม่มีการเก็บหรือ log ข้อความคำถาม/คำตอบที่ไหนเลย
- **เงิน**: เพดานรายเดือน (ตามเวลาไทย) ต่อคน ต่อหน่วยงาน และทั้งองค์กร ถึงเพดานแล้วได้ 429 `quota_exceeded`
  (Desktop แสดงว่าโควตาหมด ไม่ใช่ให้ลงชื่อใหม่) ค่าใช้จ่ายใช้ตัวเลข `usage.cost` ที่ OpenRouter รายงาน ถ้าไม่มีใช้ราคาในไฟล์ตั้งค่า
  stream ที่ขาดกลางทางถามค่าใช้จ่ายจริงจาก OpenRouter ภายหลัง คำขอสุดท้ายก่อนถึงเพดานอาจเกินได้เล็กน้อย
  (จำกัดด้วย `maxOutputTokens` และงานพร้อมกันต่อคน) เพดานจริงที่กันเงินหมดคือวงเงินของ key ใน OpenRouter
- **รายงาน**: `<STEP_DATA_ROOT>/ai-usage/<YYYY-MM>.jsonl` (0600) บันทึกเฉพาะ ใคร หน่วยงาน โมเดล จำนวน token และเงิน
  ดูด้วย `npm run ai-gateway:report -- 2026-11` บนเครื่อง server หรือ `GET /v1/admin/usage?month=2026-11` (เฉพาะ `STEP_ADMINS`)
  พนักงานดูของตัวเองที่ `GET /v1/usage`

| Method | Path                   | ทำอะไร                                  |
| ------ | ---------------------- | --------------------------------------- |
| GET    | `/healthz`             | liveness                                |
| GET    | `/v1/models`           | โมเดลที่องค์กรเปิด (ตัวหลักอยู่ก่อน)    |
| POST   | `/v1/chat/completions` | OpenAI-compatible ทั้งแบบ stream และไม่ |
| GET    | `/v1/usage`            | ยอดใช้เดือนนี้ของตัวเอง                 |
| GET    | `/v1/admin/usage`      | รายงานหน่วยงานและรายคน (ผู้ดูแล)        |

ทุก path ใช้ได้ทั้งที่ราก และใต้ `/ai` (เช่น `/ai/v1/models`) คำขอที่มี header `Origin` (มาจากหน้าเว็บ) ถูกปฏิเสธ

## ตั้งค่า OpenRouter (เจ้าของบัญชีทำเอง)

1. Settings → Privacy: เปิด Zero Data Retention ทุกกลุ่มโมเดล และเลือก "ZDR only" ถ้ามีให้เลือก
2. Guardrails: สร้าง guardrail ขององค์กร กำหนด model allowlist เป็นโมเดลใน `upstream` ของไฟล์ตั้งค่า, provider allowlist
   ตาม `providers`, budget รายเดือน แล้ว assign ให้ key ข้อ 3
3. สร้าง API key สำหรับ gateway 1 ตัว ตั้งวงเงิน (credit limit) ไม่เกินงบที่อนุมัติ และ key ทดสอบอีกตัววงเงิน $2
4. ส่ง key ให้ server ทางช่องทางที่ไม่ใช่แชต (เช่นพิมพ์ลงไฟล์บน ik-node-01 เอง) ห้ามใส่ใน repo, Desktop หรือหน้าเว็บ

## ติดตั้งบน ik-node-01

```bash
mkdir -p ~/step-ai-gateway && chmod 700 ~/step-ai-gateway
cp deploy/ai-gateway/ai-gateway.example.json ~/step-ai-gateway/ai-gateway.json   # แก้โมเดล เพดาน หน่วยงาน
cp deploy/ai-gateway/ai-gateway.env.example ~/step-ai-gateway/ai-gateway.env && chmod 600 ~/step-ai-gateway/ai-gateway.env
install -m 600 /dev/null ~/step-ai-gateway/openrouter-key && nano ~/step-ai-gateway/openrouter-key   # วาง key เอง
set -a && . ~/step-ai-gateway/ai-gateway.env && set +a && npm run ai-gateway   # ฟังที่ 127.0.0.1:8788
```

ถ้ารันใน container ให้ `STEP_AI_GATEWAY_HOST=0.0.0.0` และ publish port เป็น `127.0.0.1:8788:8788` เท่านั้น

**ให้เครื่องพนักงานเข้าถึง (เจ้าของเลือก Tailscale Funnel, 2026-11-18)**: เปิดสู่อินเทอร์เน็ตเฉพาะเส้นทาง `/ai`

```bash
tailscale funnel --bg --set-path /ai http://127.0.0.1:8788
```

แล้วตั้ง `organizationAi.url` ของ Desktop เป็น `https://ik-node-01.tail17add1.ts.net/ai` (ดู Harness `docs/organization-ai.md`)
ตรวจว่า `/healthz` ตอบจากเครื่องนอก tailnet และ `/v1/models` ไม่มี token ได้ 401

**ให้ Cloud Workspace ใช้ด้วย**: ใน environment ของ `npm run gateway` ตั้ง `STEP_AI_BASE_URL=http://127.0.0.1:8788/v1`,
`STEP_AI_MODEL=step-chat`, `STEP_AI_INTERNAL_SECRET=<ค่าเดียวกัน>` และเอา `STEP_AI_KEY` ออก

## ประมาณค่าใช้จ่าย (ราคาจาก OpenRouter `/api/v1/models` วันที่ 18 พ.ย. 2026)

งบ 4,000 บาท ที่ราว 33 บาท/ดอลลาร์ หักค่าธรรมเนียมซื้อเครดิตด้วยบัตร 5.5% ได้เครดิตราว **$115**

| โมเดล (USD ต่อล้าน token เข้า/ออก)         | ZDR                                           | ถามทั่วไป 1 ครั้ง\* | งาน TOR 1 ชิ้น\*\* |
| ------------------------------------------ | --------------------------------------------- | ------------------- | ------------------ |
| `anthropic/claude-haiku-5.5` 0.10/0.50     | ได้ ไม่มี safety retention                    | ≈ 0.09 บาท          | ≈ 1.4 บาท          |
| `google/gemini-3.8-flash` 0.825/4.125      | ได้ แต่ Google เก็บคำขอที่ถูก flag ได้ 90 วัน | ≈ 0.75 บาท          | ≈ 12 บาท           |
| `anthropic/claude-sonnet-5.5` 2/10         | ได้ ไม่มี safety retention                    | ≈ 1.8 บาท           | ≈ 28 บาท           |
| `deepseek/deepseek-v4.1-flash` 0.051/0.203 | ยังไม่ได้ตรวจรายชื่อ ZDR ของเจ้า FP8          | ≈ 0.04 บาท          | ≈ 0.7 บาท          |

\* 20,000 token เข้า (คำถาม + เอกสาร STeP + ขั้นตรวจของ Desktop) และ 1,500 token ออก
\*\* 300,000 token เข้า และ 25,000 token ออก รวมหลายรอบ

พนักงานทั่วไป (ถามวันละ 10 ครั้ง 21 วันทำงาน บน `step-chat` + TOR เดือนละ 2 ชิ้นบน `step-long`) ≈ $2.3 หรือราว 75 บาท/คน/เดือน
คนใช้หนัก (วันละ 30 ครั้ง + TOR 6 ชิ้น) ≈ $6.8 หรือราว 225 บาท

ข้อเสนอเริ่มต้น: นำร่อง 20 คน เพดานคนละ $3 (≈100 บาท) ต่อเดือน เพดานองค์กร $55 ต่อเดือน งบ 4,000 บาทจึงพอราว 2 เดือนแม้ใช้เต็มเพดาน
(ตามการใช้ทั่วไปราว 2.5 เดือน) ตัวเลขเหล่านี้เป็นค่าประมาณ ใช้ตัวเลขจริงจาก `ai-gateway:report` หลังสัปดาห์แรกปรับเพดาน

**แบบที่ใช้นำร่อง (เจ้าของเห็นชอบ 18 พ.ย. 2026)**: `ai-gateway.example.json` ใช้ 2 โมเดล คือ Claude Haiku 5.5 (`step-chat`)
สำหรับงานทั่วไปและอ่านใบเสร็จ และ Claude Sonnet 5.5 (`step-long`) สำหรับเอกสารทางการ ซึ่ง Desktop เลือกให้เองตาม Skill
ทั้งสองตัวได้ ZDR แบบไม่มี safety retention DeepSeek และ Gemini Flash เป็นตัวทดลองระหว่างนำร่อง
(`ai-gateway.trial-routing.example.json`) สลับได้โดยแก้ไฟล์ตั้งค่าบน server อย่างเดียว

**ก่อนใช้ DeepSeek เป็นตัวหลัก**: เปิดหน้า model ของ DeepSeek V4.1 Flash บน OpenRouter ดูว่าเจ้า FP8 ที่จะใช้ (เช่น DeepInfra,
Novita) อยู่ในรายชื่อ ZDR และใช้ slug ตามหน้านั้นใน `providers` ถ้าไม่มีเจ้าไหนผ่าน ZDR ทุกคำขอจะตกไปโมเดลสำรองทั้งหมด
และต้องผ่านเกณฑ์คุณภาพด้านล่างเหมือนโมเดลอื่น

**ข้อแม้เรื่องคุณภาพ**: ยังไม่ได้วัดว่า Haiku 5.5 ตอบจากเอกสาร STeP และเลือก Skill ได้ไม่ด้อยกว่า Gemini Flash ที่ใช้อยู่ ต้องผ่าน
เกณฑ์ของ Harness (`knowledge-accuracy`, `eval:golden`, `eval:selection`) ผ่าน gateway ก่อนเปิดให้พนักงาน ถ้าไม่ผ่าน ใช้ Gemini 3.8 Flash
แทนได้ แต่ค่าถามทั่วไปแพงขึ้นราว 8 เท่า (≈ 160 บาท/คน/เดือน) และต้องยอมรับ safety retention ของ Google
