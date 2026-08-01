#!/bin/bash
echo "========================================================="
echo "⚡ FastGallery Multi-Stack Benchmark Suite (5 Frontends)"
echo "========================================================="

echo "1. Starting PostgreSQL 17 via Docker Compose..."
docker compose up -d db

echo "2. Building Go Backend Binary..."
./build.sh

echo "3. Starting Master Go Backend API Server on Port 8880..."
(cd backend && ./server) &

sleep 2

echo "4. Launching All 5 Frontend Stacks on Dedicated Ports..."
echo " - Stack 1: Vanilla JS + Web Worker -> http://localhost:8881"
echo " - Stack 2: Svelte 5 + Vite          -> http://localhost:8882"
echo " - Stack 3: Vue 3 + Vite             -> http://localhost:8883"
echo " - Stack 4: React 19 + Vite          -> http://localhost:8884"
echo " - Stack 5: Vanilla Root Classic     -> http://localhost:8885"

(npx --yes serve frontends/1-vanilla-worker -p 8881 --single) &
(cd frontends/2-svelte && npm run dev) &
(cd frontends/3-vue && npm run dev) &
(cd frontends/4-react && npm run dev) &
(npx --yes serve frontends/5-vanilla-root -p 8885 --single) &

echo "========================================================="
echo "✅ All 5 Frontend Stacks & Go API Server are running!"
echo "   - Stack 1 (Vanilla JS):     http://localhost:8881"
echo "   - Stack 2 (Svelte 5):       http://localhost:8882"
echo "   - Stack 3 (Vue 3):          http://localhost:8883"
echo "   - Stack 4 (React 19):       http://localhost:8884"
echo "   - Stack 5 (Vanilla Classic):http://localhost:8885"
echo "========================================================="
wait
