#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/data"

echo "🧹 Cleaning FastGallery image data & databases..."

# Stop PostgreSQL docker container if running
if command -v docker &> /dev/null && docker compose ps --services 2>/dev/null | grep -q db; then
    echo "Stopping PostgreSQL docker container..."
    docker compose down -v 2>/dev/null || true
fi

# Clean SQLite databases
if [ -d "${DATA_DIR}/sqlite" ]; then
    find "${DATA_DIR}/sqlite" -mindepth 1 ! -name '.gitkeep' -delete
fi

# Clean PostgreSQL data directory
if [ -d "${DATA_DIR}/postgres" ]; then
    find "${DATA_DIR}/postgres" -mindepth 1 ! -name '.gitkeep' -delete
fi

# Clean uploaded original photos
if [ -d "${DATA_DIR}/uploads/originals" ]; then
    find "${DATA_DIR}/uploads/originals" -mindepth 1 ! -name '.gitkeep' -delete
fi

# Clean uploaded thumbnail photos
if [ -d "${DATA_DIR}/uploads/thumbnails" ]; then
    find "${DATA_DIR}/uploads/thumbnails" -mindepth 1 ! -name '.gitkeep' -delete
fi

# Ensure directories exist
mkdir -p "${DATA_DIR}/sqlite" "${DATA_DIR}/postgres" "${DATA_DIR}/uploads/originals" "${DATA_DIR}/uploads/thumbnails"

echo "✅ All database and image data have been successfully reset!"
