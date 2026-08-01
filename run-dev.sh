#!/bin/bash
echo "Starting PostgreSQL container via Docker Compose..."
docker compose up -d db

echo "Running Go Backend Unit & Integration Tests..."
cd backend
go test -v ./...

echo "Starting FastGallery Go Server..."
go run main.go
