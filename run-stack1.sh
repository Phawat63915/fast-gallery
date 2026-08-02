#!/bin/bash
echo "========================================================="
echo "⚡ Starting FastGallery Backend API & Stack 1 (Vanilla Worker)"
echo "========================================================="
echo " 🌐 Backend API Server : http://localhost:8880"
echo " ⚡ Stack 1 Frontend   : http://localhost:8881"
echo "========================================================="

(go run ./backend/main.go) &
(npx --yes serve frontends/1-vanilla-worker -p 8881 --single) &

wait
