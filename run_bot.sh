#!/bin/bash
cd "$(dirname "$0")"

# Check if Chrome debug port is available
if ! curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "ERROR: Chrome is not running with remote debugging."
    echo ""
    echo "Please run these steps:"
    echo "  1. Quit Chrome completely (Cmd+Q)"
    echo "  2. Run: ./start_chrome.sh"
    echo "  3. Log into Instagram if prompted"
    echo "  4. Run: ./run_bot.sh"
    exit 1
fi

# Setup Python Environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

# Install Requirements
echo "Checking dependencies..."
pip install -q -r requirements.txt 2>/dev/null

# Run Bot
echo ""
python bot.py
