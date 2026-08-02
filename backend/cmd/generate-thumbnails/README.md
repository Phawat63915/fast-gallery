# 🖼️ Thumbnail Backfill CLI Tool (`generate-thumbnails`)

เครื่องมือ CLI สำหรับ **สร้างภาพย่อย้อนหลัง (Backfill Thumbnails)** แบบประมวลผลขนานความเร็วสูงด้วย Go Worker Pool เหมาะสำหรับใช้ปรับปรุงรูปภาพที่อัปโหลดไว้ล่วงหน้าขณะที่ปิดใช้งานโหมด Thumbnail ให้กลับมาย่อเป็นภาพพรีวิวความละเอียด 400px (JPEG Quality 80%) โดยอัตโนมัติ

---

## 🚀 วิธีการใช้งาน (Quick Start)

เปิด Terminal เข้าไปยังโฟลเดอร์ `backend` แล้วรันคำสั่ง:

### 1. รันย่อรูปภาพย้อนหลังแบบปกติ
*(ระบบจะย่อเฉพาะรูปที่ยังไม่มี Thumbnail ในดิสก์)*
```bash
cd backend
go run ./cmd/generate-thumbnails
```

### 2. บังคับย่อรูปภาพใหม่ทั้งหมด (Force Mode)
*(ระบบจะสร้างภาพย่อทับของเดิมทั้งหมดทุกรูป)*
```bash
go run ./cmd/generate-thumbnails --force
```

---

## ⚙️ ตัวเลือกการตั้งค่าทั้งหมด (Command-Line Flags)

| Flag | ค่าเริ่มต้น (Default) | รายละเอียด |
| :--- | :--- | :--- |
| `--data-dir` | Auto-detect (`data` / `../data`) | กำหนด Path โฟลเดอร์ข้อมูลที่เก็บไฟล์และ SQLite Database |
| `--workers` | จำนวน CPU Cores | จำนวน Worker Threads (Goroutines) ประมวลผลขนานพร้อมกัน |
| `--max-dim` | `400` | ความกว้าง/ยาวสูงสุดของภาพย่อ (Pixels) |
| `--quality` | `80` | คุณภาพการบีบอัดไฟล์ JPEG (1 - 100%) |
| `--force` | `false` | บังคับสร้าง Thumbnail ใหม่ทับของเดิมทั้งหมด |

---

## 💡 ตัวอย่างการใช้งานตามสถานการณ์

### ย่อขนาดแบบเร่งด่วน ใช้ 16 เธรด (Custom Worker & Quality):
```bash
go run ./cmd/generate-thumbnails --workers=16 --max-dim=400 --quality=80
```

### ระบุ Data Directory ด้วยตัวเอง:
```bash
go run ./cmd/generate-thumbnails --data-dir=/root/server/git/fast-gallery/data
```

### บิลด์เป็นไฟล์ Executable Binary เพื่อนำไปใช้งานบนเซิร์ฟเวอร์อื่น:
```bash
# คอมไพล์เป็น Binary
go build -o generate-thumbs ./cmd/generate-thumbnails

# รันไฟล์ Binary ได้โดยไม่ต้องมี Go compiler
./generate-thumbs --force
```

---

## 🔍 กลไกการทำงาน (How It Works)

1. **Database Scanning**: เชื่อมต่อ SQLite Database อ่านรายการรูปภาพทั้งหมด
2. **File Validation**: ตรวจสอบรูปภาพบนดิสก์ที่ `uploads/originals/`
3. **BiLinear High-Speed Scaling**: ใช้เอนจิน `golang.org/x/image/draw` ย่อขนาดภาพให้ไม่เกิน 400px
4. **Database & Path Update**: บันทึกภาพลง `uploads/thumbnails/` และอัปเดตฟิลด์ `micro_url` ใน SQLite DB
5. **Summary Report**: แสดงสรุปสถิติเวลาและจำนวนรูปภาพที่ประมวลผลสำเร็จ

---

## 📊 ตัวอย่าง Output รายงานผล

```text
=== 🖼️ Fast Gallery Thumbnail Backfill CLI Tool ===
📍 Data Directory: /root/server/git/fast-gallery/data
⚡ Parallel Workers: 32 threads
📏 Target Size: Max 400px | JPEG Quality: 80%
📊 Total photos found in database: 500

==============================================
🎉 Thumbnail Backfill Operation Completed!
⏱️ Total Time Elapsed : 1.42s
📸 Total Photos DB    : 500
✨ Generated New      : 500
⏭️ Skipped (Already OK): 0
⚠️ Failed/Missing     : 0
⚡ Processing Speed   : 352.1 photos/sec
==============================================
```
