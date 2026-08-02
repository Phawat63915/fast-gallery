package db

import (
	"os"
	"testing"
	"time"
)

func TestInitDBAndSchema(t *testing.T) {
	os.Setenv("DB_URL", "sqlite")
	tmpDir, err := os.MkdirTemp("", "test_gallery_db_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	database, err := InitDB(tmpDir)
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer database.Close()

	if database.GetDriverName() == "" {
		t.Errorf("Expected valid driver name, got empty string")
	}

	count, err := database.GetPhotoCount()
	if err != nil {
		t.Fatalf("GetPhotoCount failed: %v", err)
	}

	if count < 500 {
		t.Errorf("Expected at least 500 seeded photos, got %d", count)
	}
}

func TestInsertAndQueryPhoto(t *testing.T) {
	os.Setenv("DB_URL", "sqlite")
	tmpDir, err := os.MkdirTemp("", "test_gallery_db_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	database, err := InitDB(tmpDir)
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer database.Close()

	testPhoto := Photo{
		ID:          "test_unit_001",
		Filename:    "test_unit_001.jpg",
		CreatedAt:   time.Now().UnixMilli(),
		AspectRatio: 1.5,
	}

	err = database.InsertPhoto(testPhoto)
	if err != nil {
		t.Fatalf("InsertPhoto failed: %v", err)
	}

	photos, err := database.GetPhotos(0, 10)
	if err != nil {
		t.Fatalf("GetPhotos failed: %v", err)
	}

	if len(photos) == 0 {
		t.Fatalf("Expected photos in result, got 0")
	}

	found := false
	for _, p := range photos {
		if p.ID == testPhoto.ID {
			found = true
			if p.Filename != testPhoto.Filename {
				t.Errorf("Expected filename %s, got %s", testPhoto.Filename, p.Filename)
			}
			break
		}
	}

	if !found {
		t.Errorf("Inserted photo with ID %s not found in query results", testPhoto.ID)
	}
}

func TestCursorPagination(t *testing.T) {
	os.Setenv("DB_URL", "sqlite")
	tmpDir, err := os.MkdirTemp("", "test_gallery_db_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	database, err := InitDB(tmpDir)
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer database.Close()

	// Page 1
	page1, err := database.GetPhotos(0, 10)
	if err != nil || len(page1) != 10 {
		t.Fatalf("Page 1 query failed, got %d items", len(page1))
	}

	cursor := page1[len(page1)-1].CreatedAt

	// Page 2 using cursor
	page2, err := database.GetPhotos(cursor, 10)
	if err != nil || len(page2) != 10 {
		t.Fatalf("Page 2 query failed, got %d items", len(page2))
	}

	if page1[0].ID == page2[0].ID {
		t.Errorf("Page 1 and Page 2 should not have identical starting IDs")
	}

	if page2[0].CreatedAt >= cursor {
		t.Errorf("Expected Page 2 items to have created_at < cursor (%d), got %d", cursor, page2[0].CreatedAt)
	}
}
