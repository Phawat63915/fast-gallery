# 🚀 คำสั่งพื้นฐานสำหรับรันและหยุดโปรเจกต์ Fast Gallery

คู่มือสรุปคำสั่งการเริ่มต้นระบบ (Start), การหยุดระบบ (Stop), คำสั่งจัดการภาพย่อ (CLI) และคำสั่งล้างข้อมูล (Reset) สำหรับโปรเจกต์ **Fast Gallery**

---

## 🟢 1. คำสั่งเริ่มต้นระบบ (Starting the Project)

### รูปแบบ A: รันเฉพาะ Backend Server (SQLite Mode - ง่ายที่สุด)
ไม่จำเป็นต้องเปิด Docker เหมาะสำหรับทดสอบระบบแบบรวดเร็ว
```bash
cd backend
go run main.go
```
* 🌐 **URL**: `http://localhost:8880`

---

### รูปแบบ B: รันพร้อม PostgreSQL (Docker Mode)
```bash
# 1. เปิดใช้งาน PostgreSQL Container
docker compose up -d db

# 2. เริ่มต้นรัน Go Backend
cd backend
go run main.go
```

---

### รูปแบบ C: รันโหมด Production (บิลด์เป็น Binary ความเร็วสูงสุด)
```bash
# รันผ่านสคริปต์อัตโนมัติ
./run-prod.sh

# หรือรันทีละขั้นตอนด้วยตัวเอง:
# 1. เริ่มรัน PostgreSQL DB
docker compose up -d db

# 2. คอมไพล์ Go ให้เป็นไฟล์ Binary
./build.sh

# 3. รันไฟล์ Executable Binary โหมด Production
cd backend
./server
```

---

### รูปแบบ D: รันพร้อมกันทุก Frontend ทั้ง 5 Stacks (Full Suite)
```bash
./run-all.sh
```
คำสั่งนี้จะเปิดทั้ง Backend API Server และ Frontend ทั้ง 5 ตัวพร้อมกันบน Port ต่างๆ:
* 🌐 **Backend API**: `http://localhost:8880`
* ⚡ **Stack 1 (Vanilla JS + Worker)**: `http://localhost:8881`
* 🟠 **Stack 2 (Svelte 5 + Vite)**: `http://localhost:8882`
* 🟢 **Stack 3 (Vue 3 + Vite)**: `http://localhost:8883`
* 🔵 **Stack 4 (React 19 + Vite)**: `http://localhost:8884`
* ⚪ **Stack 5 (Vanilla Classic)**: `http://localhost:8885`

---

## 🔴 2. คำสั่งหยุดระบบ (Stopping the Project)

### รูปแบบ A: หยุดกระบวนการที่รันใน หน้าหน้าต่าง Terminal
* กดปุ่ม **`Ctrl + C`** บน Terminal ที่กำลังรันคำสั่งอยู่

---

### รูปแบบ B: ปิด Process ทั้งหมดที่รันเบื้องหลัง (Background Killer)
กรณีรันด้วย `./run-all.sh` แล้วต้องการปิดโปรเซสทั้งหมดพร้อมกัน:
```bash
# หยุด Go Backend Server
pkill -f "server" || pkill -f "go run main.go"

# หยุด Frontend ทั้งหมด (Vite & Serve)
pkill -f "vite" || pkill -f "serve"
```

---

### รูปแบบ C: หยุดและปิด Docker PostgreSQL Container
```bash
docker compose down
```

---

## 🛠️ 3. คำสั่งจัดการพิเศษ (Utility Commands)

### 🖼️ คำสั่งย่อรูปภาพย้อนหลัง (CLI Thumbnail Backfill)
ย่อรูปภาพเดิมที่ยังไม่มี Thumbnail ให้เป็นขนาด 400px (JPEG Quality 80%):
```bash
cd backend
go run ./cmd/generate-thumbnails
```
* **บังคับย่อรูปใหม่ทั้งหมด**: `go run ./cmd/generate-thumbnails --force`

---

### 🧹 คำสั่งรีเซ็ตและล้างข้อมูลทั้งหมด (Reset Data)
ล้างข้อมูลใน Database และไฟล์สื่อใน `data/` เพื่อเริ่มต้นใหม่:
```bash
./reset-data.sh
```

---

### 🧪 คำสั่งรัน Unit Tests
```bash
cd backend
go test -v ./...
```
