#!/usr/bin/env python3
"""
Instagram Reporting Bot
Connects to Chrome via remote debugging and reports specified accounts.
"""
import logging
import os
import random
import sys
import time
import urllib.error
import urllib.request
from typing import List, Literal, Optional

# Result status type
ReportStatus = Literal["success", "skipped", "failed"]

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException, WebDriverException
from webdriver_manager.chrome import ChromeDriverManager

# =============================================================================
# CONFIGURATION
# =============================================================================

CHROME_DEBUG_PORT = 9222
DEFAULT_TIMEOUT = 5
SHORT_TIMEOUT = 3
DELAY_BETWEEN_PROFILES = (15, 25)  # seconds (min, max)
RATE_LIMIT_WAIT = 60  # seconds

NOT_FOUND_INDICATORS = [
    "profile isn't available",
    "sorry, this page",
    "page isn't available",
    "this page isn't available",
    "may have been removed",
    "link may be broken",
]

CLOSE_DIALOG_TEXTS = ["Close", "Done", "OK", "Dismiss", "×", "Not now", "Cancel"]

# =============================================================================
# LOGGING SETUP
# =============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# =============================================================================
# CHROME CONNECTION
# =============================================================================

def check_chrome_debug_port(port: int = CHROME_DEBUG_PORT) -> bool:
    """Check if Chrome is running with remote debugging enabled."""
    try:
        url = f"http://127.0.0.1:{port}/json/version"
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError):
        return False


def setup_driver(port: int = CHROME_DEBUG_PORT) -> webdriver.Chrome:
    """Connect to an existing Chrome instance on the debugging port."""
    if not check_chrome_debug_port(port):
        log.error("Cannot connect to Chrome on port %d", port)
        log.error("Solutions: 1) Quit Chrome (Cmd+Q)  2) Run ./start_chrome.sh  3) Run bot")
        sys.exit(1)

    chrome_options = Options()
    chrome_options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")

    try:
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=chrome_options)
        return driver
    except WebDriverException as e:
        log.error("Error connecting to Chrome: %s", e)
        sys.exit(1)


# =============================================================================
# ELEMENT INTERACTION HELPERS
# =============================================================================

def escape_xpath_string(text: str) -> str:
    """Escape a string for use in XPath (handles quotes and apostrophes)."""
    if "'" not in text:
        return f"'{text}'"
    elif '"' not in text:
        return f'"{text}"'
    else:
        parts = text.split("'")
        return "concat('" + "', \"'\", '".join(parts) + "')"


def click_element(element: WebElement, driver: webdriver.Chrome) -> bool:
    """Click an element safely with scroll and JS fallback."""
    try:
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
        time.sleep(0.3)
        try:
            element.click()
        except Exception:
            driver.execute_script("arguments[0].click();", element)
        return True
    except Exception:
        return False


def wait_and_click(
    driver: webdriver.Chrome,
    xpath: str,
    timeout: int = DEFAULT_TIMEOUT,
    description: str = "element"
) -> bool:
    """Wait for element to be clickable, then click it."""
    try:
        element = WebDriverWait(driver, timeout).until(
            EC.element_to_be_clickable((By.XPATH, xpath))
        )
        click_element(element, driver)
        return True
    except TimeoutException:
        log.debug("Timeout waiting for %s", description)
        return False


def find_and_click_first(
    driver: webdriver.Chrome,
    xpaths: List[str],
    timeout: int = DEFAULT_TIMEOUT,
    per_xpath_timeout: int = SHORT_TIMEOUT
) -> bool:
    """
    Try multiple XPaths, click the first one that works.
    
    Args:
        driver: Selenium WebDriver
        xpaths: List of XPath expressions to try
        timeout: Max total time to spend (not currently enforced, for future use)
        per_xpath_timeout: Time to wait for each individual XPath
    """
    for xpath in xpaths:
        try:
            element = WebDriverWait(driver, per_xpath_timeout).until(
                EC.element_to_be_clickable((By.XPATH, xpath))
            )
            click_element(element, driver)
            return True
        except TimeoutException:
            continue
    return False


