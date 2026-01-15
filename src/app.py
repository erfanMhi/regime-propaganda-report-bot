#!/usr/bin/env python3
"""
Instagram Report Bot - Simple Web UI
Run this file and it opens a browser with a nice interface.
"""
import os
import sys
import json
import subprocess
import threading
import webbrowser
import time
import urllib.request
import platform
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

PORT = 5555
SCRIPT_DIR = Path(__file__).parent
CHROME_DEBUG_PORT = 9222


# =============================================================================
# SETUP CHECKS
# =============================================================================

def check_dependencies() -> tuple[bool, str]:
    """Check if all required packages are installed."""
    try:
        import selenium
        from webdriver_manager.chrome import ChromeDriverManager
        return True, "Dependencies OK"
    except ImportError as e:
        return False, f"Missing package: {e.name}. Run: pip install -r requirements.txt"


def check_chrome_installed() -> tuple[bool, str]:
    """Check if Chrome is installed on the system."""
    chrome_path = get_chrome_path()
    
    if platform.system() == "Windows":
        # On Windows, check if any of the paths exist or if 'chrome' is in PATH
        if chrome_path != "chrome" and os.path.exists(chrome_path):
            return True, f"Chrome found: {chrome_path}"
        # Try running chrome --version
        try:
            result = subprocess.run(["chrome", "--version"], capture_output=True, text=True)
            if result.returncode == 0:
                return True, "Chrome found in PATH"
        except FileNotFoundError:
            pass
        return False, "Chrome not found. Please install Google Chrome."
    
    elif platform.system() == "Darwin":  # macOS
        if os.path.exists(chrome_path):
            return True, f"Chrome found: {chrome_path}"
        return False, "Chrome not found. Please install Google Chrome from google.com/chrome"
    
    else:  # Linux
        try:
            result = subprocess.run(["which", "google-chrome"], capture_output=True)
            if result.returncode == 0:
                return True, "Chrome found"
        except Exception:
            pass
        return False, "Chrome not found. Install with: sudo apt install google-chrome-stable"


