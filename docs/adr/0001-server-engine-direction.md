# ADR 0001 · STeP Cloud Workspace บน Linux Server

- สถานะ: ยอมรับแล้ว (ปรับปรุงแนวทาง) 2026-10-26
- ผู้ตัดสิน: เจ้าของโครงการ (Itsara) จากการทบทวนเอกสารพัฒนาร่วมกับ coding agent
- ขอบเขต: Web เป็นหน้าจอสำหรับ Cloud Workspace; งานจริงรันใน Linux Server ขององค์กร
- แทนที่: ถ้อยคำเดิมของ ADR 0001 วันที่ 2026-10-25 ที่อธิบายเป็น engine เดียวต่อผู้ใช้

## บริบท

Webapp ปัจจุบันเป็น React PWA + Supabase Auth/Postgres/Storage/Edge Functions
งานที่ใช้ AI ยังเป็นคำขอแบบ API/Worker: ผู้ใช้ส่งคำขอ รอผล และข้อมูลหลักอยู่ในระบบกลาง
รูปแบบนี้เหมาะกับ Chat, การค้นความรู้ และการร่างเอกสาร แต่ไม่ใช่ประสบการณ์แบบ Codex หรือ Claude
ที่เปิดพื้นที่ทำงานบน Cloud แล้วปล่อยให้ AI ทำงานต่อเนื่องได้แม้ปิด Browser

ความต้องการปลายทางคือ **STeP Cloud Workspace**:

- ผู้ใช้เข้าผ่าน Web ไม่ต้องติดตั้ง Windows หรือ Linux Desktop
- องค์กรมี Linux Server เครื่องเดียวในระยะแรก ใช้ CPU, RAM, GPU และ Storage ร่วมกัน
- ผู้ใช้แต่ละคนสร้าง Workspace ได้หลายพื้นที่ตามงานหรือโครงการ
- แต่ละ Workspace มีไฟล์ บทสนทนา ความจำ และ Runtime ที่แยกจากคนอื่น
- ปิด Browser แล้วงานยังทำต่อได้ และกลับมา Resume ได้
- AI ใช้ Harness Engine เดียวกับ Desktop ในรูปแบบ headless
- ต้องมี human approval ก่อนการเขียนข้อมูลภายนอก

นี่ไม่ใช่ Full Cloud PC หรือ VDI: รุ่นแรกไม่ส่งภาพ Linux Desktop, ไม่เปิด VNC และไม่ให้ผู้ใช้ควบคุมทั้งระบบปฏิบัติการ
ผู้ใช้เห็น Chat, ไฟล์, ความคืบหน้า, ผลลัพธ์ และกล่องอนุมัติผ่าน Web App เท่านั้น

การสำรวจ Harness พบว่าแกนสำคัญ เช่น `service.ts`, `tool-loop.ts`, `policy.ts`, `permissions.ts`,
`providers.ts`, `memory.ts` และ `knowledge.ts` ใช้ Node ได้โดยไม่ต้องพึ่ง Electron ทั้งหมด
แต่ Store เดิมเป็น SQLite ต่อเครื่องและยังไม่มีแนวคิดผู้ใช้หรือ tenant
`server/src/engine.ts` ใน Webapp ปัจจุบันเป็น headless spike สำหรับผู้ใช้เดียว ส่วน `server/src/ask.ts`
เป็นเครื่องมือทดลอง ไม่ใช่ Runtime Manager สำหรับองค์กร

## การตัดสินใจ

### 1. รูปแบบปลายทาง

1. **Web เป็น Client และ Gateway**: ทำหน้าที่ login, ตรวจ membership, แสดง Workspace,
   ส่งคำขอ, แสดงสถานะ และรับการอนุมัติ ไม่เปิดทางให้ Browser ต่อเข้า Process, Docker หรือ SQLite โดยตรง
2. **Cloud Workspace เป็นหน่วยแยกข้อมูลและการประมวลผล**: หนึ่ง Workspace มี Runtime ของตัวเอง
   และผู้ใช้หนึ่งคนสร้างได้หลาย Workspace ตามงาน แต่ละ Workspace เป็น private โดยค่าเริ่มต้น
   การแชร์ระหว่างสมาชิกต้องเป็น ACL ที่ผู้ใช้เลือกเอง ไม่ใช่ผลจากการอยู่ tenant เดียวกัน
