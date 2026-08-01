#!/bin/bash
echo "Building FastGallery Backend (Go)..."
cd backend
go mod tidy
go build -o server .
echo "Build complete! Binary located at backend/server"
