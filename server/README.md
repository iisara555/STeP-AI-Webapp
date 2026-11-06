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
  อีเมลยืนยันแล้ว, `hd` และโดเมนอีเมลอยู่ในรายชื่อองค์กร และอีเมลอยู่ในรายชื่อที่ได้รับเชิญ ซึ่งอ่านใหม่ทุกคำขอ
  รายชื่อต้องอยู่ในไฟล์และไม่ถูก SQLite ปฏิเสธตามรายละเอียดด้านล่าง ผู้ใช้ได้ id `g<sub>` ซึ่งเป็นชื่อโฟลเดอร์ใต้ `users/`
- `runs.ts` งาน (run) เป็นของ Gateway ไม่ได้ผูกกับ HTTP request: ปิด Browser แล้ว runtime ยังทำต่อ ผลลัพธ์อยู่ในบทสนทนาของ
  Workspace และ event feed ต่อ Workspace เก็บ event ล่าสุด 2,000 รายการ ให้ client ที่กลับมาส่ง `Last-Event-ID`
  แล้วได้เฉพาะส่วนที่พลาด ถ้าเก่าเกินที่เก็บไว้จะได้ event `reset` ให้โหลดผลจาก API แทน
- ยกเลิกงาน: Gateway รอให้คำขอ ask ถูกส่งเข้า runtime ก่อนส่ง cancel (ช่อง IPC รักษาลำดับ) cancel ที่กดทันทีหลังเริ่มงานจึงไม่หลุด
- quota ต่อผู้ใช้: Workspace ไม่เกิน 10, งานพร้อมกันไม่เกิน 2, งานต่อวัน (UTC) ไม่เกิน 300 ตั้งได้ด้วย environment
- `audit.ts` บันทึก `<data>/audit/<วัน UTC>.jsonl` (0600) เฉพาะ actor, action, workspaceId, runId, outcome และ code
  ไม่มีช่องสำหรับคำถาม คำตอบ หรือชื่อ Workspace
- `GET /api/admin/health` สำหรับผู้ดูแลตาม `STEP_ADMINS`: นับ runtime และงานรายวัน ไม่มีชื่อ เจ้าของ หรือเนื้อหา และผู้ดูแลก็ยังเปิด
  Workspace ของคนอื่นไม่ได้ ตัวเลข `runtimes` และ `runs` เป็นของ Gateway process นี้เท่านั้น ไม่ใช่ยอดรวมทุก
  process และเริ่มนับใหม่หลัง restart; `runs.today` กับ `failuresByCode` เปลี่ยนวันเวลาเที่ยงคืน UTC ด้วย
  `metricsScope` ระบุขอบเขตนี้ให้ client ส่วน `quotas` คือค่ากำหนด ไม่ใช่ยอดคงเหลือหรือหลักฐานว่า disk quota,
  isolation หรือ backup พร้อมใช้งาน การ restart ไม่ได้ล้างตัวนับ daily quota ที่เก็บใน SQLite

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

### Invitation management (#58, partial)

`GET /api/admin/invitations` lists active emails; `POST /api/admin/invitations` and
`POST /api/admin/invitations/revoke` accept only `{ "email": "..." }`. Only currently invited
`STEP_ADMINS` can use them; targets must be valid addresses in `STEP_ALLOWED_DOMAINS`. These APIs
cannot grant admin privileges or change an operator-configured administrator. Admin access does not
confer Workspace access. Changes are stored in `gateway-invitations.sqlite` under `STEP_DATA_ROOT`;
back up this private database along with the invite file. Audit records the actor and operation, not
recipient email.

The operator invite file is the maximum allowed set, read for every authentication. Administrators may
revoke an address in SQLite, or clear that revocation with the invite endpoint, but cannot invite an
address absent from the file (403). Removing any file entry revokes it even if a managed grant exists.
Re-adding an entry restores access unless an administrator denial remains; to keep it revoked after
re-adding, revoke it through the administrator endpoint too. Existing active SQLite grants no longer
extend the file allowlist. Back up both the file and database, and edit the file atomically.

