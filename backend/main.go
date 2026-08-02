package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fast-gallery/backend/db"
	"fast-gallery/backend/upload"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	xdraw "golang.org/x/image/draw"
)

var (
	database          *db.DB
	pipeline          *upload.Pipeline
	startTime         time.Time
	disableThumbnails bool

	// Sub-millisecond JSON Response Cache for /api/photos
	apiCacheMutex sync.RWMutex
	apiCache      = make(map[string][]byte)

	// In-memory On-The-Fly Thumbnail Cache when DISABLE_THUMBNAILS=true
	thumbCacheMutex sync.RWMutex
	thumbCache      = make(map[string][]byte)
)

func main() {
	startTime = time.Now()
	log.Println("Starting Immich FastGallery Server (High-Performance Go Backend)...")

	loadDotEnv()

	disableThumbnails = os.Getenv("DISABLE_THUMBNAILS") == "true"
	if disableThumbnails {
		log.Println("⚡ Config Enabled: DISABLE_THUMBNAILS=true -> Serving original images as micro_url directly!")
	}

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = findDir("data", "../data")
	}
	frontendDir := os.Getenv("FRONTEND_DIR")
	if frontendDir == "" {
		frontendDir = findDir("frontends/1-vanilla-worker", "../frontends/1-vanilla-worker")
	} else if abs, err := filepath.Abs(frontendDir); err == nil {
		frontendDir = abs
	}

	log.Printf("Using Data Directory: %s", dataDir)
	log.Printf("Hosting Frontend Directory: %s", frontendDir)

	var err error
	database, err = db.InitDB(dataDir)
	if err != nil {
		log.Fatalf("Fatal: Database initialization failed: %v", err)
	}

	pipeline, err = upload.NewPipeline(database, dataDir, runtime.NumCPU(), disableThumbnails)
	if err != nil {
		log.Fatalf("Fatal: Upload pipeline initialization failed: %v", err)
	}

	mux := http.NewServeMux()

	// High-performance API endpoints with CORS and Gzip support
	mux.HandleFunc("/api/photos", corsMiddleware(handleGetPhotos))
	mux.HandleFunc("/api/photos/url", corsMiddleware(handleAddPhotoURL))
	mux.HandleFunc("/api/upload", corsMiddleware(handleUploadPhoto))
	mux.HandleFunc("/api/stats", corsMiddleware(handleGetStats))

	// Static Upload Media File Server with Immutable 1-Year Cache & Fast Byte-Range Support
	uploadsDir := filepath.Join(dataDir, "uploads")
	_ = os.MkdirAll(filepath.Join(uploadsDir, "originals"), 0755)
	_ = os.MkdirAll(filepath.Join(uploadsDir, "thumbnails"), 0755)
	_ = os.MkdirAll(filepath.Join(dataDir, "sqlite"), 0755)
	_ = os.MkdirAll(filepath.Join(dataDir, "postgres"), 0755)
	fileServer := http.FileServer(http.Dir(uploadsDir))
	mux.Handle("/uploads/", http.StripPrefix("/uploads/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Timing-Allow-Origin", "*")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		if disableThumbnails && strings.HasPrefix(r.URL.Path, "thumbnails/") {
			relPath := strings.TrimPrefix(r.URL.Path, "thumbnails/")
			originalFilePath := filepath.Join(uploadsDir, "originals", relPath)
			if _, err := os.Stat(originalFilePath); err == nil {
				if thumbBytes, err := getOrGenerateOnTheFlyThumb(originalFilePath); err == nil {
					w.Header().Set("Content-Type", "image/jpeg")
					w.Header().Set("Content-Length", strconv.Itoa(len(thumbBytes)))
					w.Write(thumbBytes)
					return
				}
				http.ServeFile(w, r, originalFilePath)
				return
			}
		}

		fileServer.ServeHTTP(w, r)
	})))

	// Frontend Static Files
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

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
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
	os.MkdirAll(names[0], 0755)
	return names[0]
}

func invalidateAPICache() {
	apiCacheMutex.Lock()
	apiCache = make(map[string][]byte)
	apiCacheMutex.Unlock()
}

