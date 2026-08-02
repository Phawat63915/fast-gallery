package main

import (
	"fast-gallery/backend/db"
	"fast-gallery/backend/upload"
	"flag"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	var (
		dataDirFlag string
		workersFlag int
		maxDimFlag  int
		qualityFlag int
		forceFlag   bool
	)

	flag.StringVar(&dataDirFlag, "data-dir", "", "Path to data directory (default: auto-detect data or ../data)")
	flag.IntVar(&workersFlag, "workers", runtime.NumCPU(), "Number of parallel worker threads for resizing")
	flag.IntVar(&maxDimFlag, "max-dim", 400, "Maximum dimension (width/height) for thumbnails in pixels")
	flag.IntVar(&qualityFlag, "quality", 80, "JPEG quality for generated thumbnails (1-100)")
	flag.BoolVar(&forceFlag, "force", false, "Force regeneration of thumbnails even if they already exist")
	flag.Parse()

	startTime := time.Now()
	log.Println("=== 🖼️ Fast Gallery Thumbnail Backfill CLI Tool ===")

	dataDir := dataDirFlag
	if dataDir == "" {
		dataDir = findDir("data", "../data")
	}
	dataDir, err := filepath.Abs(dataDir)
	if err != nil {
		log.Fatalf("Error finding data directory: %v", err)
	}

	log.Printf("📍 Data Directory: %s", dataDir)
	log.Printf("⚡ Parallel Workers: %d threads", workersFlag)
	log.Printf("📏 Target Size: Max %dpx | JPEG Quality: %d%%", maxDimFlag, qualityFlag)
	if forceFlag {
		log.Println("🔄 Force Mode: Enabled (overwriting existing thumbnails)")
	}

	database, err := db.InitDB(dataDir)
	if err != nil {
		log.Fatalf("Fatal: Database initialization failed: %v", err)
	}
	defer database.Close()

	thumbDir := filepath.Join(dataDir, "uploads", "thumbnails")
	origDir := filepath.Join(dataDir, "uploads", "originals")

	if err := os.MkdirAll(thumbDir, 0755); err != nil {
		log.Fatalf("Fatal: Failed to create thumbnails directory: %v", err)
	}

	photos, err := database.GetPhotos(0, 1000000)
	if err != nil {
		log.Fatalf("Fatal: Failed to query photos from database: %v", err)
	}

	totalPhotos := len(photos)
	log.Printf("📊 Total photos found in database: %d", totalPhotos)

	if totalPhotos == 0 {
		log.Println("✅ No photos found in database. Nothing to process!")
		return
	}

	type Job struct {
		Photo db.Photo
	}

	jobs := make(chan Job, totalPhotos)
	var processedCount int64
	var skippedCount int64
	var failedCount int64

	var wg sync.WaitGroup

	for w := 1; w <= workersFlag; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for job := range jobs {
				photo := job.Photo
				thumbFilename := photo.Filename
				thumbPath := filepath.Join(thumbDir, thumbFilename)
				origPath := filepath.Join(origDir, photo.Filename)

				if !forceFlag {
					if _, err := os.Stat(thumbPath); err == nil {
						atomic.AddInt64(&skippedCount, 1)
						continue
					}
				}

				if _, err := os.Stat(origPath); err != nil {
					log.Printf("⚠️ Warning: Original file not found on disk for photo %s (%s)", photo.ID, origPath)
					atomic.AddInt64(&failedCount, 1)
					continue
				}

				if err := upload.CreateResizedThumbnail(origPath, thumbPath, maxDimFlag, qualityFlag); err != nil {
					log.Printf("❌ Error: Failed to create thumbnail for photo %s: %v", photo.ID, err)
					atomic.AddInt64(&failedCount, 1)
					continue
				}

				currentProcessed := atomic.AddInt64(&processedCount, 1)
				if currentProcessed%10 == 0 || currentProcessed == int64(totalPhotos) {
					log.Printf("⏳ Processed %d / %d thumbnails...", currentProcessed, totalPhotos)
				}
			}
		}(w)
	}

	for _, photo := range photos {
		jobs <- Job{Photo: photo}
	}
	close(jobs)

	wg.Wait()

	duration := time.Since(startTime)
	log.Println("\n==============================================")
	log.Println("🎉 Thumbnail Backfill Operation Completed!")
	log.Printf("⏱️ Total Time Elapsed : %v", duration.Round(time.Millisecond))
	log.Printf("📸 Total Photos DB    : %d", totalPhotos)
	log.Printf("✨ Generated New      : %d", processedCount)
	log.Printf("⏭️ Skipped (Already OK): %d", skippedCount)
	log.Printf("⚠️ Failed/Missing     : %d", failedCount)
	if duration.Seconds() > 0 {
		log.Printf("⚡ Processing Speed   : %.1f photos/sec", float64(processedCount)/duration.Seconds())
	}
	log.Println("==============================================")
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
