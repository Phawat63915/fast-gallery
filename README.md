# FastGallery ⚡ (Go Backend + 5 Multi-Stack Frontends)

FastGallery เป็นโปรเจกต์สาธิตระบบคลังภาพถ่ายประสิทธิภาพสูงที่ถอดแบบสถาปัตยกรรมมาจาก **Immich** โดยแบ่งโครงสร้างหลังบ้าน (Backend) และหน้าบ้าน (Frontends) ออกจากกันอย่างสมบูรณ์

---

## 📁 โครงสร้างโปรเจกต์ (Clean Independent Architecture)

```
fast-gallery/
├── backend/                      # ซอร์สโค้ดภาษา Go (REST API + Upload Pipeline)
│   ├── go.mod
│   ├── main.go
│   ├── db/database.go            # PostgreSQL 16 & SQLite WAL Driver
│   └── upload/pipeline.go        # Goroutine Ingestion Queue
├── docker-compose.yml            # PostgreSQL 16 Service
│
├── frontends/                    # ซอร์สโค้ดหน้าบ้านทั้ง 5 รูปแบบ
│   ├── 1-vanilla-worker/         # 🔗 Port 8881 (Vanilla JS + Worker)
│   ├── 2-svelte/                 # 🔗 Port 8882 (Svelte 5 + Vite - Immich Choice)
│   ├── 3-vue/                    # 🔗 Port 8883 (Vue 3 + Vite)
│   ├── 4-react/                  # 🔗 Port 8884 (React 19 + Vite)
│   └── 5-vanilla-root/           # 🔗 Port 8885 (Vanilla Root Classic)
│
├── data/                         # ฐานข้อมูล PostgreSQL / SQLite WAL และไฟล์สื่อ
├── build.sh                      # สคริปต์คอมไพล์ Binary หลังบ้าน
├── run-all.sh                    # สคริปต์รันระบบทั้งหมด (Postgres + Go API + 5 Frontends)
├── run-dev.sh                    # สคริปต์รันโหมดพัฒนา
└── run-prod.sh                   # สคริปต์รันโหมดพรอดักชัน
```

---

## 🚀 การใช้งาน (Getting Started)

### สั่งรันระบบทั้งหมด (PostgreSQL + Go API + 5 Frontends)
```bash
./run-all.sh
```

### พอร์ตสำหรับการทดสอบ:
- **Go API Backend**: `http://localhost:8880`
- **Stack 1 (Vanilla JS + Worker)**: `http://localhost:8881`
- **Stack 2 (Svelte 5 - Immich Choice)**: `http://localhost:8882`
- **Stack 3 (Vue 3)**: `http://localhost:8883`
- **Stack 4 (React 19)**: `http://localhost:8884`
- **Stack 5 (Vanilla Root Classic)**: `http://localhost:8885`
