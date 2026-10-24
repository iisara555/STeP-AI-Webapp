# ตั้งค่า Google login และ protected routes

โค้ดใช้ Supabase Auth แบบ Google OAuth + PKCE สำหรับบัญชีที่ได้รับเชิญ
การเปิด provider, ใส่ client secret และกำหนด origin จริงยังต้องทำในระบบขององค์กร
การทดสอบใน PR ใช้บัญชีและ Auth responses สังเคราะห์ ไม่ใช่การยืนยันว่า Google login จริงพร้อมใช้งาน

## เส้นทางในแอป

| URL              | หน้า               |
| ---------------- | ------------------ |
| `/login`         | ลงชื่อเข้าใช้      |
| `/auth/callback` | รับผล Google OAuth |
| `/`              | งานของฉัน          |
| `/skills`        | Skill              |
| `/documents`     | เอกสาร             |
| `/memory`        | ความจำ             |
| `/receipt`       | ตรวจใบเสร็จ AFP    |
| `/settings`      | การตั้งค่า         |

เมื่อยังไม่ได้ลงชื่อเข้าใช้ หน้า workspace จะส่งไป `/login?next=...`
ระบบเก็บเฉพาะเส้นทางหน้าที่อนุญาตใน sessionStorage ก่อนเริ่ม OAuth และกลับไปหน้านั้นหลังสำเร็จ
ไม่รับ URL ภายนอกหรือ callback เป็นปลายทาง หน้าเปลี่ยนตาม URL รวมถึงปุ่มย้อนกลับ/เดินหน้าและการ reload

แอปรอ `auth.getUser()` ยืนยันตัวตนก่อนขอ snapshot และล้างข้อมูลในหน่วยความจำเมื่อบัญชีเปลี่ยนหรือออกจากระบบ
หาก API ตอบ 401 ระบบออกจาก session ในเครื่องและกลับหน้า login
บัญชีที่ผ่าน Auth ยังต้องได้รับเชิญเข้า tenant จึงจะเห็น workspace
API ตรวจตัวตนและ membership และ RLS บังคับสิทธิ์ข้อมูลทุกครั้ง
ไฟล์ static ของ PWA เป็นสาธารณะ; route guard ควบคุมหน้าจอ ส่วน API/RLS บังคับสิทธิ์ข้อมูลจริง
`?demo=1` เป็นตัวอย่างข้อมูลสังเคราะห์ที่ใช้ host แยกจากระบบจริง

## ตั้งค่าระบบจริงก่อนเปิดใช้งาน

1. ใช้ URL ของ Cloudflare Pages ที่สร้างจริงเป็น app origin และตั้ง build environment:
   - `VITE_SUPABASE_URL`: `https://zwwchjshmxdzhhotacte.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`: publishable key ที่เปิดใช้งานจาก Supabase Dashboard
     ตั้งค่าผ่าน environment ของผู้ให้บริการ ไม่วาง key ในแชตหรือ commit ลง repository
2. ใน Google Auth Platform สร้าง Web OAuth client สำหรับ login โดยใช้ redirect URI:
   `https://zwwchjshmxdzhhotacte.supabase.co/auth/v1/callback`
   ใช้ scopes `openid`, email และ profile; หากแอปอยู่ใน Testing ให้เพิ่มบัญชีนำร่องที่ได้รับอนุญาต
3. ใน [Supabase Auth Providers](https://supabase.com/dashboard/project/zwwchjshmxdzhhotacte/auth/providers)
   เปิด Google แล้วกรอก client ID และ client secret โดยตรงใน Dashboard
   คงการปิด email/password และ anonymous sign-in ตามสถาปัตยกรรมแอป
   อนุญาต OAuth account creation เพื่อให้บัญชีที่ได้รับเชิญล็อกอินครั้งแรกได้
4. ใน Auth URL Configuration ตั้ง Site URL เป็น app origin จริง และเพิ่ม redirect URL
   เป็น origin นั้นตามด้วย `/auth/callback` โดยระบุ URL เต็ม
   ไม่ใช้ wildcard ครอบคลุม preview domains ที่ไม่อยู่ในการควบคุม
   ตั้ง Edge Function `APP_ORIGIN` ให้ตรงกันเพื่อให้ API ยอมรับคำขอจากแอป
5. ตรวจว่า hosting ส่ง deep links กลับ `index.html` (repo มี `web/public/_redirects` แล้ว)
   และเชิญบัญชีผ่านกระบวนการ tenant เดิม ห้ามสร้างสิทธิ์จากชื่อโดเมนหรือ user metadata

ใช้ development callback `http://127.0.0.1:5173/auth/callback` หรือ
`http://localhost:5173/auth/callback` เฉพาะตอนทดสอบในเครื่องที่ได้รับอนุญาต
local `supabase/config.toml` ระบุทั้งสอง callback; การเปลี่ยนไฟล์นี้ไม่เปลี่ยน hosted project
Google Workspace/Drive/Calendar ใช้ OAuth client อีกชุดตาม [deployment.md](deployment.md)

## ตรวจรับด้วยบัญชีจริง

- เปิด `/documents` ในหน้าต่างที่ยังไม่ล็อกอิน แล้วตรวจว่าเห็น login และกลับ `/documents` หลัง Google ยืนยัน
- บัญชีที่ได้รับเชิญเข้า workspace ได้; บัญชีที่ไม่อยู่ใน tenant เห็นข้อความให้ติดต่อผู้ดูแล
- ออกจากระบบแล้วตรวจอีกแท็บและปุ่มย้อนกลับว่าไม่แสดงเอกสารหรือความจำเดิม
- ทดสอบ session ที่ถูกเพิกถอน, callback ที่ถูกยกเลิก และ API 401
- ตรวจ URL callback และ Site URL อีกครั้งหลังเปลี่ยนโดเมน

คำสั่งตรวจในเครื่อง: `npm run check`, `npm test`, `npm run test:db`, `npm run build`,
`npm run test:e2e` (ต้องติดตั้ง Chromium ของ Playwright ก่อน)
ชุด browser checks ใช้สอง local servers: 5173 สำหรับ demo/unconfigured และ 5174 สำหรับ mock Auth
ไม่มีการติดต่อ Google หรือส่งคำขอ AI จริง

อ้างอิง: [Google Auth](https://supabase.com/docs/guides/auth/social-login/auth-google),
[PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow),
[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls),
[getUser](https://supabase.com/docs/reference/javascript/auth-getuser)