Authentication is checked again immediately before run admission, before an HTTP response and for each
private SSE event. An unauthorized stream closes on its next event; idle streams may remain open. Streams
also close on socket backpressure or more than 128 pending events; clients must reconnect from the last
received event ID. A replay exceeding that pending limit emits a `reset` instead of replaying the gap;
the client must reload conversation state. Run preparation can start a runtime before admission. For administrator
revocations, the gateway serializes the SQLite denial and the synchronous `newConversation` IPC enqueue
(both the direct endpoint and implicit run preparation), `ask` and `cancel` IPC enqueue in the same invitation database:
if the denial commits first, the corresponding request is not enqueued;
if enqueue happens first, revocation can succeed afterwards and does not cancel the run. The same SQLite
ordering fences each private HTTP response enqueue and each private SSE event write: a denial committed first
prevents that enqueue; a write first may still reach the client after the denial. Serialization is done before
acquiring the lock, and the lock is held only for the synchronous Node write/enqueue, never for socket drain.
SSE backpressure closes the stream after releasing the lock. Lock acquisition has SQLite's five-second busy
timeout; failure to acquire or validate the fence sends no private response/event. A failure after Node has
already accepted bytes cannot retract them. A 202 response means
admitted, not necessarily dispatched; a later denial can make the run fail with `UNAUTHENTICATED`, and the
admission still consumes quota. An administrator can explicitly re-invite the address, allowing dispatch again.
This guarantee requires every gateway and admin writer to use this code and the same SQLite database on a
filesystem with working SQLite locks; separate database copies, older processes, or direct database edits that
ignore the protocol are not coordinated. It covers IPC enqueue, not when the child receives the message or
makes provider requests. An enqueue before revocation may create a conversation afterwards. It does not stop
existing runs or fence Workspace start/stop or other in-flight side effects. Workspace creation uses a separate
quota lock followed by the invitation lock and publishes synchronously inside both. A cancel enqueued before
revocation can still take effect afterwards; revocation itself does not cancel a run.

Workspace creation is not idempotent. If it returns `WORKSPACE_PUBLICATION_UNCERTAIN` (or its response is
lost), do not blindly retry: the caller should authenticate again and list their Workspaces to reconcile the
result. A published folder still consumes quota even if a later admission or SQLite commit fails. The runtime
error includes the generated workspace ID; the HTTP error intentionally does not disclose it without a fresh
authorization check. Initial quota policy creation publishes a fully initialized SQLite file atomically;
interrupted first starts can leave private `.quota-init-*` directories, which an operator may remove after
stopping all creators. An existing missing or corrupt policy still fails closed: do not delete or recreate the
policy store without an operator-led investigation and confirmation of the shared policy.

An operator file edit is **not** serialized with workspace publication, dispatch or delivery: it takes effect on subsequent file
reads, but previously authorized work or private output can still be enqueued after the file is changed.
Use the admin revocation API for the ordering guarantee. File edits, token expiry, and other external identity changes cannot be made
atomic by the SQLite lock. Already-buffered bytes cannot be retracted. Authentication/file errors fail closed. No
invitation email is sent. UI, expiry, per-target audit, live Google acceptance and production rollout
remain open.

**Production gateway startup is deliberately disabled.** `npm run gateway` always exits nonzero before
reading configuration or opening data: its `processDriver()` does not provide host isolation, and #57 is
not complete. No environment variable opts out. This also blocks an admin/dev pilot through this entry;
do not use it with real or multi-user data. The separate synthetic-only identity trial below is unchanged,
requires its own sandbox, and is not production isolation acceptance. Library callers and the development
process driver are not protected by this entry-point refusal; they must not be used to bypass it.

The following is the historical configuration, **not a runnable deployment instruction** until the isolation
requirements are met and integrated:

```bash
STEP_DATA_ROOT=/srv/step/data \
STEP_QUOTA_WORKSPACES=10 \
STEP_INVITES_FILE=/srv/step/invites.txt \
STEP_GOOGLE_CLIENT_ID=… STEP_ALLOWED_DOMAINS=step.cmu.ac.th STEP_ADMINS=… \
STEP_APP_ORIGIN=https://… STEP_AI_BASE_URL=… STEP_AI_MODEL=… STEP_AI_KEY=… \
npm run gateway        # ฟังที่ 127.0.0.1:8787 ให้ reverse proxy/Cloudflare Tunnel อยู่ข้างหน้า
```

