#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

# Check if Chrome debug port is available
if ! curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "ERROR: Chrome is not running with remote debugging."
    echo ""
    echo "Please run these steps:"
    echo "  1. Quit Chrome completely (Cmd+Q)"
    echo "  2. Run: ./src/scripts/start_chrome.sh"
    echo "  3. Log into Instagram if prompted"
    echo "  4. Run: ./src/scripts/run_bot.sh"
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
python -m pip install -r requirements.txt

# Run Bot
echo ""
python src/bot.py