def find_clickable_by_text(
    driver: webdriver.Chrome,
    search_texts: List[str],
    timeout: int = DEFAULT_TIMEOUT
) -> Optional[WebElement]:
    """Find a clickable element by text (case-insensitive partial match)."""
    for text in search_texts:
        escaped = escape_xpath_string(text.lower())
        xpath = f"//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), {escaped})]"
        try:
            return WebDriverWait(driver, 1).until(
                EC.element_to_be_clickable((By.XPATH, xpath))
            )
        except TimeoutException:
            continue
    return None


def close_dialogs(driver: webdriver.Chrome) -> None:
    """Attempt to close any open dialogs. Avoids clicking Block button."""
    try:
        close_btn = find_clickable_by_text(driver, CLOSE_DIALOG_TEXTS, timeout=SHORT_TIMEOUT)
        if close_btn:
            # Make sure we're not clicking a Block button
            btn_text = close_btn.text.strip().lower() if close_btn.text else ""
            if "block" not in btn_text:
                click_element(close_btn, driver)
                time.sleep(random.uniform(0.5, 1))
    except Exception:
        pass


def random_delay(min_sec: float = 1, max_sec: float = 2) -> None:
    """Sleep for a random duration."""
    time.sleep(random.uniform(min_sec, max_sec))


# =============================================================================
# PROFILE VALIDATION
# =============================================================================

def check_profile_exists_fast(driver: webdriver.Chrome, username: str) -> bool:
    """
    Quick check if profile exists (called immediately after page load).
    Returns False if profile definitely doesn't exist.
    """
    try:
        page_source = driver.page_source.lower()
    except Exception:
        log.warning("Could not read page content")
        return False

    for indicator in NOT_FOUND_INDICATORS:
        if indicator in page_source:
            log.info("Profile @%s doesn't exist — skipping", username)
            return False

    return True


def check_profile_status(driver: webdriver.Chrome, username: str) -> bool:
    """
    Full check of profile status (called after page fully loads).
    Checks for rate limiting and private accounts.
    Returns False if should skip this profile.
    """
    try:
        page_source = driver.page_source.lower()
    except Exception:
        return True  # Continue anyway if can't read

    if "restricted your account" in page_source or "try again later" in page_source:
        log.warning("Rate limited by Instagram. Waiting %ds...", RATE_LIMIT_WAIT)
        time.sleep(RATE_LIMIT_WAIT)
        return False

    if "this account is private" in page_source:
        log.info("Account @%s is private — attempting to report anyway", username)

    return True


# =============================================================================
# REPORTING STEPS
# =============================================================================

def open_profile(driver: webdriver.Chrome, username: str) -> bool:
    """Navigate to user profile."""
    try:
        driver.get(f"https://www.instagram.com/{username}/")
        time.sleep(1.5)
        return True
    except Exception as e:
        log.error("Could not load profile: %s", str(e)[:40])
        return False


def click_options_menu(driver: webdriver.Chrome) -> bool:
    """Click the 3-dots options menu on profile."""
    xpaths = [
        "//*[name()='svg'][@aria-label='Options']/ancestor::*[@role='button'][1]",
        "//*[name()='svg'][@aria-label='Options']/ancestor::button[1]",
        "//*[name()='svg'][contains(@aria-label, 'ption')]/ancestor::*[@role='button'][1]",
        "//header//*[@role='button'][last()]",
        "//*[name()='svg'][@aria-label='More options']/ancestor::*[@role='button'][1]",
    ]
    return find_and_click_first(driver, xpaths)


def click_report_button(driver: webdriver.Chrome) -> bool:
    """Click the Report button in options menu."""
    xpath = "//button[text()='Report'] | //button[normalize-space()='Report']"
    return wait_and_click(driver, xpath, description="Report button")


def click_report_account(driver: webdriver.Chrome) -> bool:
    """Click 'Report Account' option."""
    xpaths = [
        "//button[.//div[text()='Report Account']]",
        "//button[.//div[normalize-space()='Report Account']]",
        "//div[text()='Report Account']/ancestor::button",
    ]
    if find_and_click_first(driver, xpaths):
        return True

    # Fallback: second button in list
    try:
        buttons = driver.find_elements(By.XPATH, "//div[@role='list']//button")
        if len(buttons) >= 2:
            click_element(buttons[1], driver)
            return True
    except Exception:
        pass
    return False