ก่อนเริ่ม Gateway ครั้งแรก ผู้ดูแลต้องกำหนดนโยบาย quota แยกจาก startup (Node >=24):

```bash
npm run workspace:quota:init -- /srv/step/data 10
# จากนั้นตั้ง STEP_DATA_ROOT=/srv/step/data และ STEP_QUOTA_WORKSPACES=10 แล้วเริ่ม Gateway ตามด้านบน
```

คำสั่งนี้ใช้สำหรับ provisioning ที่ผู้ดูแลอนุมัติเท่านั้น ไม่ใส่ใน startup script หรือ restart loop
รวมถึง trial ที่ใช้ limit 10 (`STEP_TRIAL_DATA` / `STEP_IDENTITY_DATA`) ต้อง provision root ก่อนเริ่มเช่นกัน
สำหรับ root เดิมที่ยังไม่เคยมีนโยบาย ให้หยุด writer รุ่นเก่าทั้งหมด ตรวจจำนวน Workspace และอนุมัติ limit
ก่อนรันคำสั่งครั้งเดียว โดยยืนยัน absolute path ที่ตรวจสอบแล้วอย่างชัดเจน:
`npm run workspace:quota:init -- /srv/step/data 10 --onboard-existing-root /srv/step/data`
flag นี้ใช้รับ root เดิมที่ไม่เคยมี witness เท่านั้น ไม่ override policy ที่หายหรือเสีย
คำสั่งไม่อ่านคำเชิญ ไม่ให้สิทธิ์ผู้ใช้ และไม่เริ่ม runtime หรือเรียก AI

`workspace-quota.sqlite` เก็บนโยบายร่วมของทุก process; `STEP_QUOTA_WORKSPACES` ต้องตรงกับค่าที่ provision
startup และการ publish เปิดไฟล์ที่มีอยู่เท่านั้น ถ้าไฟล์หาย เสีย ไม่มี policy หรือ limit ไม่ตรงจะปฏิเสธ
โดยไม่สร้างหรือซ่อม policy อัตโนมัติ รวมถึงเมื่อไฟล์ถูกลบหลัง manager เริ่มแล้ว
`.workspace-quota-established` เป็น hard link witness ที่สร้างก่อน publish policy และไม่เปิดด้วย SQLite
สำหรับ legacy policy ที่มีอยู่แล้ว จะเปิด inode ที่ตรวจด้วย O_NOFOLLOW และตรวจ table, row และ limit
ภายใต้ SQLite write lock ก่อนสร้าง witness แบบไม่ทับของเดิม; ไม่มี witness ชั่วคราวให้ reader เห็น
หรือ cleanup ที่ลบ witness เมื่อ validation ล้ม หาก process ล้มก่อน link startup ยังปฏิเสธ
หากล้มหลัง link legacy policy นั้นผ่าน validation แล้ว; ไม่ใช้ rename เพื่อสมมติว่าไม่มีผู้ชนะพร้อมกัน
หาก policy หายแต่ witness ยังอยู่ ทั้ง init และ startup จะปฏิเสธ แม้ยืนยัน onboarding อีกครั้ง
ต้องสำรอง witness และ policy เป็น inode เดียวกัน และกู้ทั้งคู่เมื่อหยุด writer แล้ว
การ provision พร้อมกันใช้ไฟล์ชั่วคราวส่วนตัวและ hard link แบบไม่ทับของเดิม จึงเห็นเฉพาะ policy ที่ commit แล้ว
หาก root มีเฉพาะ directory `.quota-init-*` ก่อน witness จะรอผู้ชนะ โดยไม่ต้องยืนยัน onboarding
ชื่อ directory ไม่ให้อำนาจสร้าง policy: directory ปลอมหรือค้างที่ไม่มี witness จะจบด้วย
`QUOTA_ONBOARDING_REQUIRED` ภายใน 5 วินาที และไม่สร้าง policy แม้ directory หายระหว่างรอ
ข้อมูลเดิมชนิดอื่นยังต้องยืนยัน onboarding; ไม่อ่าน candidate หรือเดินตาม symlink
หากเห็น witness ก่อน policy ทั้งตอนเข้า init และตอนแพ้ hard link จะรอ publication ไม่เกิน 5 วินาที
(รวมเวลาที่รอ candidate ก่อน witness ถ้ามี)
โดยไม่สร้างหรือซ่อม policy; limit เดียวกันสำเร็จเมื่อผู้ชนะ publish ภายในเวลานี้
limit ต่างกันล้มเหลวด้วย `QUOTA_POLICY_MISMATCH` หลังตรวจ policy ของผู้ชนะ
แยก process ที่ช้าจาก crash หรือ policy ที่ถูกลบไม่ได้: ครบเวลาให้ `QUOTA_POLICY_REQUIRED`
หากยืนยันว่าผู้ชนะยังทำงานอยู่ ให้รอจบแล้วเรียก init ซ้ำ; หาก policy สูญหายให้ใช้ recovery ด้านล่าง
ordinary startup ไม่รอและยังปฏิเสธ policy ที่หายทันที
ไฟล์เดิมที่เสียหรือไม่มี policy จะไม่ถูกเขียนทับ หาก process ล้มก่อน publish อาจเหลือ `.quota-init-*`
ที่ไม่ใช่นโยบายใช้งาน; หยุดผู้ provision ทั้งหมดก่อนล้าง directory ชั่วคราวเหล่านี้

