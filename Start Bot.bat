@echo off
chcp 65001 >nul
REM Instagram Report Bot Launcher for Windows
REM Double-click this file to start the bot

cd /d "%~dp0"

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   Python is not installed!
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo.
    echo   Opening Python download page...
    echo   Make sure to check "Add Python to PATH" during install!
    echo   After installing, run this file again.
    echo.
    start https://www.python.org/downloads/
    pause
    exit /b 1
)

REM Find Chrome path
set "CHROME_PATH="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if "%CHROME_PATH%"=="" (
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   Chrome is not installed!
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo.
    echo   Opening Chrome download page...
    echo   After installing, run this file again.
    echo.
    start https://www.google.com/chrome/
    pause
    exit /b 1
)

REM Setup virtual environment if needed
if not exist "venv" (
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   First run - setting up...
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    python -m venv venv
)

REM Activate and install dependencies
call venv\Scripts\activate.bat
python -m pip install -q -r requirements.txt
if errorlevel 1 (
    echo.
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   Install failed.
    echo   Please check the error above, then run this file again.
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pause
    exit /b 1
)

REM Check if Chrome is running
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | find /I "chrome.exe" >nul
if not errorlevel 1 (
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   Chrome is running!
    echo   The bot needs to launch Chrome in a special mode.
    echo   Please close all Chrome windows and press any key...
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pause >nul
    
    REM Check again
    tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | find /I "chrome.exe" >nul
    if not errorlevel 1 (
        echo Chrome is still running. Please close it completely.
        pause
        exit /b 1
    )
)

REM Launch Chrome in debug mode with the bot UI
set "PROFILE_DIR=%USERPROFILE%\.chrome_reporting_bot_profile"
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   Launching Chrome in debug mode...
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

start "" "%CHROME_PATH%" --remote-debugging-port=9222 --user-data-dir="%PROFILE_DIR%" "http://localhost:5555"

REM Give Chrome a moment to start
timeout /t 2 /nobreak >nul

REM Run the app (don't auto-open browser since Chrome already has the URL)
set SKIP_BROWSER_OPEN=1
python src\app.py

pause
