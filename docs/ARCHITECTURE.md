# สถาปัตยกรรมระบบ CCTV Platform

เอกสารนี้สรุปแนวทางการออกแบบ ขอบเขตแต่ละเฟส และตัวเลขสำหรับเสนอซื้อฮาร์ดแวร์
อัปเดตล่าสุด: 2026-10-27

## 1. ภาพรวม

```
 กล้อง IP (Hikvision / ONVIF)  ─┐
                                 ├─ RTSP ──▶  go2rtc  ──▶ WebRTC / MSE ──▶ Browser (React)
 NVR Hikvision (21 ตัว)  ────────┘   (ดึง 1 ครั้ง แจกหลายผู้ชม)        ▲
   └─ กล้อง Plug & Play ผ่านช่อง NVR                                     │ REST + WebSocket
                                                                         │
 Bun + Elysia API ◀──────────────────────────────────────────────────────┘
   ├─ Prisma ──▶ SQL Server  (ทะเบียนกล้อง/NVR, กลุ่ม, เหตุการณ์, ผู้ใช้, audit)
   ├─ go2rtc client (ลงทะเบียนสตรีม, playback ชั่วคราว)
   ├─ Hikvision ISAPI (ค้นหาช่วงบันทึกบน NVR)
   └─ Health scheduler (ตรวจ TCP ทุก 5 นาที)

 Phase 2+:  ffmpeg recorder ──▶ Central storage        AI worker (GPU) ──▶ events (MQTT/HTTP)
```

หลักการสำคัญที่ยืมจาก Frigate:

- **ดึงสตรีมจากกล้องครั้งเดียว** go2rtc เป็นตัวกลาง ผู้ชมกี่คนก็ได้ไม่เพิ่มโหลดที่กล้องและ NVR
- **Grid ใช้ sub-stream** เปิดเต็มจอค่อยใช้ main stream ลด bandwidth ฝั่งผู้ชม 5-10 เท่า
- **ผู้เล่นหยุดดึงเมื่อไม่อยู่ในจอ** `<video-stream>` ของ go2rtc ตรวจ visibility ให้เอง
- **ระบบกลางเป็นเจ้าของ metadata** กล้องอยู่ NVR ไหนไม่สำคัญกับผู้ใช้ จัดกลุ่มได้อิสระ

## 2. ขอบเขตแต่ละเฟส

| เฟส | เนื้อหา | ฮาร์ดแวร์ที่ต้องมี |
|---|---|---|
| **1 (ปัจจุบัน)** | Live แบ่งกลุ่มตามชั้น/ห้อง/กลุ่มกำหนดเอง, ทะเบียนกล้องและ NVR, ตรวจสถานะ, ดูย้อนหลังข้าม NVR, บันทึกเหตุการณ์ด้วยมือ, Export Excel, ผู้ใช้และสิทธิ์ | Server ที่มีอยู่ (ไม่ต้องมี GPU), NAS สำหรับ dev |
| **2** | บันทึกวิดีโอกลาง (ffmpeg segment ลง storage), timeline playback จาก storage กลาง, snapshot/clip ของเหตุการณ์, retention policy | Central storage (ดูข้อ 4) |
| **3** | AI worker: บุกรุกโซน/เวลาต้องห้าม, นับคน/เข้าออก, ตรวจจับใบหน้าและระบุตัวบุคคล, แจ้งเตือน LINE/Email | GPU NVIDIA (เช่น RTX 4060 Ti 16GB ขึ้นไป) หรือ Coral TPU หลายตัว |
| **4** | รายงานเชิงวิเคราะห์, dashboard ผู้บริหาร, แผนผังชั้นแบบ interactive, mobile | - |

## 3. โมเดลข้อมูล (Phase 1)

- `Floor` → `Room` → `Camera` ตำแหน่งทางกายภาพ ใช้จัดกลุ่มอัตโนมัติ
- `Nvr` เครื่องบันทึก เก็บ template RTSP path ต่อยี่ห้อ ทำให้รองรับ TP-Link VIGI หรือยี่ห้ออื่นได้โดยไม่แก้โค้ด
- `Camera.protocol` บอกวิธีดึงสตรีม: `HIKVISION`, `ONVIF`, `RTSP`, `NVR_CHANNEL` (Plug & Play)
- `CameraGroup` กลุ่มกำหนดเอง ข้าม NVR ได้อิสระ กำหนดจำนวนคอลัมน์ของ grid ได้
- `Event` เหตุการณ์ มี `source` (MANUAL ตอนนี้, AI/NVR ภายหลัง) และ `metadata` JSON สำหรับผล AI
- `AuditLog` ทุกการแก้ไขและ login
- รหัสผ่านอุปกรณ์เก็บแบบ AES-256-GCM ด้วย key จาก `APP_SECRET` ไม่ส่งกลับผ่าน API