หาก policy ของ root ที่ใช้งานแล้วหายหรือเสีย ให้หยุด writer ทั้งหมดและกู้คืนจาก backup ที่ตรวจสอบแล้ว
อย่าใช้ init เพื่อเปลี่ยน limit หรือแก้ไฟล์หาย การเปลี่ยน limit ต้องมี operator migration ที่ตรวจทานแยกต่างหาก
ไม่มีคำสั่ง reset/reinitialize หรือเปลี่ยน limit ในงานนี้ ถ้าไม่มี backup ให้ทำ destructive recovery
เป็นงาน operator แยก: หยุด writer ทุกตัว, เก็บ root เก่าและตรวจจำนวน Workspace, ขออนุมัตินโยบายใหม่,
สร้าง root ใหม่แล้ว provision จากนั้นย้ายข้อมูลที่ตรวจสอบแล้วและยืนยันจำนวน/limit ก่อนสลับ configuration
ห้ามลบ witness เพื่อหลบการปฏิเสธของ init; root เก่าที่ไม่มี witness อาจเป็น legacy หรือข้อมูลสูญหาย
ผู้ดูแลต้องยืนยันประวัติจาก backup/audit ก่อนใช้ onboarding สำรอง policy พร้อม Workspace; directory ของ Workspace ที่มีอยู่ยังนับรวม
แม้ process ล้มหลัง rename แต่ก่อน SQLite commit

การประสานงานนี้ต้องใช้ writer รุ่นใหม่ทั้งหมดกับฐานข้อมูลเดียวกัน บน filesystem ที่รองรับ SQLite locks
และ hard link อย่างถูกต้อง ไม่มี database lock ข้าม await; quota fence ครอบ synchronous publication
ภายใต้ invitation fence เดิมเท่านั้น การแก้หรือลบไฟล์โดยผู้ดูแลขณะ writer เปิดฐานข้อมูลอยู่ไม่ได้ถูก fence
(รวมถึง power-loss durability ของ filesystem) จึงต้องหยุด writer ก่อนซ่อม/ย้ายไฟล์
ก่อนสร้าง root ตรวจ ancestor ที่มีอยู่ทั้งหมด แล้วสร้าง directory ทีละระดับและตรวจซ้ำ
ทุก boundary ตรวจ ancestor directories, policy, witness และ SQLite sidecars ด้วย lstat
ปฏิเสธ symlink และชนิดไฟล์ที่ไม่ปลอดภัย; การเปิด policy ถือ O_NOFOLLOW descriptor
และเทียบ inode ก่อน/หลัง SQLite open เพื่อตรวจ path substitution เท่าที่ทำได้
SQLite ยังเปิด pathname ของตนเอง จึงไม่รับประกันการป้องกันผู้โจมตีที่มีสิทธิ์เปลี่ยน filesystem
ระหว่าง syscall หรือ privileged filesystem attacker และไม่รับประกัน power-loss durability
Quota ไม่ serialize การแก้ operator invite file และไม่ได้เพิ่มสิทธิ์ให้ administrator เข้าถึงข้อมูลส่วนตัว

