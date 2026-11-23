# ค้นเว็บด้วย SearXNG ขององค์กร

สำหรับ Cloud Workspace (เว็บทดลอง :8444) ที่ใช้โมเดลซึ่งค้นเว็บเองไม่ได้ เช่น Qwen บน ik-node-01 โค้ดอยู่ใน
`server/src/web-search/` (ดู `server/README.md`)

```
runtime ของ Workspace ──► ตัวกลาง 127.0.0.1:8890 ──► SearXNG 127.0.0.1:8888 ──► Google / DuckDuckGo / …
        └──────────── อ่านหน้าเว็บผลค้นผ่าน fetchPublic ของ Desktop (เฉพาะที่อยู่สาธารณะ)
```

- ทั้งสองบริการฟังเฉพาะ 127.0.0.1 ห้ามเปิดผ่าน `tailscale serve`/Funnel
- ค้นเฉพาะคำถามปัจจุบันของพนักงานที่ผ่าน privacy check ไม่ส่งไฟล์ ประวัติแชต หรือเอกสาร STeP ไปค้น
- ตัวกลางเว้นช่วงและ cache ไว้กันเว็บค้นหาบล็อกเครื่อง (DuckDuckGo ขึ้น CAPTCHA เมื่อค้นถี่ ส่วน SearXNG พักเครื่องมือที่ถูกบล็อกเอง)

## ติดตั้ง

1. คัดลอก `deploy/web-search/` ไปที่ server (เช่น `~/step-web-search`)
2. `cp searxng/settings.example.yml searxng/settings.yml` ใส่ `secret_key` จาก `openssl rand -hex 32` แล้ว `chmod 600`
   (เจ้าของไฟล์ต้องตรงกับ `user:` ใน `compose.yml`)
3. `.env` ใส่ `STEP_REPO=<checkout ของ Webapp ที่ติดตั้ง dependencies แล้ว>` แล้ว `docker compose up -d`
4. ตรวจ: `curl -s 'http://127.0.0.1:8890/search?q=test'` ต้องได้ JSON และ `ss -ltnp | grep -E ':88(88|90)'` ต้องเห็น 127.0.0.1 เท่านั้น
5. ใน `gateway.env` ของ Gateway ใส่ `STEP_WEB_SEARCH_URL=http://127.0.0.1:8890` แล้ว restart Gateway

## ปิด

ลบ `STEP_WEB_SEARCH_URL` ออกจาก `gateway.env` แล้ว restart Gateway (กลับไปตอบแบบเดิม) จากนั้น `docker compose down` ใน `~/step-web-search`