## 4. ตัวเลขสำหรับเสนอซื้อ Storage

สมมติฐาน: H.265, 1080p, main stream 2 Mbps, sub stream 0.5 Mbps, กล้อง 300 ตัว

| รูปแบบการบันทึก | Bitrate รวม | ต่อวัน | 30 วัน | 60 วัน | 90 วัน |
|---|---|---|---|---|---|
| Main stream ทุกตัว 24 ชม. | 600 Mbps | 6.5 TB | 194 TB | 389 TB | 583 TB |
| Main stream เฉพาะกลุ่มสำคัญ 60 ตัว | 120 Mbps | 1.3 TB | 39 TB | 78 TB | 117 TB |
| Sub stream ทุกตัว 24 ชม. | 150 Mbps | 1.6 TB | 49 TB | 97 TB | 146 TB |
| เฉพาะ event clip (ประมาณ 5% ของเวลา) | - | 0.3 TB | 10 TB | 19 TB | 29 TB |

สูตร: `TB/วัน = Mbps รวม × 86400 / 8 / 1,000,000`

ข้อเสนอแนะ:

- เริ่มที่ **main stream กลุ่มสำคัญ + sub stream ทุกตัว + event clip** รวมประมาณ 100 TB สำหรับ 30 วัน
- ใช้ RAID 6 หรือ ZFS RAIDZ2 ต้องซื้อดิบประมาณ 1.4 เท่า คือ 140-150 TB (เช่น 10 × 18 TB)
- Network ขาเข้า server ต้องรองรับ 750 Mbps ต่อเนื่อง ควรมี 10 GbE ระหว่าง switch core กับ server
- ใช้ NVR เดิมเป็นสำรองต่อไปได้ ไม่ต้องเลิกใช้ทันที

## 5. ความต้องการ Server

| ส่วน | Phase 1 | Phase 2 | Phase 3 (AI) |
|---|---|---|---|
| CPU | 8 cores | 16 cores | 16+ cores |
| RAM | 16 GB | 32 GB | 64 GB |
| GPU | - | - (ใช้ CPU copy stream ไม่ต้อง decode) | NVIDIA 16 GB VRAM ขึ้นไป |
| Network | 1 GbE | 10 GbE | 10 GbE |
| OS | Linux (Ubuntu 24.04) + Docker | | |

go2rtc และ ffmpeg ในโหมด copy ไม่ decode วิดีโอ จึงใช้ CPU น้อยมาก งานหนักจริงคือ AI ที่ต้อง decode เฟรมเพื่อวิเคราะห์

## 6. ประเด็นที่ต้องเคลียร์กับข้อมูลจริง

1. กล้อง Plug & Play 42 ตัว ต้องกรอก **หมายเลขช่องบน NVR** ด้วยมือ (flag `CHANNEL_UNKNOWN`)
2. กล้อง 31 ตัวไม่ระบุ NVR ในทะเบียน (flag `NVR_MISSING`) และ 4 ตัวอ้าง NVR ที่ไม่มีในทะเบียน (`NVR_UNMAPPED`)
3. NVR บางตัวระบุ port เช่น 28141 ต้องยืนยันว่าเป็น HTTP port จริงบน LAN หรือเป็น port forward
4. ต้องเปิด RTSP บน NVR Hikvision (ค่า default เปิด) และมีผู้ใช้ที่มีสิทธิ์ดู live + playback ทุกช่อง
5. การดูย้อนหลังผ่าน NVR ใช้ ISAPI ซึ่ง **ยังไม่ได้ทดสอบกับอุปกรณ์จริง** ควรทดสอบกับ NVR 1 ตัวก่อน
6. ยืนยัน RTSP path ของ TP-Link VIGI NVR (ตั้งค่าได้ที่หน้า NVR ในระบบ)
