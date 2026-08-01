#!/bin/bash
echo "Starting PostgreSQL container via Docker Compose..."
docker compose up -d db

echo "Building production Go binary..."
./build.sh

echo "Starting FastGallery Production Server..."
cd backend
./server