def check_port_available(port: int) -> tuple[bool, str]:
    """Check if a port is available."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", port))
            return True, f"Port {port} available"
    except OSError:
        return False, f"Port {port} is in use. Close other apps or restart your computer."


def run_setup_checks() -> list[dict]:
    """Run all setup checks and return results."""
    checks = []
    
    # Check dependencies
    ok, msg = check_dependencies()
    checks.append({"name": "Python Packages", "ok": ok, "message": msg})
    
    # Check Chrome installed
    ok, msg = check_chrome_installed()
    checks.append({"name": "Google Chrome", "ok": ok, "message": msg})
    
    # Check web UI port
    ok, msg = check_port_available(PORT)
    checks.append({"name": "Web UI Port", "ok": ok, "message": msg})
    
    return checks


def print_setup_status():
    """Print setup status to console."""
    print("\n" + "=" * 50)
    print("Setup Checks")
    print("=" * 50)
    
    checks = run_setup_checks()
    all_ok = True
    
    for check in checks:
        status = "✓" if check["ok"] else "✗"
        print(f"  {status} {check['name']}: {check['message']}")
        if not check["ok"]:
            all_ok = False
    
    print("=" * 50)
    
    if not all_ok:
        print("\n⚠️  Some checks failed. Please fix the issues above.\n")
        return False
    
    print("✓ All checks passed!\n")
    return True


def check_chrome_ready() -> bool:
    """Check if Chrome is running with debug port."""
    try:
        url = f"http://127.0.0.1:{CHROME_DEBUG_PORT}/json/version"
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status == 200
    except Exception:
        return False


def is_chrome_running() -> bool:
    """Check if Chrome process is running (cross-platform)."""
    import platform
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq chrome.exe"],
                capture_output=True,
                text=True
            )
            return "chrome.exe" in result.stdout.lower()
        else:  # macOS / Linux
            result = subprocess.run(
                ["pgrep", "-x", "Google Chrome"],
                capture_output=True
            )
            return result.returncode == 0
    except Exception:
        return False


def get_chrome_path() -> str:
    """Get Chrome executable path based on OS."""
    import platform
    system = platform.system()
    
    if system == "Darwin":  # macOS
        return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    elif system == "Windows":
        # Common Windows Chrome paths
        possible_paths = [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        ]
        for path in possible_paths:
            if os.path.exists(path):
                return path
        return "chrome"  # Fallback to PATH
    else:  # Linux
        return "google-chrome"


def get_profile_dir() -> str:
    """Get Chrome profile directory based on OS."""
    import platform
    system = platform.system()
    
    if system == "Windows":
        return os.path.expandvars(r"%USERPROFILE%\.chrome_reporting_bot_profile")
    else:
        return os.path.expanduser("~/.chrome_reporting_bot_profile")


def launch_chrome_debug() -> tuple[bool, str]:
    """Launch Chrome with remote debugging (cross-platform)."""
    # Check if Chrome is installed first
    ok, msg = check_chrome_installed()
    if not ok:
        return False, msg
    
    profile_dir = get_profile_dir()
    try:
        os.makedirs(profile_dir, exist_ok=True)
    except PermissionError:
        return False, f"Cannot create profile directory: {profile_dir}"
    
    chrome_path = get_chrome_path()
    
    try:
        subprocess.Popen([
            chrome_path,
            f"--remote-debugging-port={CHROME_DEBUG_PORT}",
            f"--user-data-dir={profile_dir}",
            "https://www.instagram.com"
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True, "Chrome launched successfully"
    except FileNotFoundError:
        return False, f"Chrome not found at: {chrome_path}"
    except PermissionError:
        return False, "Permission denied. Try running as administrator."
    except Exception as e:
        return False, f"Failed to launch Chrome: {str(e)[:50]}"


def load_targets():
    """Load targets from file."""
    targets_file = SCRIPT_DIR.parent / "data" / "targets.txt"
    if targets_file.exists():
        with open(targets_file, 'r') as f:
            return [line.strip() for line in f if line.strip()]
    return []


# Global state
bot_state = {
    "running": False,
    "current_index": 0,
    "results": [],  # List of {username, status, message}
    "chrome_ready": False,
}


class BotHandler(SimpleHTTPRequestHandler):
    """Handle API requests for the bot UI."""
    
    def do_GET(self):
        if self.path == "/":
            self.send_html()
        elif self.path == "/api/status":
            self.send_json({
                "chrome_ready": check_chrome_ready(),
                "chrome_running": is_chrome_running(),
                "running": bot_state["running"],
                "current_index": bot_state["current_index"],
                "results": bot_state["results"],
                "targets": load_targets(),
            })
        else:
            self.send_error(404)
    
    def do_POST(self):
        if self.path == "/api/launch-chrome":
            # If debug Chrome is already running, we're good
            if check_chrome_ready():
                self.send_json({"success": True, "message": "Chrome debug mode already active"})
                return
            
            # Try to launch debug Chrome (even if normal Chrome is running)
            success, message = launch_chrome_debug()
            time.sleep(3)
            
            # Check if debug port is now available
            if check_chrome_ready():
                self.send_json({"success": True})
            elif is_chrome_running():
                # Chrome is running but debug port not available - need to quit Chrome
                quit_hint = "Cmd+Q" if platform.system() == "Darwin" else "close all Chrome windows"
                self.send_json({"error": f"Chrome is running but not in debug mode. Please quit Chrome ({quit_hint}) and click 'Launch Chrome' again."})
            else:
                self.send_json({"error": message})
        
        elif self.path == "/api/start":
            if not bot_state["running"]:
                bot_state["running"] = True
                bot_state["current_index"] = 0
                bot_state["results"] = []
                threading.Thread(target=run_bot_thread, daemon=True).start()
            self.send_json({"success": True})
        
        elif self.path == "/api/stop":
            bot_state["running"] = False
            self.send_json({"success": True})
        
        else:
            self.send_error(404)
    
    def send_json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def send_html(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(HTML_PAGE.encode())
    
    def log_message(self, format, *args):
        pass  # Suppress logging


def run_bot_thread():
    """Run the bot in a background thread."""
    from bot import setup_driver, report_user_safe
    import random
    
    targets = load_targets()
    
    try:
        driver = setup_driver()
    except SystemExit:
        bot_state["running"] = False
        return
    
    # Open Instagram in a new tab to avoid interfering with existing tabs
    driver.execute_script("window.open('https://www.instagram.com/', '_blank');")
    time.sleep(1)
    driver.switch_to.window(driver.window_handles[-1])
    time.sleep(2)
    
    if "login" in driver.current_url.lower():
        bot_state["results"].append({
            "username": "SYSTEM",
            "status": "error",
            "message": "Not logged into Instagram. Please log in."
        })
        bot_state["running"] = False
        return
    
    for i, username in enumerate(targets):
        if not bot_state["running"]:
            break
        
        bot_state["current_index"] = i
        bot_state["results"].append({
            "username": username,
            "status": "processing",
            "message": "Processing..."
        })
        
        result = report_user_safe(driver, username)
        
        # Update result based on status
        status_messages = {
            "success": ("success", "Reported"),
            "skipped": ("skipped", "Profile not found"),
            "failed": ("failed", "Failed to report"),
        }
        status, message = status_messages.get(result, ("failed", "Unknown error"))
        
        bot_state["results"][-1] = {
            "username": username,
            "status": status,
            "message": message,
        }
        
        if bot_state["running"] and i < len(targets) - 1:
            time.sleep(random.uniform(10, 15))
    
    bot_state["running"] = False


HTML_PAGE = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fight Back - Report Bot</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        :root {
            --green: #00a86b;
            --white: #f8f9fa;
            --red: #c8102e;
            --dark: #0d1117;
            --dark-secondary: #161b22;
            --border: rgba(255,255,255,0.08);
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--dark);
            color: var(--white);
            min-height: 100vh;
            line-height: 1.6;
        }
        
        body.rtl {
            direction: rtl;
            font-family: 'Vazirmatn', 'Inter', sans-serif;
        }
        
        .flag-bar {
            height: 4px;
            background: linear-gradient(90deg, var(--green) 33%, var(--white) 33%, var(--white) 66%, var(--red) 66%);
        }
        
        .container {
            max-width: 640px;
            margin: 0 auto;
            padding: 40px 24px;
        }
        
        .lang-toggle {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 24px;
        }
        
        .lang-btn {
            background: var(--dark-secondary);
            border: 1px solid var(--border);
            color: var(--white);
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9em;
            transition: all 0.2s;
        }
        
        .lang-btn:hover {
            background: rgba(255,255,255,0.1);
        }
        
        .memorial {
            text-align: center;
            margin-bottom: 40px;
            padding: 32px 24px;
            background: linear-gradient(135deg, rgba(200,16,46,0.1) 0%, rgba(0,168,107,0.1) 100%);
            border: 1px solid var(--border);
            border-radius: 16px;
        }
        
        .memorial-icon {
            font-size: 2.5em;
            margin-bottom: 16px;
        }
        
        .memorial h2 {
            font-family: 'Playfair Display', serif;
            font-size: 1.5em;
            font-weight: 500;
            margin-bottom: 16px;
            color: var(--white);
        }
        
        .memorial p {
            color: rgba(255,255,255,0.7);
            font-size: 0.95em;
            max-width: 520px;
            margin: 0 auto;
        }
        
        .memorial-source {
            margin-top: 16px !important;
            font-size: 0.8em !important;
            color: rgba(255,255,255,0.4) !important;
            font-style: italic;
        }
        
        .memorial .highlight {
            color: var(--green);
            font-weight: 600;
        }
        
        h1 {
            text-align: center;
            font-family: 'Playfair Display', serif;
            font-size: 2em;
            font-weight: 700;
            margin-bottom: 8px;
            letter-spacing: -0.02em;
        }
        
        .subtitle {
            text-align: center;
            color: rgba(255,255,255,0.5);
            margin-bottom: 32px;
            font-size: 0.95em;
        }
        
        .card {
            background: var(--dark-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
        }
        
        .status-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
        }
        
        .status-row:not(:last-child) {
            border-bottom: 1px solid var(--border);
        }
        
        .status-label {
            color: rgba(255,255,255,0.6);
            font-size: 0.9em;
        }
        
        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-weight: 500;
        }
        
        .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
        }
        
        .dot.green { background: var(--green); box-shadow: 0 0 8px var(--green); }
        .dot.red { background: var(--red); }
        .dot.yellow { background: #f59e0b; animation: pulse 1.5s ease-in-out infinite; }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.6; transform: scale(0.9); }
        }
        
        .btn {
            padding: 14px 28px;
            border: none;
            border-radius: 8px;
            font-size: 0.95em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
            transform: none !important;
        }
        
        .btn-primary {
            background: var(--green);
            color: #fff;
        }
        
        .btn-primary:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(0,168,107,0.3);
        }
        
        .btn-danger {
            background: var(--red);
            color: #fff;
        }
        
        .btn-danger:hover:not(:disabled) {
            box-shadow: 0 8px 24px rgba(200,16,46,0.3);
        }
        
        .actions {
            display: flex;
            gap: 12px;
            justify-content: center;
            margin-bottom: 24px;
        }
        
        .progress-container {
            margin-bottom: 24px;
        }
        
        .progress-bar {
            height: 6px;
            background: var(--dark-secondary);
            border-radius: 3px;
            overflow: hidden;
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--green), #22d3ee);
            transition: width 0.3s ease;
            border-radius: 3px;
        }
        
        .results-list {
            max-height: 360px;
            overflow-y: auto;
        }
        
        .results-list::-webkit-scrollbar {
            width: 6px;
        }
        
        .results-list::-webkit-scrollbar-track {
            background: transparent;
        }
        
        .results-list::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.1);
            border-radius: 3px;
        }
        
        .result-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: var(--dark-secondary);
            border-radius: 8px;
            margin-bottom: 8px;
            border-left: 3px solid transparent;
            transition: all 0.2s;
        }
        
        .result-item:hover {
            background: rgba(255,255,255,0.03);
        }
        
        .result-item.success { border-left-color: var(--green); }
        .result-item.skipped { border-left-color: #64748b; }
        .result-item.failed { border-left-color: var(--red); }
        .result-item.processing { border-left-color: #f59e0b; background: rgba(245,158,11,0.05); }
        .result-item.pending { border-left-color: #374151; opacity: 0.6; }
        
        .username { font-weight: 600; flex: 1; font-size: 0.95em; }
        .message { color: rgba(255,255,255,0.5); font-size: 0.85em; }
        
        .warning-card {
            background: rgba(245,158,11,0.08);
            border: 1px solid rgba(245,158,11,0.2);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            text-align: center;
        }
        
        .warning-card p { 
            margin-bottom: 12px; 
            color: #f59e0b;
            font-weight: 500;
        }
        
        .warning-card .hint {
            font-size: 0.8em;
            color: rgba(255,255,255,0.4);
            margin-top: 12px;
        }
        
        .footer {
            text-align: center;
            margin-top: 40px;
            padding-top: 24px;
            border-top: 1px solid var(--border);
            color: rgba(255,255,255,0.3);
            font-size: 0.85em;
        }
        
        .footer span {
            color: var(--red);
        }
    </style>
</head>
<body>
    <div class="flag-bar"></div>
    
    <div class="container">
        <div class="lang-toggle">
            <button class="lang-btn" onclick="toggleLang()" id="lang-btn">فارسی</button>
        </div>
        
        <div class="memorial">
            <div class="memorial-icon">✊</div>
            <h2 id="memorial-title">Fight back against the Islamic regime's tyranny</h2>
            <p id="memorial-text">
                The Islamic regime has killed over <span class="highlight">12,000 protesters</span>, 
                possibly as many as <span class="highlight">20,000</span>, and detained tens of thousands more 
                for demanding basic human rights. They cut off internet and phone lines to hide their massacre. 
                They took our friends, our family, our loved ones. 
                This tool is our resistance: dismantling their propaganda machine, one report at a time.
            </p>
            <p class="memorial-source" id="memorial-source">Sources: CBS News, Iran International, Iran Human Rights</p>
        </div>
        
        <h1 id="main-title">Report Bot</h1>
        <p class="subtitle" id="main-subtitle">Automated Instagram Reporting Tool</p>
        
        <div class="card">
            <div class="status-row">
                <span class="status-label" data-en="Chrome Status" data-fa="وضعیت کروم">Chrome Status</span>
                <span class="status-indicator" id="chrome-status">
                    <span class="dot red"></span>
                    <span data-en="Checking..." data-fa="در حال بررسی...">Checking...</span>
                </span>
            </div>
            <div class="status-row">
                <span class="status-label" data-en="Targets Loaded" data-fa="تعداد اهداف">Targets Loaded</span>
                <span id="targets-count" style="font-weight: 600;">0</span>
            </div>
        </div>
        
        <div id="chrome-warning" class="warning-card" style="display: none;">
            <p data-en="⚠️ Chrome is not ready" data-fa="⚠️ کروم آماده نیست">⚠️ Chrome is not ready</p>
            <button class="btn btn-primary" onclick="launchChrome()" data-en="Launch Chrome" data-fa="اجرای کروم">Launch Chrome</button>
            <p class="hint" id="chrome-hint" data-en="Quit Chrome first if it's already open" data-fa="اگر کروم باز است، اول آن را ببندید">
                Quit Chrome first if it's already open
            </p>
        </div>
        
        <div class="actions">
            <button class="btn btn-primary" id="start-btn" onclick="startBot()" disabled>
                <span>▶</span>
                <span data-en="Start" data-fa="شروع">Start</span>
            </button>
            <button class="btn btn-danger" id="stop-btn" onclick="stopBot()" disabled>
                <span>⏹</span>
                <span data-en="Stop" data-fa="توقف">Stop</span>
            </button>
        </div>
        
        <div class="progress-container">
            <div class="progress-bar">
                <div class="progress-fill" id="progress" style="width: 0%"></div>
            </div>
        </div>
        
        <div class="results-list" id="results"></div>
        
        <div class="footer">
            <p id="footer-text">Fight back against the Islamic regime's tyranny</p>
        </div>
    </div>
    
    <script>
        let targets = [];
        let currentLang = 'en';
        
        const translations = {
            en: {
                memorialTitle: "Fight back against the Islamic regime's tyranny",
                memorialText: 'The Islamic regime has killed over <span class="highlight">12,000 protesters</span>, possibly as many as <span class="highlight">20,000</span>, and detained tens of thousands more for demanding basic human rights. They cut off internet and phone lines to hide their massacre. They took our friends, our family, our loved ones. This tool is our resistance: dismantling their propaganda machine, one report at a time.',
                memorialSource: "Sources: CBS News, Iran International, Iran Human Rights",
                mainTitle: "Report Bot",
                mainSubtitle: "Automated Instagram Reporting Tool",
                footerText: "Fight back against the Islamic regime's tyranny",
                langBtn: "فارسی",
                reported: "Reported",
                notFound: "Profile not found", 
                failed: "Failed to report",
                pending: "Pending",
                processing: "Processing...",
                connected: "Connected",
                notConnected: "Not Connected",
                checking: "Checking..."
            },
            fa: {
                memorialTitle: "مبارزه با استبداد رژیم اسلامی",
                memorialText: 'رژیم اسلامی بیش از <span class="highlight">۱۲٬۰۰۰ معترض</span>، شاید تا <span class="highlight">۲۰٬۰۰۰ نفر</span>، را کشته و ده‌ها هزار نفر را به خاطر خواستن حقوق اولیه انسانی بازداشت کرده است. آنها اینترنت و تلفن را قطع کردند تا قتل عام خود را پنهان کنند. آنها دوستان، خانواده و عزیزان ما را از ما گرفتند. این ابزار مقاومت ماست: نابودی ماشین تبلیغاتی آنها، گزارش به گزارش.',
                memorialSource: "منابع: سی‌بی‌اس نیوز، ایران اینترنشنال، سازمان حقوق بشر ایران",
                mainTitle: "ربات گزارش",
                mainSubtitle: "ابزار خودکار گزارش اینستاگرام",
                footerText: "مبارزه با استبداد رژیم اسلامی",
                langBtn: "English",
                reported: "گزارش شد",
                notFound: "پروفایل یافت نشد",
                failed: "خطا در گزارش",
                pending: "در انتظار",
                processing: "در حال پردازش...",
                connected: "متصل",
                notConnected: "متصل نیست",
                checking: "در حال بررسی..."
            }
        };
        
        function toggleLang() {
            currentLang = currentLang === 'en' ? 'fa' : 'en';
            document.body.classList.toggle('rtl', currentLang === 'fa');
            
            const t = translations[currentLang];
            document.getElementById('memorial-title').textContent = t.memorialTitle;
            document.getElementById('memorial-text').innerHTML = t.memorialText;
            document.getElementById('memorial-source').textContent = t.memorialSource;
            document.getElementById('main-title').textContent = t.mainTitle;
            document.getElementById('main-subtitle').textContent = t.mainSubtitle;
            document.getElementById('lang-btn').textContent = t.langBtn;
            document.getElementById('footer-text').textContent = t.footerText;
            
            // Update data-* elements
            document.querySelectorAll('[data-en]').forEach(el => {
                el.textContent = el.getAttribute('data-' + currentLang);
            });
            
            fetchStatus();
        }
        
        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                updateUI(data);
            } catch (e) {
                console.error(e);
            }
        }
        
        function updateUI(data) {
            targets = data.targets || [];
            const t = translations[currentLang];
            
            const chromeStatus = document.getElementById('chrome-status');
            const chromeWarning = document.getElementById('chrome-warning');
            const startBtn = document.getElementById('start-btn');
            const stopBtn = document.getElementById('stop-btn');
            
            if (data.chrome_ready) {
                chromeStatus.innerHTML = `<span class="dot green"></span><span>${t.connected}</span>`;
                chromeWarning.style.display = 'none';
                startBtn.disabled = data.running;
            } else {
                chromeStatus.innerHTML = `<span class="dot red"></span><span>${t.notConnected}</span>`;
                chromeWarning.style.display = 'block';
                startBtn.disabled = true;
            }
            
            stopBtn.disabled = !data.running;
            document.getElementById('targets-count').textContent = targets.length;
            
            document.getElementById('progress').style.width = 
                data.results.length > 0 ? `${(data.results.length / targets.length * 100)}%` : '0%';
            
            const resultsDiv = document.getElementById('results');
            let html = '';
            
            const statusMessages = {
                success: t.reported,
                skipped: t.notFound,
                failed: t.failed,
                processing: t.processing
            };
            
            for (const r of data.results) {
                const msg = statusMessages[r.status] || r.message;
                html += `<div class="result-item ${r.status}">
                    <span class="username">@${r.username}</span>
                    <span class="message">${msg}</span>
                </div>`;
            }
            
            const processedUsernames = new Set(data.results.map(r => r.username));
            for (const username of targets) {
                if (!processedUsernames.has(username)) {
                    html += `<div class="result-item pending">
                        <span class="username">@${username}</span>
                        <span class="message">${t.pending}</span>
                    </div>`;
                }
            }
            
            resultsDiv.innerHTML = html;
        }
        
        async function launchChrome() {
            const res = await fetch('/api/launch-chrome', { method: 'POST' });
            const data = await res.json();
            if (data.error) alert(data.error);
            setTimeout(fetchStatus, 3000);
        }
        
        async function startBot() {
            await fetch('/api/start', { method: 'POST' });
            fetchStatus();
        }
        
        async function stopBot() {
            await fetch('/api/stop', { method: 'POST' });
            fetchStatus();
        }
        
        setInterval(fetchStatus, 2000);
        fetchStatus();
    </script>
</body>
</html>
'''


def main():
    """Start the web server and open browser."""
    print(f"\n{'='*50}")
    print("Instagram Report Bot - Web UI")
    print(f"{'='*50}")
    
    # Run setup checks
    if not print_setup_status():
        print("Please fix the setup issues and try again.")
        input("Press Enter to exit...")
        sys.exit(1)
    
    print(f"Starting server at http://localhost:{PORT}")
    print("Opening browser...")
    print("\nPress Ctrl+C to stop\n")
    
    # Open browser after short delay
    threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    
    # Start server
    try:
        server = HTTPServer(("", PORT), BotHandler)
        server.serve_forever()
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"\n❌ Port {PORT} is already in use!")
            print("   Close other applications or restart your computer.")
        else:
            print(f"\n❌ Server error: {e}")
        input("Press Enter to exit...")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nStopping server...")
        server.shutdown()


if __name__ == "__main__":
    main()