3. **หนึ่ง Workspace = หนึ่ง isolated Runtime ที่เปิดใช้งาน**: ใช้ container หรือ process ที่มี namespace,
   filesystem, environment, network policy และ resource quota ของ Workspace เอง ห้ามให้ผู้ใช้หลายคนใช้
   engine state, process memory หรือ working directory เดียวกัน
4. Runtime เริ่มเมื่อเปิด Workspace หรือมีงานที่ต้องทำ หยุดเมื่อ idle ตาม policy และเก็บข้อมูลที่จำเป็นไว้ใน
   persistent volume เพื่อให้กลับมา Resume ได้ หาก Runtime ล้มต้องสร้างใหม่จาก volume/snapshot ได้
5. **ใช้ Hardware ร่วมกัน แต่ไม่ใช้สิทธิ์ร่วมกัน**: CPU, RAM และ GPU ใช้ร่วมผ่าน queue และ cgroup quota;
   งานของผู้ใช้หนึ่งคนที่ใช้ทรัพยากรสูงต้องไม่ทำให้ผู้ใช้อื่นหยุดทำงานทั้งหมด

### 2. Workspace และ Storage

ข้อมูลใน Runtime ใช้รูปแบบต่อผู้ใช้และต่อ Workspace เช่น:

```text
/data/users/<user-id>/workspaces/<workspace-id>/workspace.sqlite
/data/users/<user-id>/workspaces/<workspace-id>/files/
/data/users/<user-id>/workspaces/<workspace-id>/snapshots/
```

- ข้อมูลบทสนทนา ร่าง ความจำ ไฟล์ และผลลัพธ์ของ Workspace อ่านได้โดยเจ้าของและสมาชิกที่ถูกแชร์เท่านั้น
- Admin เห็นสถานะ Runtime, quota, usage และ error metadata ได้ แต่ไม่เห็น private content โดยอัตโนมัติ
- ความรู้ขององค์กรและ Skill ที่อนุมัติแล้วเป็นแหล่งอ่านร่วมแบบควบคุม version ไม่ใช่สิทธิ์อ่านข้อมูลส่วนตัว
- Credential, OAuth grant และ secret ไม่เก็บในไฟล์ Workspace แบบ plaintext; Runtime ได้รับเฉพาะ token ที่สั้นและจำกัดขอบเขต
- ต้องมี quota พื้นที่, snapshot ก่อนงานสำคัญ, backup นอกเครื่อง และวิธีกู้คืนราย Workspace

### 3. Gateway และ Runtime Manager

Gateway ในระบบเป้าหมายทำหน้าที่:

- Google login, tenant membership และ resource ownership
- สร้าง/เปิด/หยุด/พัก/กู้คืน Workspace
- จัดคิวงานและจอง CPU/RAM/GPU
- ออก short-lived session token สำหรับการเชื่อมต่อ WebSocket หรือ event stream
- ส่ง approval request ไปยังผู้ใช้และตรวจสิทธิ์ซ้ำก่อนเขียนข้อมูลภายนอก
- เก็บ audit metadata เฉพาะใคร/อะไร/เมื่อไร/ผลลัพธ์ ไม่เก็บ prompt หรือเอกสารส่วนตัวโดยไม่จำเป็น
- แสดง health, capacity, job failure และ error code ให้ Admin

การเชื่อมต่อจาก Web ต้องผ่าน Gateway เสมอ ห้ามเปิด raw IPC, Docker socket, VNC, CDP หรือ port ของ Runtime ออกสู่ผู้ใช้

### 4. Harness Engine และขอบเขต Tool

Desktop กับ Cloud Workspace ใช้ Engine และ Contract ชุดเดียวกัน โดย Harness จะเข้ามาเป็น git submodule ของ
Webapp ที่ล็อกไว้ที่ release tag `desktop-v*`; ห้าม copy engine source เข้ามา การแก้ Engine ทำผ่าน PR ใน Harness
แล้วจึงเลื่อน tag ที่ Webapp

รุ่นแรกเปิดเฉพาะความสามารถที่จำกัดอยู่ใน Workspace:

