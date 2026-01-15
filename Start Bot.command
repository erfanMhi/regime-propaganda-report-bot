#!/bin/bash
# Instagram Report Bot Launcher
# Double-click this file to start the bot

cd "$(dirname "$0")"

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠️  Python is not installed!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  Opening Python download page..."
    echo "  After installing, run this file again."
    echo ""
    open "https://www.python.org/downloads/"
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi

# Check if Chrome is installed
if [ ! -d "/Applications/Google Chrome.app" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠️  Chrome is not installed!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  Opening Chrome download page..."
    echo "  After installing, run this file again."
    echo ""
    open "https://www.google.com/chrome/"
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi

# Setup Python environment
if [ ! -d "venv" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  🔧 First run - setting up..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    python3 -m venv venv
fi

source venv/bin/activate
python -m pip install -q -r requirements.txt
if [ $? -ne 0 ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠️  Install failed."
    echo "  Please check the error above, then run this file again."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi

# Quit Chrome if running (required for debug mode)
if pgrep -x "Google Chrome" > /dev/null; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠️  Chrome is running!"
    echo "  The bot needs to launch Chrome in a special mode."
    echo "  Please quit Chrome (Cmd+Q) and press any key to continue..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    read -n 1
    
    # Check again
    if pgrep -x "Google Chrome" > /dev/null; then
        echo "Chrome is still running. Please quit it completely."
        read -n 1
        exit 1
    fi
fi

# Launch Chrome in debug mode with the bot UI
PROFILE_DIR="$HOME/.chrome_reporting_bot_profile"
mkdir -p "$PROFILE_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🚀 Launching Chrome in debug mode..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 \
    --user-data-dir="$PROFILE_DIR" \
    "http://localhost:5555" \
    2>/dev/null &

# Give Chrome a moment to start
sleep 2

# Run the app (don't auto-open browser since Chrome already has the URL)
SKIP_BROWSER_OPEN=1 python src/app.py
