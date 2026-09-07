@echo off
title U.L.T.R.O.N. Launcher
setlocal
cd /d "%~dp0"

echo ============================================
echo   U.L.T.R.O.N.  -  starting up
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js was not found on this PC.
    echo     Please install it from https://nodejs.org ^(LTS version^),
    echo     then run this file again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [*] First run detected - installing dependencies.
    echo     This can take a few minutes, please wait...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [!] npm install failed. Check the messages above.
        pause
        exit /b 1
    )
) else (
    echo [*] Dependencies already installed - skipping install.
)

echo.
echo [*] Launching ULTRON app window...
echo     (a browser-less app window will open automatically)
echo.

call npm run app

echo.
echo ULTRON was closed.
pause