- ความรู้ STeP, Skill, เอกสาร, ร่าง และ export
- ความจำที่อยู่ในขอบเขต Workspace
- อ่านไฟล์ใน Workspace เท่านั้น
- Receipt OCR และ public web retrieval ตาม consent/policy
- งาน process หรือ code ที่จำเป็นต่อไฟล์ใน Workspace เฉพาะเมื่อรันใน sandbox/container ที่จำกัดเวลา พื้นที่ และ network
- Google Workspace เมื่อผู้ใช้ยืนยันการอ่านหรือเขียนเป็นรายครั้ง

ความสามารถต่อไปนี้ต้องเป็น optional runner ที่แยก policy และไม่แตะ Host:

- Browser Agent และ browser profile ต่อ Workspace
- MCP server ที่ผู้ดูแล allowlist
- code worker, package install และ Docker-in-Docker
- งานที่ต้องใช้ network ภายนอกหรือ credential พิเศษ

ห้ามโดยปริยาย:

- อ่านหรือเขียน Host filesystem
- ใช้ privileged container หรือ Host Docker socket
- เปิด arbitrary shell/JavaScript/CDP ให้โมเดล
- ใช้ credential ของผู้ใช้อื่นหรือข้าม Workspace
- อ้างว่า Cloud Workspace มีความสามารถของ Windows/macOS native application

### 5. Desktop ท้องถิ่น

Desktop ยังคงทำงานแยกบนเครื่องผู้ใช้และไม่ sync ข้อมูลกับ Cloud โดยอัตโนมัติ
เหมาะกับ Local LLM, ไฟล์ในเครื่อง, Vault, Browser Agent, MCP, งาน Developer และข้อมูลที่ต้องอยู่ในเครื่อง
Cloud Workspace เป็นทางเลือกสำหรับงานที่ต้องการให้ Server ทำต่อเนื่องและเข้าถึงได้จากหลายอุปกรณ์

### 6. Linux Server และการขยายระบบ

ระยะแรกใช้ Linux Server เครื่องเดียวและ Docker Compose หรือ runtime ที่มี isolation เทียบเท่า พร้อม:

- HTTPS reverse proxy และ Cloudflare Tunnel/องค์กร VPN ตามนโยบาย IT
- encrypted data volume และ backup ทุกคืนไปไว้นอกเครื่อง
- health check, resource quota, job queue และการหยุด Runtime ที่ idle
- metrics CPU/RAM/GPU/disk, active Workspace, queue depth และ failure rate

เครื่องเดียวเป็น single point of failure ใน Pilot จึงต้องประกาศข้อจำกัดนี้ชัดเจน
เมื่อผู้ใช้หรือภาระงานเพิ่ม จึงค่อยแยก Runtime Worker หลายเครื่อง โดยคง Gateway และ Workspace identity เดิม

### 7. AI Provider และ Local LLM

Engine เห็น Provider เดียวคือ router proxy แบบ OpenAI-compatible ในระบบองค์กร โดย proxy เลือกปลายทางตาม
ประเภทงาน, Privacy Gate, คุณภาพ, quota และต้นทุน:

- ใช้ Local LLM บน GPU ขององค์กรก่อนสำหรับถามตอบสั้นจากเอกสาร STeP, สรุป, จัดหมวด, แปล และขัดเกลา
- ส่งงานร่าง TOR/หนังสือ/โครงการที่ยาว งานที่ต้องใช้หลายขั้นตอน หรือกรณี Local LLM ไม่ผ่านเกณฑ์ไปยัง API ที่อนุมัติ
- ห้ามส่งข้อมูลส่วนบุคคลออกนอกองค์กรโดยอัตโนมัติ
- เก็บ provider key ไว้ใน server secret store หรือ Vault broker ไม่ส่งให้ Web หรือ prompt
- ทุก tenant และ Workspace มี budget, rate limit และ concurrency limit
- ต้อง benchmark Local LLM บน Hardware จริงก่อนตัดสินใจซื้อ GPU หรือเพิ่ม Worker

### 8. ขอบเขตข้อมูลและการย้ายระบบ

ระบบ Supabase ปัจจุบันเป็น Pilot/ทางผ่านและอยู่ใน feature freeze แก้เฉพาะ bug กับสิ่งที่จำเป็นต่อ Pilot
Cloud Workspace จะเป็นปลายทางใหม่ ไม่เพิ่ม parity ใน Web เพียงเพื่อเลียนแบบความสามารถ native ที่ควรอยู่ Desktop

