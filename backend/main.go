package main

import (
	"encoding/json"
	"fast-gallery/backend/db"
	"fast-gallery/backend/upload"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

var (
	database  *db.DB
	pipeline  *upload.Pipeline
	startTime time.Time
)

func main() {
	startTime = time.Now()
	log.Println("Starting Immich FastGallery Server (Go Backend)...")

	// Determine data and frontend directories
	dataDir := findDir("data", "../data")
	frontendDir := findDir("frontend", "../frontend")

	log.Printf("Using Data Directory: %s", dataDir)
	log.Printf("Hosting Frontend Directory: %s", frontendDir)

	// 1. Initialize SQLite WAL Database
	var err error
	database, err = db.InitDB(dataDir)
	if err != nil {
		log.Fatalf("Fatal: Database initialization failed: %v", err)
	}

	// 2. Initialize Goroutine Upload Pipeline
	pipeline, err = upload.NewPipeline(database, dataDir, runtime.NumCPU())
	if err != nil {
		log.Fatalf("Fatal: Upload pipeline initialization failed: %v", err)
	}

	// 3. HTTP Server Routes
	mux := http.NewServeMux()

	// API Routes
	mux.HandleFunc("/api/photos", handleGetPhotos)
	mux.HandleFunc("/api/upload", handleUploadPhoto)
	mux.HandleFunc("/api/stats", handleGetStats)

	// Static Upload Media File Server with Immutable HTTP Cache Headers
	fileServer := http.FileServer(http.Dir(dataDir))
	mux.Handle("/uploads/", http.StripPrefix("/uploads/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("Accept-Ranges", "bytes")
		fileServer.ServeHTTP(w, r)
	})))

	// Frontend Static Files (Backend Hosts Frontend)
	publicServer := http.FileServer(http.Dir(frontendDir))
	mux.Handle("/", publicServer)

	port := 8880
	if envPort := os.Getenv("PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil {
			port = p
		}
	}
	log.Printf("🚀 FastGallery Go Backend API running at http://localhost:%d", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), mux); err != nil {
		log.Fatalf("Server stopped: %v", err)
	}
}

func findDir(names ...string) string {
	for _, name := range names {
		if _, err := os.Stat(name); err == nil {
			abs, err := filepath.Abs(name)
			if err == nil {
				return abs
			}
			return name
		}
	}
	// Fallback create default
	os.MkdirAll(names[0], 0755)
	return names[0]
}

func handleGetPhotos(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	cursorStr := r.URL.Query().Get("cursor")
	limitStr := r.URL.Query().Get("limit")

	var cursor int64 = 0
	limit := 100

	if cursorStr != "" {
		cursor, _ = strconv.ParseInt(cursorStr, 10, 64)
	}
	if limitStr != "" {
		limit, _ = strconv.Atoi(limitStr)
	}

	photos, err := database.GetPhotos(cursor, limit)
	if err != nil {
		http.Error(w, fmt.Sprintf("Query error: %v", err), http.StatusInternalServerError)
		return
	}

	var nextCursor int64 = 0
	if len(photos) > 0 {
		nextCursor = photos[len(photos)-1].CreatedAt
	}

	response := map[string]interface{}{
		"photos":      photos,
		"count":       len(photos),
		"next_cursor": nextCursor,
	}

	json.NewEncoder(w).Encode(response)
}

func handleUploadPhoto(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	err := r.ParseMultipartForm(100 << 20)
	if err != nil {
		http.Error(w, "File upload too large", http.StatusBadRequest)
		return
	}

	files := r.MultipartForm.File["photos"]
	if len(files) == 0 {
		files = r.MultipartForm.File["file"]
	}

	if len(files) == 0 {
		http.Error(w, "No photo file provided", http.StatusBadRequest)
		return
	}

	uploadedIDs := make([]string, 0, len(files))

	for i, fileHeader := range files {
		file, err := fileHeader.Open()
		if err != nil {
			log.Printf("Error opening uploaded file: %v", err)
			continue
		}
		defer file.Close()

		id := fmt.Sprintf("up_%d_%d", time.Now().UnixNano(), i)
		ext := filepath.Ext(fileHeader.Filename)
		if ext == "" {
			ext = ".jpg"
		}
		targetPath := filepath.Join(pipeline.GetUploadDir(), id+ext)

		out, err := os.Create(targetPath)
		if err != nil {
			log.Printf("Error creating target file %s: %v", targetPath, err)
			continue
		}

		_, err = io.Copy(out, file)
		out.Close()

		if err != nil {
			log.Printf("Error saving file content: %v", err)
			continue
		}

		pipeline.Enqueue(upload.UploadJob{
			ID:           id,
			Filename:     fileHeader.Filename,
			OriginalPath: targetPath,
			CreatedAt:    time.Now(),
		})

		uploadedIDs = append(uploadedIDs, id)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   len(uploadedIDs),
		"ids":     uploadedIDs,
		"message": "Upload accepted! Background Goroutine pipeline is generating thumbnails & Thumbhash.",
	})
}

func handleGetStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	count, _ := database.GetPhotoCount()

	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	response := map[string]interface{}{
		"status":       "online",
		"engine":       "Go 1.26 + SQLite WAL + Web Worker Virtualization",
		"total_photos": count,
		"alloc_ram_mb": fmt.Sprintf("%.2f MB", float64(m.Alloc)/1024/1024),
		"sys_ram_mb":   fmt.Sprintf("%.2f MB", float64(m.Sys)/1024/1024),
		"goroutines":   runtime.NumGoroutine(),
		"uptime_sec":   int(time.Since(startTime).Seconds()),
	}

	json.NewEncoder(w).Encode(response)
}
