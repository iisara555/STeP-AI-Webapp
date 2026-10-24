# แผนยกระดับ Webapp เทียบ Desktop

สถานะ: กำลังตกลงการออกแบบผ่าน grill-with-docs ยังไม่ใช่แผน implementation ที่ตกลงครบ

## ขอบเขตที่ตกลงแล้ว

- วันที่ 24 ตุลาคม 2569 ผู้ใช้เลือกแก้ข้อบกพร่องทั้ง 5 รายการจาก
  [audit](desktop-parity-audit-2026-10-24.md) และเพิ่มความสามารถที่ขาดจาก Desktop โดยแบ่งเป็นหลายระยะ
- เป้าหมายครอบคลุมผลการทำงานของผู้ใช้ ไม่จำกัดเพียงหน้าตาหรือการปิด findings ทั้ง 5
- ใช้ Desktop 0.6.20 ที่ commit `90ee71ca667c63284afe4996eddc7e8095b9a059`
  เป็นฐานตรวจสอบตาม audit; การเปลี่ยน baseline ต้องบันทึกแยก
- คำศัพท์แยกข้อบกพร่องออกจากช่องว่างความสามารถไว้ใน [CONTEXT.md](../CONTEXT.md)

## ลำดับระยะที่เสนอ

รายการนี้เป็นข้อเสนอเพื่อคุยรายละเอียด ขอบเขตแต่ละระยะและเกณฑ์รับงานยังต้องตกลง

1. ความปลอดภัยและความทนทาน: หยุดส่งบริบทหลัง revoke/cancel, รักษาร่างข้ามหน้า,
   กัน response บันทึกที่มาช้า, คงอายุความจำ และติดตาม OCR ต่อเมื่อ network สะดุด
   เพิ่ม regression tests ที่ทำซ้ำสาเหตุเดิมและตรวจ tenant/private isolation
2. เอกสารและประวัติ: rich editor, ประวัติร่าง/restore, AI proposals, Word/Office output,
   fork/export และการค้นเนื้อหาแนบ
3. ความจำและ Skill: importance/proposals/maintenance, feedback/บทเรียน/curator
   และ personal Skill lifecycle
4. บริการและงานตามรอบ: Tasks/Morning brief, การเขียน Google ที่มี approval,
   schedules และการจัดการ consent/revocation ของงานที่ทำซ้ำ
5. การใช้เครื่องมือและสื่อ: bounded tool loop, browser/Vault/MCP/process,
   AI connections/model controls, image generation และเสียง ตามสถาปัตยกรรมที่จะตกลง

## การตัดสินใจที่ยังเปิด

- ขอบเขตความเทียบเท่าสำหรับงาน native: งานที่ย้ายเข้าเว็บ/เซิร์ฟเวอร์,
  งานที่ต้องใช้โปรแกรมบนเครื่อง และงานที่ยังให้ Desktop รับผิดชอบ
- เกณฑ์รับงานของแต่ละระยะ โดยเฉพาะการรักษาร่างและผลส่งออก Office
- สิทธิ์และ approval สำหรับ external writes, personal Skills และ recurring context
- ค่าใช้จ่าย/ทรัพยากรและการติดตั้งที่ต้องเพิ่มสำหรับเครื่องมือ ภาพ และเสียง
- การแบ่ง PR และขอบเขต deployment/real-account acceptance

## ข้อกำหนดที่คงใช้ระหว่างออกแบบ

- ทำงานใน Webapp repo และคง Desktop checkout ตาม AGENTS.md
- ทุกการเข้าถึงข้อมูลต้องตรวจ tenant membership และ resource ownership;
  admin ไม่ได้สิทธิ์อ่านข้อมูลส่วนตัวโดยอัตโนมัติ
- คง Harness governance, source provenance และ explicit approval ก่อน external writes
- ใช้ข้อมูลสังเคราะห์และไม่มี live AI ใน CI; local verification กับ production acceptance เป็นคนละขั้น
- ไม่เพิ่มบริการที่มีค่าใช้จ่าย เปิด scope จริง ย้าย credentials หรือ deploy จากข้อเสนอในแผนนี้

เอกสารนี้จะอัปเดตเมื่อผู้ใช้ตอบการตัดสินใจแต่ละข้อ ไม่บันทึกคำตอบที่ยังไม่ได้รับเป็นข้อตกลง
