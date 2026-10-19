@echo off
title Compartir OmniCast por Internet (Tunel Temporal)
color 0b
echo ========================================================
echo   OMNICAST STUDIO - GENERANDO ENLACE DE INTERNET
echo ========================================================
echo.
echo  Recuerda que tu laptop debe quedarse encendida para que
echo  el enlace funcione desde otra computadora o ciudad.
echo.
echo  Generando enlace publico gratuito...
echo.
npx localtunnel --port 3000
pause
