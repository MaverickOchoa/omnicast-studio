@echo off
title OmniCast Studio - Servidor Local
color 0A
echo ========================================================
echo           OMNICAST STUDIO - SERVIDOR LOCAL              
echo ========================================================
echo.
echo  Iniciando consola local en http://localhost:3000...
echo.

:: Fijar la ruta exacta de OmniCast Studio
cd /d "C:\Users\huttm\omnicast-studio"

:: Detener instancias previas en el puerto 3000 si existen
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

start http://localhost:3000
node server.js

pause
