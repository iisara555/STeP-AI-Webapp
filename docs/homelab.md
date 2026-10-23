# ทดลอง STeP บน homelab ผ่าน Tailscale

หน้าเว็บรันใน Docker บน homelab ส่วน Auth ฐานข้อมูล Storage และ API ใช้ Supabase เดิม
OpenRouter และคีย์บริการทั้งหมดอยู่ฝั่ง Supabase ชุดนี้ไม่ติดตั้งฐานข้อมูลใหม่บน homelab
และไม่เปิดบริการออกสู่อินเทอร์เน็ตผ่าน Cloudflare หรือ Tailscale Funnel

## รุ่นหน้าเว็บที่ต้องใช้

Supabase API/worker/callback อัปเดตเป็นรุ่น 4 แล้ว ต้องใช้หน้าเว็บที่ส่ง
`providerConsent` จาก [PR #5](https://github.com/iisara555/STeP-AI-Webapp/pull/5)
รวม PR ดังกล่าวก่อนติดตั้ง checkout นี้ ชุดติดตั้ง homelab ที่เตรียมให้รวมทั้งสองส่วนไว้แล้ว
ฐานข้อมูลจำกัดโควตาติดตั้งแล้ว แต่ยังต้องตั้ง HTTPS origin และคีย์ใหม่ก่อนทดลองจริง

## เตรียมเครื่อง

ต้องมี Docker Engine, Docker Compose v2, Git และ Tailscale ที่เชื่อม tailnet แล้ว
เครื่องที่ใช้เปิดเว็บต้องเข้า tailnet เดียวกันและผ่าน ACL ที่ผู้ดูแลกำหนด
อย่าเปลี่ยน ACL ทั้ง tailnet เพื่อเปิดแอปนี้

ใช้ checkout ของ PR สำหรับ homelab หรือ main หลังรวม PR แล้ว จากโฟลเดอร์ repository:

```sh
mkdir -p .local
cp deploy/homelab/.env.example .local/homelab.env
chmod 600 .local/homelab.env
```

แก้ `.local/homelab.env` ให้มี URL ของ Supabase เดิมและ publishable key แบบ
`sb_publishable_...` ที่ยังเปิดใช้งานอยู่ สองค่านี้จะถูกฝังในหน้าเว็บตามปกติ
อย่าใส่ service-role key, OpenRouter key หรือ Google client secret ในไฟล์นี้
image จะปฏิเสธ key รูปแบบอื่นตั้งแต่ขั้น build

## เริ่มหน้าเว็บ

```sh
docker compose --env-file .local/homelab.env -f deploy/homelab/compose.yml config --quiet
docker compose --env-file .local/homelab.env -f deploy/homelab/compose.yml up -d --build --wait
curl --fail http://127.0.0.1:8080/healthz
```

พอร์ต 8080 ฟังเฉพาะ localhost ของ homelab ตัว runtime ใช้ผู้ใช้ที่ไม่ใช่ root,
filesystem แบบอ่านอย่างเดียว และแยกจาก source code กับไฟล์ environment
ถ้าพอร์ตชนแอปเดิม เปลี่ยน `STEP_HTTP_PORT` และใช้พอร์ตนั้นใน Tailscale Serve ด้วย
ค่า public configuration เป็นค่าตอน build; เมื่อเปลี่ยนให้ build image ใหม่

## เปิด HTTPS เฉพาะใน tailnet

ตรวจบริการเดิมก่อน เลือกพอร์ต HTTPS ที่ยังว่าง ตัวอย่างนี้ใช้ 8443 เพื่อแยกจากเว็บที่พอร์ต 443:

```sh
tailscale serve status --json
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080
tailscale serve status
```

ครั้งแรก Tailscale อาจให้เจ้าของ tailnet เปิด HTTPS/Serve ผ่านหน้าการตั้งค่า
ใช้ URL `https://<ชื่อเครื่อง>.<ชื่อ-tailnet>.ts.net:8443` ที่คำสั่งรายงานจริง
อย่าเปิดด้วย IP แบบ HTTP เพื่อทดสอบ PWA หรือ Google OAuth
อย่ารัน `tailscale serve reset` เพราะอาจลบบริการอื่นบนเครื่อง
Serve จำกัดการเข้าถึงตามเครือข่ายและ ACL; สิทธิ์ผู้ดูแล STeP ยังตรวจอีกชั้นที่ Supabase

อ้างอิง [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)

## ตั้งค่าฝั่ง Supabase หลังได้ URL จริง

ตั้ง Auth Site URL และเพิ่ม redirect URL `<origin>/auth/callback` แบบตรงตัว
ตั้ง `APP_ORIGIN` ของ API ให้ตรงกับ origin เดียวกัน รวมพอร์ต 8443 และไม่มี slash ท้าย
หาก deployment ใช้ Vault เป็น configuration fallback ให้ปรับผ่านช่องทาง operator
ที่ใช้งานอยู่ โดย environment secret ยังมีลำดับความสำคัญสูงกว่า Vault

Google login ต้องมี OAuth client ที่ตั้ง redirect กลับ Supabase และเปิด provider จริง
บัญชีผู้ทดลองต้องได้รับคำเชิญและยืนยัน Google identity ก่อน จึงจะได้สิทธิ์ในองค์กร
อย่าทำให้บัญชีเป็นผู้ดูแลด้วย JWT metadata หรือการข้ามขั้นตอนยืนยันตัวตน
อีเมลผู้ดูแลและค่าเฉพาะเครื่องให้เก็บนอก Git

ช่อง OpenRouter ต้องมี migration และ API ที่รองรับ action `admin.openrouter.*`
รวมถึง `OPENROUTER_TRIAL_TENANT_ID` และคีย์ใหม่ที่เก็บฝั่งเซิร์ฟเวอร์ ดู
[ขั้นตอนเปิด trial](deployment.md#optional-administrator-free-trial)
ตรวจ source และ migration history ของ deployment ก่อนอัปเดต เพราะ backend ที่ติดตั้ง
ไว้อาจมีการเปลี่ยนแปลงนอก repository ห้ามทับ deployment หรือ reset ฐานข้อมูลเพื่อให้ตรง

## ตรวจผลและย้อนกลับ

ถ้ามี Node.js 24 ขึ้นไป ใช้ตัวตรวจ hosting ที่ localhost และ URL HTTPS จริง:

```sh
node scripts/verify-homelab.mjs http://127.0.0.1:8080
node scripts/verify-homelab.mjs https://HOST.TAILNET.ts.net:8443
```

ตัวตรวจยืนยันเพียง hosting, OAuth callback path, PWA cache และ security headers
ตรวจเพิ่มด้วยบัญชีจริง: Google login, บัญชีที่ไม่ได้รับเชิญ, สิทธิ์ผู้ดูแล/พนักงาน,
และส่งข้อความสมมติเพียงครั้งเดียวผ่าน trial พร้อมเทียบ Activity ของ OpenRouter
โหมด `?demo=1` ใช้ตรวจหน้าจอเท่านั้น ไม่ยืนยัน API หรือ billing

หยุดเฉพาะแอปนี้โดยไม่ลบบริการ Tailscale อื่น:

```sh
sudo tailscale serve --https=8443 off
docker compose --env-file .local/homelab.env -f deploy/homelab/compose.yml down
```

ข้อมูลจริงอยู่บน Supabase จึงไม่ถูกลบด้วย `compose down`
การย้อนเวอร์ชันหน้าเว็บให้ checkout commit ที่ตรวจแล้ว จากนั้น build/up ใหม่

## สถานะที่ยังต้องตรวจบนเครื่องจริง

การทดสอบ Docker ใน environment ของ Codex ไม่ถือเป็นการติดตั้งบน homelab
ถ้า environment ของแชตไม่มี Tailscale VPN และ TCP grant ไปยังเครื่องเป้าหมาย
ผู้ดูแลต้องเชื่อม environment ให้เข้าถึงได้ก่อนการติดตั้งผ่าน SSH
การมี IP Tailscale อย่างเดียวไม่ได้ทำให้ SSH จาก environment นี้ใช้งานได้
