package upload

import (
	"fast-gallery/backend/db"
	"fmt"
	"image"

	"image/jpeg"
	_ "image/png"
	_ "golang.org/x/image/webp"
	"io"
	"log"
	"os"
	"os/exec"
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

func parseAVIFDimensions(r io.ReadSeeker) (int, int, error) {
	buf := make([]byte, 16384)
	n, err := r.Read(buf)
	if err != nil && err != io.EOF {
		return 0, 0, err
	}
	r.Seek(0, io.SeekStart)

	for i := 0; i < n-16; i++ {
		if buf[i] == 'i' && buf[i+1] == 's' && buf[i+2] == 'p' && buf[i+3] == 'e' {
			w := int(uint32(buf[i+8])<<24 | uint32(buf[i+9])<<16 | uint32(buf[i+10])<<8 | uint32(buf[i+11]))
			h := int(uint32(buf[i+12])<<24 | uint32(buf[i+13])<<16 | uint32(buf[i+14])<<8 | uint32(buf[i+15]))
			if w > 0 && w < 32000 && h > 0 && h < 32000 {
				return w, h, nil
			}
		}
	}
	return 0, 0, fmt.Errorf("ispe box not found in AVIF header")
}

func (p *Pipeline) processJob(job UploadJob) {
	file, err := os.Open(job.OriginalPath)
	if err != nil {
		log.Printf("Failed to open original asset %s: %v", job.OriginalPath, err)
		return
	}
	defer file.Close()

	width := 1920
	height := 1080
	aspectRatio := 1.777

	ext := filepath.Ext(job.OriginalPath)
	if len(ext) > 0 && ext[0] == '.' {
		ext = ext[1:]
	}
	extLower := filepath.Ext(job.OriginalPath)
	if len(extLower) > 0 {
		extLower = extLower[1:]
	}
	extLower = filepath.Ext(job.OriginalPath)

	if filepath.Ext(job.OriginalPath) == ".avif" || filepath.Ext(job.OriginalPath) == ".AVIF" {
		if w, h, err := parseAVIFDimensions(file); err == nil && w > 0 && h > 0 {
			width = w
			height = h
			aspectRatio = float64(width) / float64(height)
		}
	} else {
		cfg, _, err := image.DecodeConfig(file)
		if err == nil && cfg.Width > 0 && cfg.Height > 0 {
			width = cfg.Width
			height = cfg.Height
			aspectRatio = float64(width) / float64(height)
		}
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
	ext := filepath.Ext(srcPath)
	if ext == ".avif" || ext == ".AVIF" {
		// Use ffmpeg to resize AVIF thumbnail fast
		cmd := exec.Command("ffmpeg", "-y", "-i", srcPath, "-vf", fmt.Sprintf("scale=%d:-1", maxDim), dstPath)
		if err := cmd.Run(); err == nil {
			return nil
		}
	}

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
