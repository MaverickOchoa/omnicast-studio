@echo off
title Desplegar OmniCast Studio en Vercel
color 0b
echo ======================================================================
echo           DESPLEGAR OMNICAST STUDIO A LA NUBE (VERCEL)
echo ======================================================================
echo.
echo  1. Si es tu primera vez, Vercel te pedira iniciar sesion en el navegador
echo     (puedes elegir GitHub o tu correo de forma gratuita).
echo.
echo  2. En la ventana negra, presiona ENTER para aceptar las opciones por defecto:
echo     - Set up and deploy? [Y/n]  --> Presiona ENTER (Y)
echo     - Which scope?              --> Presiona ENTER
echo     - Link to existing project? --> Presiona ENTER (N)
echo     - Project name?             --> Presiona ENTER
echo     - In which directory?       --> Presiona ENTER
echo.
echo  3. En 15 segundos te entregara tu URL definitiva para usar desde
echo     cualquier otra computadora sin necesidad de llevarte tu laptop.
echo.
echo ======================================================================
echo.
cd /d "C:\Users\huttm\omnicast-studio"
npx vercel --prod
echo.
echo ======================================================================
echo  Copia tu enlace que termina en .vercel.app mostrado arriba!
echo ======================================================================
pause
