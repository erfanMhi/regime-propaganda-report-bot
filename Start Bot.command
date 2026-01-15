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
python -m pip install -r requirements.txt
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

# Run the app
python app.py
