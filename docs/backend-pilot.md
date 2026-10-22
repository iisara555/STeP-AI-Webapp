# เตรียม Supabase สำหรับช่วงทดลอง

Frontend บน homelab ใช้ Supabase โครงการเดิม ส่วนนี้ทำได้ก่อนเชื่อม SSH
แต่การเข้า Google และทดลอง AI จริงยังต้องรอ HTTPS origin ของ Tailscale Serve
และคีย์ใหม่ที่ตั้งผ่านช่องทาง server secrets เท่านั้น

## โค้ดที่ตรงกับเซิร์ฟเวอร์

Supabase มี migration `openrouter_free_trial` และ `server_runtime_vault` กับ
API/worker/callback รุ่น 3 อยู่ก่อนงานนี้ โค้ดใน repository รวมพฤติกรรมเหล่านั้นไว้แล้ว
พร้อมช่องทดลองข้อความแยกสำหรับผู้ดูแล ห้าม deploy checkout ที่เก่ากว่านี้ทับเซิร์ฟเวอร์

สองช่องมีขอบเขตต่างกัน:

- ช่อง Settings → ทดลอง OpenRouter Free ส่งเฉพาะข้อความสมมติในช่องนั้น
  ไม่อ่านเอกสาร ความจำ แชตเดิม หรือ Google และไม่บันทึกข้อความ/คำตอบ
- แชตทดลองแบบ worker ที่มีอยู่เดิมเป็นคนละการเปิดใช้ ต้องมี
  `AI_PROVIDER=openrouter_free`, รุ่น `:free`, upstream ที่ระบุชัด และผู้ดูแลเปิด
  `free_ai_trial_enabled` ใน tenant จึงเริ่มงานได้ ข้อมูลบริบทตามที่ยืนยันจะถูกส่ง
  และผลถูกบันทึกในบทสนทนา จึงไม่ควรเปิดเพื่อทดสอบข้อความสมมติเพียงอย่างเดียว

งานนี้ไม่เปิดช่องใด ไม่ตั้งวงเงิน และไม่ซื้อเครดิตให้
ทั้งสองช่องใช้เพดานรวมบัญชี 40 ครั้ง/วัน UTC และ 15 ครั้ง/นาที
ช่อง Settings ยังจำกัด 5 ครั้ง/นาทีต่อองค์กร ส่วน worker มีเพดานรายองค์กรเพิ่มเติม
คำขอที่ล้มเหลว ยกเลิก หรือถูกลบเนื้อหายังคงนับโควตา ไม่มี paid fallback

## สถานะที่ติดตั้งแล้ว

วันที่ 2026-10-22 ติดตั้ง migration sandbox `20261022164853` และโควตาร่วม
`20261022164909` ในโครงการเดิมแล้ว Local/remote มีประวัติ 12 รุ่นตรงกัน
API, worker และ Google callback เป็นรุ่น 4 สถานะ ACTIVE
ตรวจ ACL/RLS และนิยามโควตาบนฐานข้อมูลจริงแล้ว งบยังศูนย์และ worker trial ยังปิด
Vault ยังไม่มี tenant restriction สำหรับเปิด sandbox

การเรียก HTTP ตรงไปยัง function URL ยังทดสอบไม่ได้จากเครื่องมือเครือข่ายของแชตนี้
สถานะ ACTIVE กับการตรวจ source จึงยังไม่ใช่ผลตรวจรับ Google login หรือการเรียก AI จริง

## การตั้งค่าฝั่งเซิร์ฟเวอร์

Edge Function environment มีลำดับความสำคัญเหนือ Vault ถ้า Vault อ่านไม่ได้
function ตอบ 503 โดยไม่แสดงค่าความลับหรือรายละเอียดฐานข้อมูล
RPC `read_server_runtime_config()` เรียกได้เฉพาะ `service_role`
และอ่านเฉพาะชื่อในตารางนี้:

