@echo off
echo.
echo  ========================================
echo    📈 Stock Volatility Tracker
echo  ========================================
echo.
echo  Starting the app... please wait...
echo.
echo  When you see "running", open your browser to:
echo.
echo       http://localhost:3000
echo.
echo  To STOP the app, close this window.
echo  ========================================
echo.
cd /d "%~dp0"
node server.js
pause