ข้อจำกัดของ 3a:

- สถานะงานและ event feed อยู่ใน memory ของ Gateway: restart แล้วงานที่ค้างหาย (quota รายวันเก็บใน SQLite) ส่วนบทสนทนาในแต่ละ
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

ยังไม่มีระบบจัดการคำเชิญผ่านเว็บ ไม่มี HTTPS สำหรับเผยแพร่ และยังไม่ได้ทดสอบ sandbox บนเครื่ององค์กร
และยังไม่ได้ทดสอบ Google บัญชีจริง การผ่าน synthetic test ไม่ใช่การอนุมัติเปิดให้พนักงานใช้
ข้อมูลทดลองอยู่ใน `.data/identity-trial` หรือ `STEP_IDENTITY_DATA`; ลบเมื่อไม่ใช้และอย่าใส่ข้อมูลจริง

## ทดลอง runtime หลายผู้ใช้

Gateway identity ทดลองหยุด runtime ที่ไม่มีคำขอค้างและไม่มีการใช้งานเป็นเวลา 30 นาที โดยตรวจทุก 1 นาที
คำขอถัดไปเริ่ม process ใหม่และใช้ SQLite เดิม คำขอที่กำลังทำงานจะไม่ถูกหยุดโดยตัวตรวจ idle
runtime สร้างไฟล์ใหม่ด้วย umask 077 และโฟลเดอร์ผู้ใช้มีสิทธิ์ 0700 ไฟล์ที่มีอยู่ก่อนหน้าต้องตรวจสิทธิ์แยก

Gateway identity ใช้ Bubblewrap (`/usr/bin/bwrap`, Linux พร้อม unprivileged user namespaces) แยก mount,
user, PID, IPC และ network namespace ต่อ runtime เปิดอ่านเฉพาะ runtime code, dependencies และ Harness
ที่ติดตั้งโดยผู้ดูแล และเปิดเขียนเฉพาะโฟลเดอร์ workspace ของตน ไม่ mount workspace อื่นหรือ environment
ของ gateway ไม่มี network ภายนอกและใช้ provider จำลองภายใน sandbox เท่านั้น หาก sandbox เริ่มไม่ได้จะ
ปฏิเสธคำขอ ไม่มี fallback ไป process ปกติ ชุดทดสอบตรวจการอ่านไฟล์ข้าม workspace รวม symlink และการต่อ
localhost ของ host รวมทั้ง browser สองบัญชีพร้อมกัน

Sandbox นี้ยังไม่มี cgroup CPU/RAM quota, การทดสอบบน host องค์กร หรือ real-account acceptance และข้อมูล
บนดิสก์ไม่ได้เข้ารหัสโดยตัวทดลอง ต้องตรวจสิ่งเหล่านี้ก่อนเปิดให้พนักงานใช้ ห้ามใส่ข้อมูลจริงใน trial
process driver แบบไม่ sandbox ยังใช้สำหรับ CLI/test เดิมเท่านั้น

### #57: step-runner driver (ทดลอง, ยังไม่ต่อกับ Gateway)

`stepRunnerDriver({ appRoot, nodePath, socketRoot, runnerUid, memoryMaxBytes, tasksMax, cpuQuotaPercent })`
ใน `src/workspace/step-runner-driver.ts` เริ่ม runtime แต่ละตัวเป็นบัญชี `step-runner` ผ่าน
`sudo -n -u step-runner /usr/bin/bwrap` (ต้องติดตั้ง sudo rule ของ `spikes/057-step-runner-sudo`) ภายใน
systemd user scope ชื่อสุ่มที่มี MemoryMax/TasksMax/CPUQuota คุยผ่าน Unix socket ในโฟลเดอร์สุ่มที่ bind เข้า sandbox
นั้นเท่านั้น (ตรวจ SO_PEERCRED ด้วย `python3` และ nonce ที่ส่งทาง stdin) และหยุดด้วย `cgroup.kill` แล้วพิสูจน์ว่า
scope ว่างก่อนรายงานว่าหยุดแล้ว ใช้ provider จำลองเท่านั้น `appRoot`/`nodePath` ต้องอยู่ในที่ที่ step-runner อ่านได้
(เช่น `/opt/step`) ไม่ใช่ `/home` และ `socketRoot` ต้องเป็นของ service account mode 0711

