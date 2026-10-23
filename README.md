# STeP AI Webapp

PWA สำหรับพนักงาน STeP แยกจาก [Desktop Harness](https://github.com/iisara555/STeP-AI-Harness)
ใช้ Google login, Supabase และ Gemini ที่องค์กรจัดการให้

- บัญชี Google ที่ได้รับเชิญ แยกข้อมูลตาม tenant และ workspace
- workspace ส่วนตัว พร้อมเชิญสมาชิกเป็นผู้แก้ไขหรือผู้อ่าน
- บทสนทนา ความจำ และเอกสารส่วนตัว เลือกข้อมูลให้ AI อ่านก่อนเริ่มงาน
- Skill และความรู้องค์กรจาก Harness พร้อมเวอร์ชันและแหล่งอ้างอิง
- PDF รูปภาพ Word Excel PowerPoint และไฟล์ Google Drive ที่เลือก
- Calendar แบบ read-only ในบทสนทนาส่วนตัว ให้สิทธิ์แยกจาก login
- ตรวจใบเสร็จด้วย Gemini: ประเภท ความครบถ้วน และขั้นตอนถัดไป
  รวมรอยลายเซ็น เลขภาษีและที่อยู่ผู้ซื้อ STeP เก็บต้นฉบับแยกจากภาพที่ปรับ
- เก็บร่าง ตรวจเวอร์ชันก่อนบันทึก และส่งออก Word (.docx) หรือข้อความ
- ฟอร์มร่าง TOR บันทึกข้อความ หนังสือราชการ โครงการ และรายงานประชุมจาก Desktop
- สื่อภายใน: บรีฟ โครงวาง และ Prompt ที่คัดลอก/บันทึกได้ โดยยังไม่เปิดสร้างภาพผ่าน API
- ค้นข้อความและร่างในงานเก่า ค้นคำสั่ง/Skill ธีมระบบ/สว่าง/มืด และแถบเมนูแบบย่อ
- คู่มือเทียบ Desktop ครบ 32 หมวด พร้อมสถานะเว็บและโมดูลต้นทาง 91 ไฟล์
- คิวงานและวงเงินที่ตรวจสิทธิ์ซ้ำ ไม่เรียก AI ซ้ำอัตโนมัติเมื่อขาดการเชื่อมต่อ

OCR ต้องตรวจเทียบต้นฉบับ ไม่ใช่การอนุมัติเบิกจ่ายหรือรับรองลายเซ็น
ไฟล์ Drive แบบ binary ต้องดาวน์โหลดแล้วอัปโหลด; Google Docs/Sheets อ่านจากไฟล์ที่เลือก
เครื่องมือ native/CLI และการเขียนข้อมูลกลับ Google ยังอยู่ใน Desktop/งานระยะถัดไป

## เริ่มพัฒนา

ต้องมี Node.js 24 และ npm

```sh
npm ci
npm run dev
```

หากยังไม่ตั้งค่าบริการ หน้าแรกจะบอกว่ายังไม่เปิดใช้จริง กด “ดูตัวอย่างหน้าจอ”
เพื่อทดลองด้วยข้อมูลสังเคราะห์ ตัวอย่างไม่เรียก Google, Gemini หรือฐานข้อมูลจริง
เชื่อม backend โดยคัดลอก `web/.env.example` เป็น `web/.env.local`
แล้วใส่ URL และ **publishable key** เท่านั้น ห้ามใส่ server secrets ใน `VITE_`

```sh
npm run check
npm test
npm run test:db
npm run build
npx playwright install chromium
npm run test:e2e
```

ใช้ Cloudflare Pages และ Supabase เริ่มบนแพ็กเกจฟรีได้; ค่า Gemini แยกจากโฮสต์
ยังต้องตั้ง OAuth, server secrets, วงเงิน และ URL จริงก่อนเชิญพนักงาน

- [วิธีติดตั้ง](docs/deployment.md)
- [สถาปัตยกรรมและสิทธิ์ข้อมูล](docs/architecture.md)
- [นำเข้า Harness และย้ายข้อมูล](docs/migration.md)
- [รายละเอียด Desktop และสถานะความสามารถบนเว็บ](docs/desktop-reference.md)
- [ดูแลและสำรองข้อมูล](docs/operations.md)
- [ผลตรวจและสถานะจริง](docs/progress.md)

Repo นี้มีเฉพาะโค้ดและข้อมูลสังเคราะห์ ห้ามเพิ่มเอกสารองค์กร ข้อมูลพนักงาน
คีย์ หรือไฟล์สำรองลง Git ชุดข้อมูล Harness นำเข้าแยกโดยผู้ดูแล
โค้ดที่นำมาใช้รักษา MIT license และบันทึกต้นทางใน
[UPSTREAM.md](packages/harness-core/vendor/UPSTREAM.md)