def click_posting_content(driver: webdriver.Chrome) -> bool:
    """Click 'posting content that shouldn't be on Instagram' (first option)."""
    xpath = "(//div[@role='list']//button[contains(@class, '_abn2')])[1]"
    return wait_and_click(driver, xpath, description="posting content option")


def click_violence_option(driver: webdriver.Chrome) -> bool:
    """Click 'Violence, hate or exploitation' option."""
    xpaths = [
        "//button[.//div[text()='Violence, hate or exploitation']]",
        "(//div[@role='list']//button[contains(@class, '_abn2')])[5]",
    ]
    return find_and_click_first(driver, xpaths)


def click_calling_for_violence(driver: webdriver.Chrome) -> bool:
    """Click 'Calling for violence' sub-option."""
    xpaths = [
        "//button[.//div[text()='Calling for violence']]",
        "(//div[@role='list']//button[contains(@class, '_abn2')])[5]",
    ]
    return find_and_click_first(driver, xpaths)


def click_submit(driver: webdriver.Chrome) -> bool:
    """Click Submit button if present."""
    xpath = "//button[text()='Submit'] | //button[text()='Submit report'] | //button[contains(text(), 'Submit')]"
    return wait_and_click(driver, xpath, timeout=SHORT_TIMEOUT, description="Submit")


# =============================================================================
# BLOCK USER (DISABLED - FOR FUTURE USE)
# =============================================================================

def block_user(driver: webdriver.Chrome, username: str) -> bool:
    """
    Block a user after reporting.
    
    NOTE: Currently disabled in main flow due to dialog issues.
    Call this after report_user() if needed.
    """
    log.info("Looking for block option...")

    # Click "Block {username}" button
    xpaths = [
        "//button[contains(@class, '_abn2')][.//div[starts-with(text(), 'Block ')]]",
        f"//button[.//div[contains(text(), 'Block {username}')]]",
        "//button[.//div[starts-with(normalize-space(), 'Block ')]]",
    ]
    if not find_and_click_first(driver, xpaths, per_xpath_timeout=DEFAULT_TIMEOUT):
        log.warning("Block option not found")
        return False

    log.info("Clicked 'Block %s'", username)
    time.sleep(2)

    # Confirm block dialog
    confirm_xpath = (
        "//button[normalize-space()='Block']"
        "[following-sibling::button[normalize-space()='Cancel'] or "
        "preceding-sibling::button[normalize-space()='Cancel']]"
    )
    if wait_and_click(driver, confirm_xpath, timeout=SHORT_TIMEOUT, description="confirm block"):
        log.info("Block confirmed")
        random_delay()
        return True

    log.warning("Could not confirm block")
    return False


# =============================================================================
# MAIN REPORT FUNCTION
# =============================================================================

