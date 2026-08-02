package upload

import (
	"fast-gallery/backend/db"
	"fmt"
	"image"

	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"

	xdraw "golang.org/x/image/draw"
)

type UploadJob struct {
	ID           string
	Filename     string
	OriginalPath string
	CreatedAt    time.Time
}

type Pipeline struct {
	database          *db.DB
	uploadDir         string
	thumbDir          string
	jobChan           chan UploadJob
	workers           int
	disableThumbnails bool
}

func NewPipeline(database *db.DB, baseDir string, numWorkers int, disableThumbnails ...bool) (*Pipeline, error) {
	uploadDir := filepath.Join(baseDir, "uploads", "originals")
	thumbDir := filepath.Join(baseDir, "uploads", "thumbnails")

	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(thumbDir, 0755); err != nil {
		return nil, err
	}

	isDisabled := false
	if len(disableThumbnails) > 0 {
		isDisabled = disableThumbnails[0]
	}

	p := &Pipeline{
		database:          database,
		uploadDir:         uploadDir,
		thumbDir:          thumbDir,
		jobChan:           make(chan UploadJob, 100),
		workers:           numWorkers,
		disableThumbnails: isDisabled,
	}

	p.startWorkers()
	return p, nil
}

func (p *Pipeline) startWorkers() {
	for i := 0; i < p.workers; i++ {
		go func(workerID int) {
			for job := range p.jobChan {
				p.processJob(job)
			}
		}(i + 1)
	}
}

func (p *Pipeline) Enqueue(job UploadJob) {
	p.jobChan <- job
}

func (p *Pipeline) processJob(job UploadJob) {
	file, err := os.Open(job.OriginalPath)
	if err != nil {
		log.Printf("Failed to open original asset %s: %v", job.OriginalPath, err)
		return
	}
	defer file.Close()

	cfg, _, err := image.DecodeConfig(file)
	width := 1920
	height := 1080
	aspectRatio := 1.777

	if err == nil && cfg.Width > 0 && cfg.Height > 0 {
		width = cfg.Width
		height = cfg.Height
		aspectRatio = float64(width) / float64(height)
	}

	filename := filepath.Base(job.OriginalPath)

	if !p.disableThumbnails {
		thumbFilename := filepath.Base(job.OriginalPath)
		thumbPath := filepath.Join(p.thumbDir, thumbFilename)

		err := CreateResizedThumbnail(job.OriginalPath, thumbPath, 400, 80)
		if err != nil {
			srcFile, err := os.Open(job.OriginalPath)
			if err == nil {
				dstFile, err := os.Create(thumbPath)
				if err == nil {
					io.Copy(dstFile, srcFile)
					dstFile.Close()
				}
				srcFile.Close()
			}
		}
	}

	photo := db.Photo{
		ID:          job.ID,
		Filename:    filename,
		CreatedAt:   job.CreatedAt.UnixMilli(),
		AspectRatio: aspectRatio,
	}

	if err := p.database.InsertPhoto(photo); err != nil {
		log.Printf("Failed to insert uploaded photo to DB: %v", err)
	}
}

func CreateResizedThumbnail(srcPath string, dstPath string, maxDim int, quality int) error {
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	srcImg, _, err := image.Decode(srcFile)
	if err != nil {
		return err
	}

	bounds := srcImg.Bounds()
	origW := bounds.Dx()
	origH := bounds.Dy()

	if origW <= 0 || origH <= 0 {
		return fmt.Errorf("invalid image bounds")
	}

	targetW := origW
	targetH := origH

	if origW > maxDim || origH > maxDim {
		if origW > origH {
			targetW = maxDim
			targetH = int(float64(origH) * float64(maxDim) / float64(origW))
		} else {
			targetH = maxDim
			targetW = int(float64(origW) * float64(maxDim) / float64(origH))
		}
	}

	if targetW <= 0 {
		targetW = 1
	}
	if targetH <= 0 {
		targetH = 1
	}

	dstImg := image.NewRGBA(image.Rect(0, 0, targetW, targetH))
	xdraw.BiLinear.Scale(dstImg, dstImg.Bounds(), srcImg, bounds, xdraw.Over, nil)

	dstFile, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	return jpeg.Encode(dstFile, dstImg, &jpeg.Options{Quality: quality})
}

func (p *Pipeline) GetUploadDir() string {
	return p.uploadDir
}
