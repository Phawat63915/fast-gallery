package db

import (
	"database/sql"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/lib/pq"
	_ "modernc.org/sqlite"
)

type Photo struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	CreatedAt   int64   `json:"created_at"`
	AspectRatio float64 `json:"aspect_ratio"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	Thumbhash   string  `json:"thumbhash"`
	MicroURL    string  `json:"micro_url"`
	OriginalURL string  `json:"original_url"`
	CameraMake  string  `json:"camera_make"`
	CameraModel string  `json:"camera_model"`
	ISO         int     `json:"iso"`
	FocalLength string  `json:"focal_length"`
}

type DB struct {
	conn   *sql.DB
	driver string
	mu     sync.RWMutex
}

func InitDB(dataDir string) (*DB, error) {
	dbURL := os.Getenv("DB_URL")
	driver := "postgres"

	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@localhost:5432/fastgallery?sslmode=disable"
	}

	var conn *sql.DB
	var err error

	if strings.HasPrefix(dbURL, "postgres://") || strings.HasPrefix(dbURL, "postgresql://") {
		driver = "postgres"
		log.Printf("Connecting to PostgreSQL database...")
		conn, err = sql.Open("postgres", dbURL)
		if err == nil {
			conn.SetMaxOpenConns(50)
			conn.SetMaxIdleConns(25)
			conn.SetConnMaxLifetime(5 * time.Minute)
			err = conn.Ping()
		}
		if err != nil {
			log.Printf("Warning: Could not connect to PostgreSQL (%v). Falling back to SQLite WAL...", err)
			driver = "sqlite"
		}
	} else {
		driver = "sqlite"
	}

	if driver == "sqlite" {
		if err := os.MkdirAll(dataDir, 0755); err != nil {
			return nil, err
		}
		dbPath := filepath.Join(dataDir, "gallery.db")
		conn, err = sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)")
		if err != nil {
			return nil, fmt.Errorf("failed to open sqlite db: %w", err)
		}
		pragmas := []string{
			"PRAGMA journal_mode=WAL;",
			"PRAGMA synchronous=NORMAL;",
			"PRAGMA temp_store=MEMORY;",
		}
		for _, pragma := range pragmas {
			conn.Exec(pragma)
		}
	}

	database := &DB{conn: conn, driver: driver}

	if err := database.migrateSchema(); err != nil {
		return nil, fmt.Errorf("migration error: %w", err)
	}

	count, err := database.GetPhotoCount()
	if err == nil && count == 0 {
		log.Printf("Database (%s) is empty. Seeding 500 benchmark photo entries...", driver)
		database.SeedBenchmarkPhotos(500)
	}

	return database, nil
}

func (db *DB) GetDriverName() string {
	return db.driver
}

func (db *DB) migrateSchema() error {
	var schema string
	if db.driver == "postgres" {
		schema = `
		CREATE TABLE IF NOT EXISTS photos (
			id VARCHAR(255) PRIMARY KEY,
			title TEXT NOT NULL,
			created_at BIGINT NOT NULL,
			aspect_ratio DOUBLE PRECISION NOT NULL,
			width INT NOT NULL,
			height INT NOT NULL,
			thumbhash TEXT NOT NULL,
			micro_url TEXT NOT NULL,
			original_url TEXT NOT NULL,
			camera_make TEXT,
			camera_model TEXT,
			iso INT,
			focal_length TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_photos_created_at ON photos (created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_photos_created_id ON photos (created_at DESC, id);
		CREATE EXTENSION IF NOT EXISTS pg_trgm;
		CREATE INDEX IF NOT EXISTS idx_photos_title_trgm ON photos USING gin (title gin_trgm_ops);
		`
	} else {
		schema = `
		CREATE TABLE IF NOT EXISTS photos (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			aspect_ratio REAL NOT NULL,
			width INTEGER NOT NULL,
			height INTEGER NOT NULL,
			thumbhash TEXT NOT NULL,
			micro_url TEXT NOT NULL,
			original_url TEXT NOT NULL,
			camera_make TEXT,
			camera_model TEXT,
			iso INTEGER,
			focal_length TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_photos_created_at ON photos (created_at DESC);
		`
	}

	_, err := db.conn.Exec(schema)
	return err
}

func (db *DB) GetPhotos(cursor int64, limit int) ([]Photo, error) {
	db.mu.RLock()
	defer db.mu.RUnlock()

	if limit <= 0 || limit > 500 {
		limit = 200
	}

	var rows *sql.Rows
	var err error

	if db.driver == "postgres" {
		if cursor > 0 {
			query := `SELECT id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length 
					  FROM photos WHERE created_at < $1 ORDER BY created_at DESC LIMIT $2`
			rows, err = db.conn.Query(query, cursor, limit)
		} else {
			query := `SELECT id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length 
					  FROM photos ORDER BY created_at DESC LIMIT $1`
			rows, err = db.conn.Query(query, limit)
		}
	} else {
		if cursor > 0 {
			query := `SELECT id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length 
					  FROM photos WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`
			rows, err = db.conn.Query(query, cursor, limit)
		} else {
			query := `SELECT id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length 
					  FROM photos ORDER BY created_at DESC LIMIT ?`
			rows, err = db.conn.Query(query, limit)
		}
	}

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	photos := make([]Photo, 0, limit)
	for rows.Next() {
		var p Photo
		err := rows.Scan(
			&p.ID, &p.Title, &p.CreatedAt, &p.AspectRatio, &p.Width, &p.Height,
			&p.Thumbhash, &p.MicroURL, &p.OriginalURL, &p.CameraMake, &p.CameraModel,
			&p.ISO, &p.FocalLength,
		)
		if err != nil {
			return nil, err
		}
		photos = append(photos, p)
	}

	return photos, nil
}

func (db *DB) InsertPhoto(p Photo) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	var query string
	if db.driver == "postgres" {
		query = `INSERT INTO photos 
		(id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (id) DO UPDATE SET
		title=EXCLUDED.title, created_at=EXCLUDED.created_at, aspect_ratio=EXCLUDED.aspect_ratio,
		width=EXCLUDED.width, height=EXCLUDED.height, thumbhash=EXCLUDED.thumbhash,
		micro_url=EXCLUDED.micro_url, original_url=EXCLUDED.original_url,
		camera_make=EXCLUDED.camera_make, camera_model=EXCLUDED.camera_model,
		iso=EXCLUDED.iso, focal_length=EXCLUDED.focal_length`
	} else {
		query = `INSERT OR REPLACE INTO photos 
		(id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	}

	_, err := db.conn.Exec(query,
		p.ID, p.Title, p.CreatedAt, p.AspectRatio, p.Width, p.Height,
		p.Thumbhash, p.MicroURL, p.OriginalURL, p.CameraMake, p.CameraModel,
		p.ISO, p.FocalLength,
	)
	return err
}

func (db *DB) GetPhotoCount() (int, error) {
	db.mu.RLock()
	defer db.mu.RUnlock()

	var count int
	err := db.conn.QueryRow("SELECT COUNT(*) FROM photos").Scan(&count)
	return count, err
}

func (db *DB) Exec(query string, args ...interface{}) (sql.Result, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.conn.Exec(query, args...)
}

func (db *DB) Close() error {
	return db.conn.Close()
}

var sampleThumbhashes = []string{
	"1QcSHQR2d3l/iHiHeHeAePh2d3h4",
	"3PcJJQJ2h4d/iHiId3eAePiGeHh4",
	"1gcJHQR2eHeAiHiHeHeAePh2e3h4",
	"3QcKLQJ2d3h/eHiIeHeAePiGeHh4",
	"1AcSHQR2eHd/iHiHeHeAePh2d3h4",
}

var sampleCameras = [][]string{
	{"Sony", "A7 IV", "24mm f/1.4", "100"},
	{"Canon", "EOS R5", "50mm f/1.2", "200"},
	{"Fujifilm", "X-T5", "35mm f/1.4", "160"},
	{"Nikon", "Z8", "85mm f/1.8", "400"},
	{"Leica", "M11", "35mm f/2.0", "100"},
}

var sampleImageURLs = []string{
	"https://images.unsplash.com/photo-1506744038136-46273834b3fb",
	"https://images.unsplash.com/photo-1511884642898-4c92249e20b6",
	"https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05",
	"https://images.unsplash.com/photo-1441974231531-c6227db76b6e",
	"https://images.unsplash.com/photo-1472214103451-9374bd1c798e",
	"https://images.unsplash.com/photo-1469474968028-56623f02e42e",
	"https://images.unsplash.com/photo-1501785888041-af3ef285b470",
	"https://images.unsplash.com/photo-1447752875215-b2761acb3c5d",
	"https://images.unsplash.com/photo-1532274402911-5a369e4c4bb5",
	"https://images.unsplash.com/photo-1507525428034-b723cf961d3e",
}

func (db *DB) SeedBenchmarkPhotos(count int) {
	tx, err := db.conn.Begin()
	if err != nil {
		log.Printf("Failed to start transaction: %v", err)
		return
	}

	var stmt *sql.Stmt
	if db.driver == "postgres" {
		stmt, err = tx.Prepare(`INSERT INTO photos 
		(id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (id) DO NOTHING`)
	} else {
		stmt, err = tx.Prepare(`INSERT OR REPLACE INTO photos 
		(id, title, created_at, aspect_ratio, width, height, thumbhash, micro_url, original_url, camera_make, camera_model, iso, focal_length)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	}

	if err != nil {
		log.Printf("Failed to prepare statement: %v", err)
		tx.Rollback()
		return
	}
	defer stmt.Close()

	now := time.Now().UnixMilli()
	aspectRatios := []float64{1.333, 1.5, 0.75, 1.777, 0.8, 1.0, 1.25, 0.666}

	for i := 0; i < count; i++ {
		id := fmt.Sprintf("photo_%06d", i+1)
		title := fmt.Sprintf("Immich Fast Shot #%d", i+1)
		createdAt := now - int64(i*1800000+rand.Intn(300000))
		ar := aspectRatios[i%len(aspectRatios)]
		width := 1920
		height := int(float64(width) / ar)
		thumbhash := sampleThumbhashes[i%len(sampleThumbhashes)]
		
		imgBase := sampleImageURLs[i%len(sampleImageURLs)]
		microURL := fmt.Sprintf("%s?auto=format&fit=crop&w=400&q=80", imgBase)
		originalURL := fmt.Sprintf("%s?auto=format&fit=crop&w=1920&q=90", imgBase)

		camInfo := sampleCameras[i%len(sampleCameras)]
		isoVal := 100
		fmt.Sscanf(camInfo[3], "%d", &isoVal)

		_, err := stmt.Exec(
			id, title, createdAt, ar, width, height,
			thumbhash, microURL, originalURL, camInfo[0], camInfo[1], isoVal, camInfo[2],
		)
		if err != nil {
			log.Printf("Error seeding item %d: %v", i, err)
		}
	}

	if err := tx.Commit(); err != nil {
		log.Printf("Transaction commit failed: %v", err)
	} else {
		log.Printf("Successfully seeded %d benchmark photo entries into PostgreSQL!", count)
	}
}