| Vault name                        | Environment name             |
| --------------------------------- | ---------------------------- |
| `step_ai_provider`                | `AI_PROVIDER`                |
| `step_openrouter_api_key`         | `OPENROUTER_API_KEY`         |
| `step_openrouter_trial_tenant_id` | `OPENROUTER_TRIAL_TENANT_ID` |
| `step_openrouter_model`           | `OPENROUTER_MODEL`           |
| `step_openrouter_provider`        | `OPENROUTER_PROVIDER`        |
| `step_worker_secret`              | `WORKER_SECRET`              |
| `step_app_origin`                 | `APP_ORIGIN`                 |

ช่อง Settings ต้องมีคีย์ใหม่กับ `OPENROUTER_TRIAL_TENANT_ID` ขององค์กรที่เลือก
ไม่ต้องเปิด `free_ai_trial_enabled` และไม่ต้องมีงบ Gemini
อย่านำคีย์ที่เคยส่งในแชตกลับมาเปิดใช้ หรือใส่คีย์ใน migration, Git หรือค่า `VITE_`

ก่อนเปิดใช้ ให้ตั้ง Auth Site URL, redirect `<origin>/auth/callback` และ
`APP_ORIGIN` ให้ตรง HTTPS URL จริง รวมพอร์ตและไม่มี slash ท้าย
ตรวจว่าบัญชี Google ที่ยืนยันแล้ว claim owner reservation เดิมได้
ไม่สร้างผู้ใช้ Google จำลองหรือเปลี่ยน owner เพื่อข้ามการยืนยัน

## อัปเดตและตรวจรับ

ตรวจ `supabase migration list` ก่อน `supabase db push` เสมอ
สอง migration ที่กู้จากเซิร์ฟเวอร์ต้องปรากฏในทั้งสองฝั่งแล้ว
ใช้ migration ที่ค้างสำหรับ sandbox และโควตาร่วมตามลำดับ ห้าม reset ฐานข้อมูล
จากนั้น deploy API, worker และ Google callback พร้อมโค้ด shared ของ checkout นี้
คง gateway `verify_jwt=false` ตาม deployment เดิม: API ตรวจ Auth.getUser และ
membership, worker ตรวจ shared secret, callback ตรวจ OAuth state/PKCE

Deploy frontend รุ่นนี้ด้วย เพื่อส่ง `providerConsent` ตามผู้ให้บริการและโมเดล
ที่แสดงตอนยืนยัน เซิร์ฟเวอร์และ worker ปฏิเสธงานเมื่อ provider เปลี่ยนระหว่างทาง
ปุ่มอ่านเอกสาร/ใบเสร็จปิดเมื่อ server เลือกโหมดข้อความฟรี

หลัง deploy ตรวจว่า RPC จำกัดโควตามีอยู่, client roles เรียก service RPC ไม่ได้,
ตาราง public มี RLS ครบ, งบยังศูนย์ และ worker trial ยังปิด
ตรวจ advisories โดยคงข้อยกเว้นที่มีเหตุผลไว้ตาม [operations](operations.md)

ก่อนเปิดให้ผู้ดูแลทดลองจริง ต้องตรวจ Google login, บัญชีผู้ดูแลที่อนุญาตและบัญชีที่ถูกปฏิเสธ
แล้วส่งข้อความสมมติหนึ่งครั้งและตรวจค่าใช้จ่ายกับ OpenRouter Activity
การทดสอบอัตโนมัติใช้ข้อมูลสมมติและไม่เรียก AI จริง; PostgreSQL tests ใช้ PGlite
กับ Vault จำลองสำหรับทดสอบ allowlist/สิทธิ์ ไม่ได้ตรวจการเข้ารหัส Vault จริง

การย้อนกลับให้ปิดช่องทดลองก่อนและคง schema เพิ่มเติมไว้ อย่า deploy API รุ่นก่อน
provider/Vault ทับโดยลำพัง เพราะ frontend และ worker ต้องใช้สัญญาความยินยอมเดียวกัน