การย้ายข้อมูลใช้ script ที่ตรวจนับแยกตามผู้ใช้และ Workspace ครอบคลุมบทสนทนา ร่าง ความจำ ใบเสร็จ ไฟล์ และโปรไฟล์
OAuth token ไม่ย้าย ผู้ใช้ต้องเชื่อม Google ใหม่ การ import Skill และเอกสารองค์กรทำจาก pack ที่ตรวจสอบแล้วแยกจากข้อมูลส่วนตัว

## ลำดับการพัฒนา

| ระยะ | งาน                                                                         | เกณฑ์ผ่าน                                                              |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0    | เจ้าของโครงการยืนยัน server, quota, policy, backup และประเภทข้อมูลที่อนุญาต | มี deployment/security checklist และข้อจำกัด Pilot เป็นลายลักษณ์อักษร  |
| 1    | Workspace contract + Runtime Manager: create/start/stop/resume/health       | ผู้ใช้สองคนมี Workspace แยกกันและไม่มีการอ่านข้ามข้อมูล                |
| 2    | รัน Harness headless ต่อ Workspace ด้วย SQLite และ persistent volume        | ทดสอบ knowledge ชุดเดิม 61/61 และ restart แล้วข้อมูลไม่หาย             |
| 2′   | Benchmark Local LLM และ router policy บน GPU/CPU จริง                       | มีผลคุณภาพ ภาษาไทย latency concurrency และต้นทุนต่อคำขอ                |
| 3    | Gateway, WebSocket/event stream, approval, quota และ Admin health page      | ปิด Browser แล้วงานทำต่อ เปิดกลับมา Resume และยกเลิกได้                |
| 4    | Workspace file tools, document export และ optional sandbox runner           | อ่าน/เขียนได้เฉพาะ Workspace พร้อม audit และ resource limit            |
| 5    | Browser/MCP/Google write ที่ allowlist, migration และ Pilot 3–5 คน          | ผ่าน isolation, revocation, backup/restore และ real-account acceptance |
| 6    | เพิ่ม Worker หรือ Full Cloud PC เฉพาะเมื่อมี use case ที่พิสูจน์แล้ว        | มีเหตุผลด้านงานและต้นทุน ไม่ใช่เพียงเพื่อให้ UI เหมือน Desktop         |

## ผลที่ตามมา

ข้อดี:

- ได้ประสบการณ์แบบ Codex/Claude Cloud โดยไม่ต้องติดตั้ง Desktop
- ผู้ใช้หลายคนใช้ Linux Server และ GPU ร่วมกันได้
- งานทำต่อเนื่องหลังปิด Browser และ Resume ได้
- ใช้ Harness Engine เดียวกับ Desktop ลดการเขียน logic ซ้ำ
- แยกข้อมูลและสิทธิ์ได้เป็นราย Workspace

ต้นทุนและความเสี่ยง:

- ต้องสร้าง Runtime Manager, queue, quota, event stream และระบบ backup
- Linux Server เครื่องเดียวเป็นจุดล้มเหลวเดียวในระยะแรก
- งาน Local LLM และงานเอกสารยาวอาจแย่ง GPU/RAM กัน ต้องมี fairness และ admission control
- การเปิด Browser, MCP หรือ code runner เพิ่มความเสี่ยงจาก prompt injection และ credential misuse
- ความสามารถ native ของ Desktop ไม่สามารถถือว่าทำงานบน Cloud ได้โดยอัตโนมัติ ต้องมี adapter และ acceptance แยก

## สิ่งที่ยังไม่ตัดสิน

- จะใช้ Docker, Podman หรือ systemd sandbox เป็น Runtime หลัก
- หนึ่ง Workspace จะสร้าง process ใหม่ทุกครั้ง หรือมี warm process ตามผู้ใช้
- quota CPU/RAM/GPU และพื้นที่ต่อผู้ใช้/Workspace
- Local LLM รุ่นแรก, จำนวน concurrent requests และวิธี queue งานยาว
- ระดับการแชร์ Workspace ระหว่างสมาชิกในทีม
- วันที่พร้อมใช้งานจริงของ Linux Server, backup และ network ingress ขององค์กร
