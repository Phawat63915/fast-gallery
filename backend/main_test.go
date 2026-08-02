package main

import (
	"bytes"
	"encoding/json"
	"fast-gallery/backend/db"
	"fast-gallery/backend/upload"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
)

func setupTestServer(t *testing.T) (*httptest.Server, string) {
	os.Setenv("DB_URL", "sqlite")
	tmpDir, err := os.MkdirTemp("", "test_gallery_api_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	database, err = db.InitDB(tmpDir)
	if err != nil {
		t.Fatalf("Failed to init test DB: %v", err)
	}

	pipeline, err = upload.NewPipeline(database, tmpDir, runtime.NumCPU())
	if err != nil {
		t.Fatalf("Failed to init test pipeline: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/photos", handleGetPhotos)
	mux.HandleFunc("/api/upload", handleUploadPhoto)
	mux.HandleFunc("/api/stats", handleGetStats)

	server := httptest.NewServer(mux)
	return server, tmpDir
}

func TestAPIStats(t *testing.T) {
	server, tmpDir := setupTestServer(t)
	defer server.Close()
	defer os.RemoveAll(tmpDir)

	resp, err := http.Get(server.URL + "/api/stats")
	if err != nil {
		t.Fatalf("Failed to GET /api/stats: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected HTTP 200, got %d", resp.StatusCode)
	}

	var stats map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		t.Fatalf("Failed to decode response JSON: %v", err)
	}

	if stats["status"] != "online" {
		t.Errorf("Expected status online, got %v", stats["status"])
	}

	if _, ok := stats["total_photos"]; !ok {
		t.Errorf("Expected total_photos field in stats response")
	}
}

func TestAPIGetPhotos(t *testing.T) {
	server, tmpDir := setupTestServer(t)
	defer server.Close()
	defer os.RemoveAll(tmpDir)

	resp, err := http.Get(server.URL + "/api/photos?limit=5")
	if err != nil {
		t.Fatalf("Failed to GET /api/photos: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected HTTP 200, got %d", resp.StatusCode)
	}

	var data struct {
		Photos     []db.Photo `json:"photos"`
		Count      int        `json:"count"`
		NextCursor int64      `json:"next_cursor"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatalf("Failed to decode photos response: %v", err)
	}

	if len(data.Photos) == 0 {
		t.Errorf("Expected photos list to contain items, got 0")
	}
}

func TestAPIUploadPhoto(t *testing.T) {
	server, tmpDir := setupTestServer(t)
	defer server.Close()
	defer os.RemoveAll(tmpDir)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("photos", "test_upload.jpg")
	if err != nil {
		t.Fatalf("Failed to create form file: %v", err)
	}
	part.Write([]byte("fake image binary content for test"))
	writer.Close()

	req, err := http.NewRequest("POST", server.URL+"/api/upload", body)
	if err != nil {
		t.Fatalf("Failed to create POST request: %v", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Failed to execute upload POST: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected HTTP 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("Failed to decode upload response: %v", err)
	}

	if result["success"] != true {
		t.Errorf("Expected success = true, got %v", result["success"])
	}

	// Clean up dummy test assets created during testing
	database.Exec("DELETE FROM photos WHERE id LIKE 'up_%' OR id LIKE 'test_%'")
}

func TestDisableThumbnailsOption(t *testing.T) {
	server, tmpDir := setupTestServer(t)
	defer server.Close()
	defer os.RemoveAll(tmpDir)

	disableThumbnails = true
	defer func() { disableThumbnails = false }()

	resp, err := http.Get(server.URL + "/api/photos?limit=5")
	if err != nil {
		t.Fatalf("Failed to GET /api/photos: %v", err)
	}
	defer resp.Body.Close()

	var data struct {
		Photos []db.Photo `json:"photos"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatalf("Failed to decode photos response: %v", err)
	}

	for _, photo := range data.Photos {
		if photo.Filename == "" {
			t.Errorf("Expected Filename to be non-empty, got empty string")
		}
	}
}