ชื่อโฟลเดอร์ socket แบบสุ่ม **ไม่ใช่ความลับ**: ผู้ใช้ทุกคนบนเครื่องอ่านได้จาก `/proc/<pid>/cmdline` ของ
`systemd-run`/`sudo`/`bwrap` และ socket เป็น 0666 จึงต่อเข้ามาได้ driver จึงถือว่าทุก connection อาจเป็นผู้โจมตี:
ตรวจ SO_PEERCRED ว่าเป็น uid step-runner ก่อนอ่านข้อมูลใดๆ และ frame แรกต้องมี nonce ที่ถูกต้อง ถ้าไม่ผ่านจะตัดทิ้ง
โดยไม่ตอบอะไรแล้วรอ runtime ตัวจริงต่อจนหมดเวลา start รับ peer ที่ถูกต้องเพียงตัวเดียวแล้วปิด listener จำกัด
connection ที่รอตรวจพร้อมกันไม่เกิน 8 และปฏิเสธได้ไม่เกิน 32 ครั้งต่อการ start (เกินแล้ว start ล้มเหลวด้วย
`TOO_MANY_REJECTED_PEERS`) การซ่อน path ด้วย socket root 0700 + group หรือ ACL ของ step-runner ยังรอการแก้ host
(ยังไม่มี `setfacl` และ service account ไม่อยู่ใน group `step-runner`) จนกว่าจะแก้ ผู้ใช้บนเครื่องยังทำให้ start
หนึ่งครั้งล้มเหลวได้ด้วยการ flood (ต้นทุนมีขอบเขต)

stop ที่พิสูจน์ไม่ได้ว่า scope ว่าง (รวม `cgroup.kill` เขียนไม่ได้ หรือ `systemctl show` ล้มเหลว ซึ่งถือว่า "ไม่ทราบ"
ไม่ใช่ "ไม่มีแล้ว") ได้ `RUNTIME_STOP_FAILED` และเรียก `stop()` ซ้ำได้ ส่วนการลบ unit หลังพิสูจน์แล้วดูได้ที่
`handle.scope.unitCleanup` (`'done'`/`'failed'`) ซึ่ง `'failed'` ไม่ได้แปลว่า runtime ยังทำงาน

ทดสอบบน host ที่มี sudo rule: `STEP_STEP_RUNNER_TESTS=1 npm run test:engine` (ไม่มี flag จะ skip ชุด host อย่างชัดเจน)
ชุดทดสอบคัดลอกไฟล์ app และ Node ไปไว้ใต้ `/mnt/step-work/step-driver-test-*` ชั่วคราว โฟลเดอร์ workspace ทดสอบเป็น
0777 เฉพาะการทดสอบ production ต้องใช้ group ร่วมที่ตั้งโดยขั้นตอน setup ของ root ยังไม่มี disk quota และ
การเก็บกวาด scope ที่ค้างหลัง gateway crash

### #57: bounded memory/task exhaustion acceptance (synthetic host tests)

The existing `STEP_STEP_RUNNER_TESTS=1` gate also enables two resource-pressure tests through
`RuntimeDriver.start` / `RuntimeHandle.call`, health and stop. No production driver or Gateway wiring changes.
Before arming either fixture, tests read the **effective** cgroup limits: `memory.max=201326592` (192 MiB),
`memory.swap.max=0`, `pids.max=32`. Both scopes also request `CPUQuota=50%`.

