@echo off
cd /d "%~dp0"
curl -s -o nul --max-time 1 http://127.0.0.1:5177/ && goto open
start "" /min cmd /c "node server.js >> data\server.log 2>&1"
:wait
ping -n 2 127.0.0.1 >nul
curl -s -o nul --max-time 1 http://127.0.0.1:5177/ || goto wait
:open
start "" http://localhost:5177
