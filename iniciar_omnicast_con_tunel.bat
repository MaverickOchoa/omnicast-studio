@echo off
title OmniCast Studio - Servidor y Tunel Cloudflare
color 0B
echo ========================================================
echo        OMNICAST STUDIO - SERVIDOR Y TUNEL EN VIVO       
echo ========================================================
echo.

set "PROJECT_DIR=C:\Users\huttm\omnicast-studio"

if not exist "%PROJECT_DIR%" (
    color 0C
    echo ========================================================
    echo   [!] AVISO IMPORTANTE: ESTA COMPUTADORA ES UN CLIENTE
    echo ========================================================
    echo.
    echo  No se encontro la carpeta del servidor en este equipo:
    echo  %PROJECT_DIR%
    echo.
    echo  Recuerda:
    echo  1. Este archivo .bat SOLO se ejecuta en la LAPTOP 1 (Servidor Maestro).
    echo  2. En esta laptop secundaria NO necesitas instalar nada.
    echo  3. Para conectarte desde esta laptop, solo abre Google Chrome y entra a:
    echo.
    echo     Red Local (WiFi): http://192.168.100.13:3000
    echo.
    echo ========================================================
    pause
    exit /b
)

echo  Iniciando servidor local y tunel Cloudflare seguro...
echo.

cd /d "%PROJECT_DIR%"

:: 1. Detener instancias previas en el puerto 3000 si existen
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: 2. Iniciar el servidor Node.js en segundo plano usando ruta absoluta
start "OmniCast Studio - Servidor" /min cmd /c "cd /d \"%PROJECT_DIR%\" && node \"%PROJECT_DIR%\server.js\""

:: 3. Esperar 2 segundos
ping 127.0.0.1 -n 3 >nul

:: 4. Abrir la consola de control en el navegador local
start http://localhost:3000

:: 5. Iniciar el Tunel Cloudflare usando ruta absoluta
node "%PROJECT_DIR%\tunnel.js"

pause