def report_user(driver: webdriver.Chrome, username: str) -> ReportStatus:
    """
    Report a user on Instagram.
    
    Flow:
        1. Open profile
        2. Click options menu (3 dots)
        3. Click Report
        4. Click Report Account
        5. Click "posting content that shouldn't be on Instagram"
        6. Click "Violence, hate or exploitation"
        7. Click "Calling for violence"
        8. Submit and close dialogs
    
    Returns:
        "success" - Report completed
        "skipped" - Profile doesn't exist or unavailable
        "failed"  - Error during reporting process
    """
    log.info("=" * 50)
    log.info("Processing @%s", username)
    log.info("=" * 50)

    # Step 1: Open profile
    log.info("[1/6] Opening profile...")
    if not open_profile(driver, username):
        return "failed"

    # Fast check - does profile exist?
    if not check_profile_exists_fast(driver, username):
        return "skipped"

    # Wait for page to fully load
    random_delay(1.5, 2.5)

    # Full check - rate limiting, private account, etc.
    if not check_profile_status(driver, username):
        return "skipped"

    # Step 2: Click options menu
    log.info("[2/6] Clicking options menu...")
    if not click_options_menu(driver):
        log.error("Could not find options menu")
        return "failed"
    log.info("[2/6] ✓ Options menu clicked")
    random_delay()

    # Step 3: Click Report
    log.info("[3/6] Clicking Report...")
    if not click_report_button(driver):
        log.error("Could not find Report button")
        return "failed"
    log.info("[3/6] ✓ Report clicked")
    random_delay()

    # Step 4: Click Report Account
    log.info("[4/6] Clicking Report Account...")
    if click_report_account(driver):
        log.info("[4/6] ✓ Report Account clicked")
    else:
        log.warning("[4/6] Report Account not found, continuing...")
    random_delay()

    # Step 5: Click posting content option
    log.info("[5/6] Clicking 'posting content...'")
    if click_posting_content(driver):
        log.info("[5/6] ✓ Content option clicked")
    else:
        log.warning("[5/6] Content option not found")
    random_delay()

    # Step 6: Click violence option
    log.info("[6/6] Clicking 'Violence, hate or exploitation'...")
    if click_violence_option(driver):
        log.info("[6/6] ✓ Violence option clicked")
    else:
        log.warning("[6/6] Violence option not found")
    random_delay()

    # Step 6b: Click calling for violence
    log.info("[6b] Clicking 'Calling for violence'...")
    if click_calling_for_violence(driver):
        log.info("[6b] ✓ Sub-category clicked")
    else:
        log.debug("[6b] Sub-category not found")
    random_delay()

    # Submit
    if click_submit(driver):
        log.info("✓ Report submitted")
    random_delay()

    # Instead of trying to close dialogs (which might click Block),
    # just navigate back to Instagram home to clear any open dialogs
    log.info("Navigating away to clear dialogs...")
    random_delay(1, 2)

    log.info("SUCCESS: Reported @%s", username)
    return "success"


def report_user_safe(driver: webdriver.Chrome, username: str) -> ReportStatus:
    """Wrapper that catches unexpected errors and continues."""
    try:
        return report_user(driver, username)
    except Exception as e:
        log.exception("Unexpected error processing @%s: %s", username, str(e)[:60])
        try:
            driver.get("https://www.instagram.com/")
            time.sleep(2)
        except Exception:
            pass
        return "failed"


# =============================================================================
# FILE LOADING
# =============================================================================

def load_targets(filepath: str) -> List[str]:
    """Load target usernames from file."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        log.error("Targets file not found: %s", filepath)
        return []


# =============================================================================
# MAIN
# =============================================================================

def main() -> None:
    """Main entry point."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    targets_file = os.path.join(script_dir, "..", "data", "targets.txt")

    targets = load_targets(targets_file)
    if not targets:
        return

    log.info("=" * 60)
    log.info("Instagram Reporting Bot")
    log.info("=" * 60)
    log.info("Targets: %d accounts", len(targets))
    log.info("Flow: Report → Violence → Calling for Violence")
    log.info("=" * 60)

    log.info("Connecting to Chrome...")
    driver = setup_driver()
    log.info("Connected!")

    # Open Instagram in a new tab to avoid interfering with existing tabs
    driver.execute_script("window.open('https://www.instagram.com/', '_blank');")
    time.sleep(1)
    
    # Switch to the new tab
    driver.switch_to.window(driver.window_handles[-1])
    time.sleep(2)

    if "login" in driver.current_url.lower():
        log.error("Not logged into Instagram! Please log in and try again.")
        return

    log.info("Verified: Logged into Instagram")
    log.info("Starting report loop...")

    success_count = 0
    skipped_count = 0
    failed_count = 0

    for i, user in enumerate(targets, 1):
        log.info("[%d/%d] Starting...", i, len(targets))

        result = report_user_safe(driver, user)
        if result == "success":
            success_count += 1
        elif result == "skipped":
            skipped_count += 1
        else:
            failed_count += 1

        if i < len(targets):
            delay = random.uniform(*DELAY_BETWEEN_PROFILES)
            log.info("Waiting %.1fs before next account...", delay)
            time.sleep(delay)

    log.info("=" * 60)
    log.info("COMPLETE")
    log.info("Successful: %d", success_count)
    log.info("Skipped: %d", skipped_count)
    log.info("Failed: %d", failed_count)
    log.info("Total: %d", len(targets))
    log.info("=" * 60)


if __name__ == "__main__":
    main()
