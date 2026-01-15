@echo off
chcp 65001 >nul
REM Instagram Report Bot Launcher for Windows
REM Double-click this file to start the bot

cd /d "%~dp0"

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   ⚠️  Python is not installed!
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo.
    echo   Opening Python download page...
    echo   ✓ Make sure to check "Add Python to PATH" during install!
    echo   After installing, run this file again.
    echo.
    start https://www.python.org/downloads/
    pause
    exit /b 1
)

REM Check if Chrome is installed
if not exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    if not exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
        if not exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
            echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            echo   ⚠️  Chrome is not installed!
            echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            echo.
            echo   Opening Chrome download page...
            echo   After installing, run this file again.
            echo.
            start https://www.google.com/chrome/
            pause
            exit /b 1
        )
    )
)

REM Setup virtual environment if needed
if not exist "venv" (
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   🔧 First run - setting up...
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    python -m venv venv
)

REM Activate and install dependencies
call venv\Scripts\activate.bat
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    echo   ⚠️  Install failed.
    echo   Please check the error above, then run this file again.
    echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pause
    exit /b 1
)

REM Run the app
python app.py

pause
