# CCTV Platform

ระบบจัดการกล้องวงจรปิดภายในองค์กร (Frigate-inspired) สำหรับกล้อง ~300 ตัว / NVR Hikvision 21 ตัว

- `apps/api` Bun + Elysia + Prisma (SQL Server)
- `apps/web` React + Vite + Tailwind
- `infra/go2rtc` config ของ go2rtc (ตัวกลางสตรีม)
- `registry/` ไฟล์ทะเบียนกล้องต้นฉบับ (ไม่ commit ขึ้น git)
- `docs/ARCHITECTURE.md` สถาปัตยกรรม แผนเฟส และตัวเลขเสนอซื้อ storage

## เริ่มพัฒนา

```bash
bun install
cp apps/api/.env.example apps/api/.env     # แก้ DATABASE_URL, APP_SECRET
cp apps/web/.env.example apps/web/.env
cp infra/go2rtc/go2rtc.example.yaml infra/go2rtc/go2rtc.yaml

# 1. ฐานข้อมูลและ go2rtc (macOS ใช้ไฟล์ override เพิ่ม)
docker compose -f docker-compose.yml -f docker-compose.mac.yml up -d
docker compose exec mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'ChangeMe_Strong1!' -C -Q "CREATE DATABASE cctv"

# 2. สร้างตารางและ import ทะเบียนกล้อง
bun run db:generate
bun run db:push
bun run import:registry            # อ่าน registry/*.xlsx, รันซ้ำได้

# 3. รัน
bun run dev:api                    # http://localhost:3000  (Swagger ที่ /docs)
bun run dev:web                    # http://localhost:5173
```

ผู้ใช้เริ่มต้น: `admin` / `admin1234` (ตั้งใน `.env` ก่อนรันครั้งแรก แล้วเปลี่ยนรหัสหลัง login)

## ขั้นตอนหลัง import

1. หน้า **กล้อง** ติ๊ก "เฉพาะที่ต้องแก้ไข" แล้วกรอกช่อง NVR ของกล้อง Plug & Play และผูก NVR ที่ขาด
2. หน้า **NVR** ตรวจ port และรหัสผ่าน กด "ตรวจ" เพื่อเช็คการเชื่อมต่อ
3. หน้า **กล้อง** กด "Sync go2rtc" เพื่อลงทะเบียนสตรีมทั้งหมด แล้วไปหน้า **Live**

## สิทธิ์ผู้ใช้

| Role | ทำอะไรได้ |
|---|---|
| VIEWER | ดู Live, ย้อนหลัง, เหตุการณ์, export |
| OPERATOR | + บันทึก/แก้เหตุการณ์, จัดกลุ่ม, แก้ไขกล้อง, sync สตรีม |
| ADMIN | + เพิ่ม/ลบกล้องและ NVR, จัดการผู้ใช้, ดู audit log |