- Memory: one child touches at most 384 MiB in 4 MiB chunks; no recursive allocation/process spawning.
  Its own timer exits after 10 seconds. Acceptance requires a kernel journal record for this exact random
  cgroup with `constraint=CONSTRAINT_MEMCG` and `oom_memcg=<this scope>`; a generic SIGKILL is not proof.
  Read access to `journalctl --dmesg` is checked **before** pressure; do not grant new host permissions just
  to run it. systemd may terminate the whole scope after the worker OOM, so either a killed-worker reply or
  `RUNTIME_EXITED` is accepted, but only with that independent kernel evidence.
- Tasks: sequentially attempt at most 48 direct `/bin/sleep 15` children, never a recursive fork tree.
  Acceptance requires `EAGAIN`, an increased scope `pids.events:max`, and `pids.current <= 32`.
  IPC must remain healthy; after killing/reaping the children, task usage returns to baseline and `/bin/true`
  must spawn and exit successfully in the same runtime.
- Both: a 15-second host watchdog calls stop, the fixture exits after 20 seconds, and each test has a
  60-second timeout and `finally` teardown. The existing tracked-handle suite teardown remains a second
  cleanup layer. After scope-empty/process/unit/socket checks, the real synthetic runtime starts again
  on the same disposable workspace; memory recovery also completes `connect` / `ask`.

Run only on an otherwise idle, provisioned test host with memory headroom (never real data):

```bash
STEP_STEP_RUNNER_TESTS=1 timeout --signal=TERM --kill-after=10s 180s \
  node --import tsx --import ./server/src/register.mjs --test server/test/step-runner-driver.test.ts
```

This closes bounded memory/task enforcement and recovery acceptance only. Workspace disk/inode quota,
restart reconciliation of orphaned scopes, socket group/ACL hardening and production integration remain open.
No host configuration changes, privileged installs, workspace disk filling or inode exhaustion are performed.

### #57: opt-in ขนาด `/tmp` ของ runtime สังเคราะห์

เรียก `processDriver({ isolated: true, tmpfsBytes: 16 * 1024 * 1024 })` จากโค้ด
operator ที่เชื่อถือได้เพื่อกำหนด byte limit ของ private `/tmp` ด้วย Bubblewrap
`--size … --tmpfs /tmp` ก่อนเริ่ม Node และ drop capabilities ทั้งหมดในโหมดนี้
ขนาดต้องเป็น safe integer บวกและหาร 65536 ลงตัว (รองรับ Linux page size ไม่เกิน 64 KiB)
ไม่รับค่าจากผู้ใช้ runtime; ค่าผิดหรือใช้โดยไม่เปิด isolation จะ throw ก่อน spawn
Bubblewrap ที่ไม่รองรับ option หรือ mount ไม่สำเร็จต้องเริ่มไม่ได้ ไม่มี fallback
ค่าเดิมไม่เปลี่ยนและยังไม่มีการเปิดจาก environment หรือ Gateway production

ทดสอบด้วย Node >=24: `node --import tsx --import ./server/src/register.mjs server/test/runtime-tmpfs.test.ts`
ใช้ workspace ชั่วคราวและเขียนไม่เกิน 2 MiB เพื่อพิสูจน์ ENOSPC / ลบแล้วเขียนใหม่
และเริ่ม runtime จริงผ่าน IPC; ต้องมีสิทธิ์สร้าง unprivileged user namespaces
นี่จำกัดเฉพาะ byte allocation ใน `/tmp` ไม่ใช่ inode limit, memory/cgroup limit,
`/dev/shm`, writable namespace root หรือ disk quota ของ Workspace ไม่แก้ same UID/user bus,
mount loss หรือ cleanup หลัง manager crash; #57 ยังไม่เสร็จและยังไม่เหมาะกับ production

ผลทดสอบบน host นอก sandbox ที่รายงานไว้ยืนยัน ENOSPC จริงและเขียนใหม่ได้หลังลบ
แต่ใน integration worktree นี้ Bubblewrap สร้าง user namespace ไม่ได้ จึงยังไม่ยืนยัน
runtime isolation ที่นี่ และไม่ถือว่า isolation test ผ่าน ผลบน host ไม่ได้พิสูจน์
Workspace disk quota หรือ production isolation