func handleGetPhotos(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Vary", "Accept-Encoding")

	cursorStr := r.URL.Query().Get("cursor")
	limitStr := r.URL.Query().Get("limit")

	cacheKey := fmt.Sprintf("photos_%s_%s", cursorStr, limitStr)

	// Sub-millisecond Cache Check
	apiCacheMutex.RLock()
	cachedBytes, exists := apiCache[cacheKey]
	apiCacheMutex.RUnlock()

	if exists {
		writeGzipResponse(w, r, cachedBytes)
		return
	}

	var cursor int64 = 0
	limit := 200

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

	jsonBytes, err := json.Marshal(response)
	if err != nil {
		http.Error(w, "JSON error", http.StatusInternalServerError)
		return
	}

	// Cache JSON in memory
	apiCacheMutex.Lock()
	apiCache[cacheKey] = jsonBytes
	apiCacheMutex.Unlock()

	writeGzipResponse(w, r, jsonBytes)
}

func writeGzipResponse(w http.ResponseWriter, r *http.Request, data []byte) {
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		gz.Write(data)
	} else {
		w.Write(data)
	}
}

func handleUploadPhoto(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	err := r.ParseMultipartForm(500 << 20) // 500MB batch upload buffer
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

	invalidateAPICache()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   len(uploadedIDs),
		"ids":     uploadedIDs,
		"message": "Upload accepted! Background Goroutine pipeline is generating thumbnails & Thumbhash.",
	})
}

func handleAddPhotoURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		URL         string  `json:"url"`
		AspectRatio float64 `json:"aspect_ratio"`
		Width       int     `json:"width"`
		Height      int     `json:"height"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		http.Error(w, "Invalid request body or missing url", http.StatusBadRequest)
		return
	}

	if req.AspectRatio <= 0 {
		req.AspectRatio = 1.5
	}

	photoID := fmt.Sprintf("custom_%d", time.Now().UnixNano())
	photo := db.Photo{
		ID:          photoID,
		Filename:    req.URL,
		CreatedAt:   time.Now().UnixMilli(),
		AspectRatio: req.AspectRatio,
	}

	if err := database.InsertPhoto(photo); err != nil {
		http.Error(w, fmt.Sprintf("Database insert failed: %v", err), http.StatusInternalServerError)
		return
	}

	invalidateAPICache()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"id":      photoID,
		"photo":   photo,
	})
}

func handleGetStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

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

func loadDotEnv() {
	envPaths := []string{".env", "../.env", filepath.Join("..", ".env")}
	for _, path := range envPaths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		log.Printf("📄 Loaded configuration from %s", path)
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 {
				continue
			}
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			if (strings.HasPrefix(val, "\"") && strings.HasSuffix(val, "\"")) ||
				(strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'")) {
				val = val[1 : len(val)-1]
			}
			if os.Getenv(key) == "" {
				os.Setenv(key, val)
			}
		}
		break
	}
}

func getOrGenerateOnTheFlyThumb(originalFilePath string) ([]byte, error) {
	thumbCacheMutex.RLock()
	cached, exists := thumbCache[originalFilePath]
	thumbCacheMutex.RUnlock()

	if exists {
		return cached, nil
	}

	srcFile, err := os.Open(originalFilePath)
	if err != nil {
		return nil, err
	}
	defer srcFile.Close()

	srcImg, _, err := image.Decode(srcFile)
	if err != nil {
		return nil, err
	}

	bounds := srcImg.Bounds()
	origW := bounds.Dx()
	origH := bounds.Dy()
	if origW <= 0 || origH <= 0 {
		return nil, fmt.Errorf("invalid image bounds")
	}

	maxDim := 400
	targetW := maxDim
	targetH := maxDim
	if origW > origH {
		targetH = int(float64(origH) * float64(maxDim) / float64(origW))
	} else {
		targetW = int(float64(origW) * float64(maxDim) / float64(origH))
	}
	if targetW <= 0 {
		targetW = 1
	}
	if targetH <= 0 {
		targetH = 1
	}

	dstImg := image.NewRGBA(image.Rect(0, 0, targetW, targetH))
	xdraw.BiLinear.Scale(dstImg, dstImg.Bounds(), srcImg, bounds, xdraw.Over, nil)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dstImg, &jpeg.Options{Quality: 80}); err != nil {
		return nil, err
	}

	resBytes := buf.Bytes()

	thumbCacheMutex.Lock()
	if len(thumbCache) > 5000 {
		thumbCache = make(map[string][]byte)
	}
	thumbCache[originalFilePath] = resBytes
	thumbCacheMutex.Unlock()

	return resBytes, nil
}
