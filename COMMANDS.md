# 🚀 คำสั่งพื้นฐานสำหรับรันและหยุดโปรเจกต์ Fast Gallery (รันจาก Root Directory)

คู่มือสรุปคำสั่งการเริ่มต้นระบบ (Start), การหยุดระบบ (Stop), คำสั่งจัดการภาพย่อ (CLI) และคำสั่งล้างข้อมูล (Reset) สามารถ **รันโดยตรงจาก Root Directory ของโฟลเดอร์โปรเจกต์** ได้ทันทีโดยไม่ต้อง `cd` ย้ายโฟลเดอร์

---

## 🟢 1. คำสั่งเริ่มต้นระบบ (Starting the Project)

### รูปแบบ A: รันแบบ Development (SQLite Mode - รันจาก Root)
```bash
go run ./backend/main.go
# หรือรันผ่านสคริปต์
./run-dev.sh
```
* 🌐 **URL**: `http://localhost:8880`

---

### รูปแบบ B: รันโหมด Production (บิลด์เป็น Binary ความเร็วสูงสุด)
```bash
# รันผ่านสคริปต์อัตโนมัติ (รันจาก Root)
./run-prod.sh

# หรือรันทีละขั้นตอนจาก Root:
docker compose up -d db && ./build.sh && ./backend/server
```

---

### รูปแบบ C: รันเฉพาะ Backend + Stack 1 (Vanilla JS + Worker @ Port 8881)
```bash
# 🔹 โหมด Development (รันตรงจาก Root):
./run-stack1.sh

# 🔹 โหมด Production (บิลด์เป็น Binary + PostgreSQL):
./run-stack1-prod.sh

# หรือสั่ง manual จาก Root:
docker compose up -d db && ./build.sh && (cd backend && ./server) & (npx serve frontends/1-vanilla-worker -p 8881 --single)
```
* 🌐 **Backend API**: `http://localhost:8880`
* ⚡ **Stack 1 Frontend**: `http://localhost:8881`

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
```bash
# หยุด Go Backend Server
pkill -f "server" || pkill -f "main.go"

# หยุด Frontend ทั้งหมด (Vite & Serve)
pkill -f "vite" || pkill -f "serve"
```

---

### รูปแบบ C: หยุดและปิด Docker PostgreSQL Container
```bash
docker compose down
```

---

## 🛠️ 3. คำสั่งจัดการพิเศษ (Utility Commands - รันจาก Root)

### 🖼️ คำสั่งย่อรูปภาพย้อนหลัง (CLI Thumbnail Backfill)
```bash
go run ./backend/cmd/generate-thumbnails
```
* **บังคับย่อรูปใหม่ทั้งหมด**: `go run ./backend/cmd/generate-thumbnails --force`

---

### 🧹 คำสั่งรีเซ็ตและล้างข้อมูลทั้งหมด (Reset Data)
```bash
./reset-data.sh
```

---

### 🧪 คำสั่งรัน Unit Tests (รันจาก Root)
```bash
go test -v ./backend/...
```
