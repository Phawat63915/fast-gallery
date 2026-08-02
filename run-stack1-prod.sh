#!/bin/bash
echo "========================================================="
echo "⚡ Starting FastGallery Production Mode: Backend API & Stack 1"
echo "========================================================="

echo "1. Starting PostgreSQL 18 via Docker Compose..."
docker compose up -d db

echo "2. Building Production Go Binary..."
./build.sh

echo "3. Launching Production Servers..."
echo " 🌐 Production Backend API Server : http://localhost:8880"
echo " ⚡ Stack 1 Frontend (Vanilla JS)  : http://localhost:8881"
echo "========================================================="

(cd backend && ./server) &
(npx --yes serve frontends/1-vanilla-worker -p 8881 --single) &

wait
