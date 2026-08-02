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
	Filename    string  `json:"filename"`
	CreatedAt   int64   `json:"created_at"`
	AspectRatio float64 `json:"aspect_ratio"`
}

type DB struct {
	conn           *sql.DB
	driver         string
	mu             sync.RWMutex
	dummiesCleaned bool
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
		sqliteDir := filepath.Join(dataDir, "sqlite")
		if err := os.MkdirAll(sqliteDir, 0755); err != nil {
			return nil, err
		}
		dbPath := filepath.Join(sqliteDir, "gallery.db")
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
			filename TEXT NOT NULL,
			created_at BIGINT NOT NULL,
			aspect_ratio DOUBLE PRECISION NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_photos_created_at ON photos (created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_photos_created_id ON photos (created_at DESC, id);
		`
	} else {
		schema = `
		CREATE TABLE IF NOT EXISTS photos (
			id TEXT PRIMARY KEY,
			filename TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			aspect_ratio REAL NOT NULL
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
			query := `SELECT id, filename, created_at, aspect_ratio FROM photos WHERE created_at < $1 ORDER BY created_at DESC LIMIT $2`
			rows, err = db.conn.Query(query, cursor, limit)
		} else {
			query := `SELECT id, filename, created_at, aspect_ratio FROM photos ORDER BY created_at DESC LIMIT $1`
			rows, err = db.conn.Query(query, limit)
		}
	} else {
		if cursor > 0 {
			query := `SELECT id, filename, created_at, aspect_ratio FROM photos WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`
			rows, err = db.conn.Query(query, cursor, limit)
		} else {
			query := `SELECT id, filename, created_at, aspect_ratio FROM photos ORDER BY created_at DESC LIMIT ?`
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
		err := rows.Scan(&p.ID, &p.Filename, &p.CreatedAt, &p.AspectRatio)
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

	// Auto-cleanup dummy benchmark photos (photo_%) only ONCE on first real photo upload
	if !db.dummiesCleaned && strings.HasPrefix(p.ID, "up_") {
		_, _ = db.conn.Exec(`DELETE FROM photos WHERE id LIKE 'photo_%'`)
		db.dummiesCleaned = true
	}

	var query string
	if db.driver == "postgres" {
		query = `INSERT INTO photos (id, filename, created_at, aspect_ratio)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET
		filename=EXCLUDED.filename, created_at=EXCLUDED.created_at, aspect_ratio=EXCLUDED.aspect_ratio`
	} else {
		query = `INSERT OR REPLACE INTO photos (id, filename, created_at, aspect_ratio) VALUES (?, ?, ?, ?)`
	}

	_, err := db.conn.Exec(query, p.ID, p.Filename, p.CreatedAt, p.AspectRatio)
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

func (db *DB) SeedBenchmarkPhotos(count int) {
	tx, err := db.conn.Begin()
	if err != nil {
		log.Printf("Failed to start transaction: %v", err)
		return
	}

	var stmt *sql.Stmt
	if db.driver == "postgres" {
		stmt, err = tx.Prepare(`INSERT INTO photos (id, filename, created_at, aspect_ratio) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`)
	} else {
		stmt, err = tx.Prepare(`INSERT OR REPLACE INTO photos (id, filename, created_at, aspect_ratio) VALUES (?, ?, ?, ?)`)
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
		filename := fmt.Sprintf("photo_%06d.jpg", i+1)
		createdAt := now - int64(i*1800000+rand.Intn(300000))
		ar := aspectRatios[i%len(aspectRatios)]

		_, err := stmt.Exec(id, filename, createdAt, ar)
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
