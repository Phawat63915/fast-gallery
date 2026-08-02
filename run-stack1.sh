#!/bin/bash
echo "========================================================="
echo "⚡ Starting FastGallery Light Backend API & Stack 1 (Vanilla Worker)"
echo "========================================================="
echo " 🌐 Backend API Server : http://localhost:9880"
echo " ⚡ Stack 1 Frontend   : http://localhost:9881"
echo "========================================================="

(go run ./backend/main.go) &
(npx --yes serve frontends/1-vanilla-worker -p 9881 --single) &

wait
