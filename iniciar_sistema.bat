@echo off
title VR System Launcher
echo ========================================================
echo        INICIANDO SISTEMA VR (WARM WORKER + NODE)
echo ========================================================
echo.
echo [1/2] Iniciando Warm Worker Playwright (:3005)...
start "VR-Warm-Worker" /min python bot_service.py
timeout /t 4 /nobreak >nul

echo [2/2] Iniciando Servidor Web Node.js (:3000)...
start "VR-Web-Server" /min node server.js
timeout /t 2 /nobreak >nul

echo.
echo ========================================================
echo  SISTEMA PRONTO:
echo  - Painel do Operador: http://localhost:3000/painel
echo  - Tela de Login:     http://localhost:3000/
echo  - Worker Persistente: http://127.0.0.1:3005/health
echo ========================================================
pause
