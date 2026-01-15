#!/bin/bash

DEBUG_PROFILE_DIR="$HOME/.chrome_reporting_bot_profile"

echo "========================================================"
echo "Instagram Reporting Bot - Chrome Launcher"
echo "========================================================"
echo ""

# Check if Chrome is already running
if pgrep -x "Google Chrome" > /dev/null; then
    echo "ERROR: Chrome is still running!"
    echo "Please quit Chrome completely (Cmd+Q) and try again."
    exit 1
fi

# Create debug profile directory if it doesn't exist
if [ ! -d "$DEBUG_PROFILE_DIR" ]; then
    echo "First run detected. Creating debug profile..."
    mkdir -p "$DEBUG_PROFILE_DIR"
    FIRST_RUN=true
else
    FIRST_RUN=false
fi

echo "Launching Chrome with remote debugging on port 9222..."
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 \
    --user-data-dir="$DEBUG_PROFILE_DIR" \
    "https://www.instagram.com" \
    2>/dev/null &

# Wait for Chrome to start
sleep 3

# Check if debugging port is accessible
if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo ""
    echo "SUCCESS: Chrome is running with remote debugging enabled!"
    echo ""
    if [ "$FIRST_RUN" = true ]; then
        echo "*** FIRST RUN: Please log into Instagram in the Chrome window ***"
        echo "*** Your session will be saved for future runs ***"
    else
        echo "Chrome is ready. If you're not logged in, please log in now."
    fi
    echo ""
    echo "Once logged in, run: ./run_bot.sh"
else
    echo ""
    echo "ERROR: Could not verify Chrome debugging port."
    echo "Please wait a few seconds and try running: curl http://127.0.0.1:9222/json/version"
fi
