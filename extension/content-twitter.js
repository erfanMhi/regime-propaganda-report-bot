// Content Script for X - Runs on x.com and twitter.com
// Handles the actual DOM manipulation and clicking for X reporting
// Hardened version with adaptive waiting and robust element detection

// ============================================================================
// CONFIGURATION
// ============================================================================

const TIMEOUTS = {
  PAGE_LOAD: 15000,        // Initial page load
  ELEMENT_WAIT: 8000,      // Waiting for UI elements
  MENU_OPEN: 5000,         // Waiting for menu to open after click
  RETRY_INTERVAL: 150,     // Polling interval
  POST_CLICK_VERIFY: 3000, // Quick verify after click
};

const NOT_FOUND_INDICATORS = [
  "this account doesn't exist",
  "account suspended",
  "this account has been suspended",
  "account doesn't exist",
  "hmm...this page doesn't exist",
  "this account is temporarily unavailable",
];

const RATE_LIMIT_INDICATORS = [
  'try again later',
  'rate limit',
  'too many requests',
  'temporarily unavailable',
];

const ALREADY_REPORTED_INDICATORS = [
  'you reported this account',
  "you've already reported",
  'already submitted a report',
];

const CLOSE_DIALOG_TEXTS = ['Close', 'Done', 'OK', 'Dismiss', '×', 'Cancel', 'Not now'];

let reportInProgress = false;

// ============================================================================
// CORE HELPER FUNCTIONS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simulates a realistic click event with mousedown, mouseup, and click.
 * This works better with React-based UIs that may not respond to synthetic .click()
 */
function simulateClick(el) {
  if (!el) return false;

  // Use standard scroll behavior; non-standard values can throw in some Chromium builds.
  el.scrollIntoView({ block: 'center', behavior: 'auto' });

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const eventOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
  };

  // Some React/UIs attach handlers to pointer events; include both pointer+mouse.
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(type => {
    el.dispatchEvent(new MouseEvent(type, eventOptions));
  });

  return true;
}

/**
 * Checks if an element is actually clickable (visible, not disabled, not hidden)
 * Note: Does NOT check viewport position since simulateClick() handles scrolling
 */
function isClickable(el) {
  if (!el || !el.isConnected) return false;

  try {
    const style = getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.pointerEvents === 'none') return false;
    if (parseFloat(style.opacity) < 0.1) return false;

    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Waits for an element to appear and be clickable
 */
async function waitForElement(selectorOrFn, timeoutMs = TIMEOUTS.ELEMENT_WAIT, intervalMs = TIMEOUTS.RETRY_INTERVAL) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const el = typeof selectorOrFn === 'function'
        ? selectorOrFn()
        : document.querySelector(selectorOrFn);

      if (el && isClickable(el)) {
        return el;
      }
    } catch (e) {
      // Element might not exist yet, continue polling
    }
    await sleep(intervalMs);
  }

  return null;
}

/**
 * Waits for a radio/label option with specific text
 */
async function waitForRadioOption(expectedTexts, timeoutMs = TIMEOUTS.ELEMENT_WAIT) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const labels = document.querySelectorAll('label');

    for (const label of labels) {
      const text = label.textContent?.toLowerCase() || '';
      for (const expected of expectedTexts) {
        if (text.includes(expected.toLowerCase())) {
          if (isClickable(label)) {
            return label;
          }
        }
      }
    }

    // Fallback: look for any clickable element with the text
    const allClickable = document.querySelectorAll('div[role="option"], div[role="radio"], [role="option"], [role="radio"], span, button');
    for (const expected of expectedTexts) {
      for (const el of allClickable) {
        const elText = el.textContent?.trim().toLowerCase() || '';
        if ((elText === expected.toLowerCase() || elText.startsWith(expected.toLowerCase())) && isClickable(el)) {
          // Prefer returning the closest semantic/clickable container.
          return (
            el.closest('label, button, [role="radio"], [role="option"]') ||
            el
          );
        }
      }
    }

    await sleep(TIMEOUTS.RETRY_INTERVAL);
  }

  return null;
}

/**
 * Waits until an element is detached or no longer visibly clickable.
 */
async function waitForElementToDisappear(el, timeoutMs = TIMEOUTS.ELEMENT_WAIT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!el || !el.isConnected) return true;
    if (!isClickable(el)) return true;
    await sleep(TIMEOUTS.RETRY_INTERVAL);
  }
  return false;
}

/**
 * Waits for a screen transition by checking that old options disappear
 * This ensures we don't look for new elements while old screen is still visible
 */
async function waitForScreenTransition(oldOptionTexts, timeoutMs = TIMEOUTS.ELEMENT_WAIT) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Check if any of the old options are still visible
    const labels = document.querySelectorAll('label');
    let oldOptionFound = false;

    for (const label of labels) {
      const text = label.textContent?.toLowerCase() || '';
      for (const oldText of oldOptionTexts) {
        if (text.includes(oldText.toLowerCase()) && isClickable(label)) {
          oldOptionFound = true;
          break;
        }
      }
      if (oldOptionFound) break;
    }

    // If old options are gone, transition is complete
    if (!oldOptionFound) {
      await sleep(200); // Brief pause for new content to render
      return true;
    }

    await sleep(TIMEOUTS.RETRY_INTERVAL);
  }

  // Timeout - old screen might still be visible, but continue anyway
  return false;
}

/**
 * Waits for menu items to appear (indicates menu opened)
 */
async function waitForMenuToOpen(timeoutMs = TIMEOUTS.MENU_OPEN) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const menuItems = document.querySelectorAll('[role="menuitem"]');
    for (const item of menuItems) {
      if (isClickable(item)) {
        return true;
      }
    }
    await sleep(TIMEOUTS.RETRY_INTERVAL);
  }

  return false;
}

/**
 * General condition waiter (for backward compatibility and complex conditions)
 */
async function waitFor(conditionFn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (conditionFn()) return true;
    } catch (e) {
      // ignore and retry
    }
    await sleep(intervalMs);
  }
  return false;
}

// ============================================================================
// PRE-FLIGHT CHECKS
// ============================================================================

function checkProfileExists() {
  const pageText = document.body.innerText.toLowerCase();
  for (const indicator of NOT_FOUND_INDICATORS) {
    if (pageText.includes(indicator.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function isRateLimited() {
  const pageText = document.body.innerText.toLowerCase();
  for (const indicator of RATE_LIMIT_INDICATORS) {
    if (pageText.includes(indicator.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function isAlreadyReported() {
  const pageText = document.body.innerText.toLowerCase();
  for (const indicator of ALREADY_REPORTED_INDICATORS) {
    if (pageText.includes(indicator.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// ELEMENT FINDERS
// ============================================================================

/**
 * Finds the userActions button (3-dots menu)
 */
function findOptionsButton() {
  // Primary: data-testid
  const userActions = document.querySelector('[data-testid="userActions"]');
  if (userActions && isClickable(userActions)) {
    return userActions;
  }

  // Fallback: aria-label="More"
  const moreButton = document.querySelector('[aria-label="More"]');
  if (moreButton && isClickable(moreButton)) {
    return moreButton;
  }

  return null;
}

/**
 * Finds the report menu item for a specific username
 */
function findReportMenuItem(username) {
  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();

  // Strong match first: "Report @username"
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (normalizedUsername && t.includes(`report @${normalizedUsername}`) && isClickable(item)) {
      return item;
    }
  }

  // Next best: any "Report @" item
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if ((t.startsWith('report @') || t.includes('report @')) && isClickable(item)) {
      return item;
    }
  }

  // Fallback: any "Report" menu item
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if ((t === 'report' || t.startsWith('report')) && isClickable(item)) {
      return item;
    }
  }

  return null;
}

/**
 * Finds a Next/Submit/Continue button
 */
function findNextButton() {
  // First try the specific data-testid
  const choiceButton = document.querySelector('[data-testid="ChoiceSelectionNextButton"]');
  if (choiceButton && isClickable(choiceButton)) {
    return choiceButton;
  }

  // Look for button by text
  const buttonTexts = ['next', 'submit', 'continue', 'done'];
  const buttons = document.querySelectorAll('button, [role="button"]');

  for (const btn of buttons) {
    if (!isClickable(btn)) continue;
    const btnText = btn.textContent?.trim().toLowerCase() || '';
    for (const text of buttonTexts) {
      if (btnText === text) {
        return btn;
      }
    }
  }

  return null;
}

// ============================================================================
// DIALOG MANAGEMENT
// ============================================================================

/**
 * Closes any open dialogs - tries fastest methods first
 */
async function closeDialogs() {
  await sleep(200);

  // Strategy 1: Try Escape key first (fastest)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
  await sleep(200);

  // Check if any dialogs still open
  const dialogStillOpen = document.querySelector('[role="dialog"], [aria-modal="true"]');
  if (!dialogStillOpen) return true;

  // Strategy 2: Try aria-label="Close" button
  const closeByAriaLabel = document.querySelector('[aria-label="Close"], [aria-label="close"]');
  if (closeByAriaLabel && isClickable(closeByAriaLabel)) {
    simulateClick(closeByAriaLabel);
    await sleep(300);
  }

  // Strategy 3: Try text-based close buttons
  for (const text of CLOSE_DIALOG_TEXTS) {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim().toLowerCase() || '';
      const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
      if ((btnText === text.toLowerCase() || ariaLabel === text.toLowerCase()) && !btnText.includes('block') && isClickable(btn)) {
        simulateClick(btn);
        await sleep(300);
        if (!document.querySelector('[role="dialog"], [aria-modal="true"]')) {
          return true;
        }
      }
    }
  }

  return !document.querySelector('[role="dialog"], [aria-modal="true"]');
}

/**
 * Ensures all dialogs are closed by retrying
 */
async function ensureDialogsClosed(maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    if (!document.querySelector('[role="dialog"], [aria-modal="true"]')) {
      return true;
    }
    await closeDialogs();
  }
  return !document.querySelector('[role="dialog"], [aria-modal="true"]');
}

// ============================================================================
// MESSAGE LISTENER
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'PING') {
    sendResponse({ pong: true });
    return;
  }

  if (message.type === 'DO_REPORT') {
    if (reportInProgress) {
      sendResponse({ success: false, error: 'Busy' });
      return;
    }

    doReport(message.username)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[ReportBot X] Report error:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      });

    return true; // Keep channel open for async response
  }
});

// ============================================================================
// MAIN REPORT FLOW
// ============================================================================

async function doReport(username) {
  console.log('[ReportBot X] Starting report for:', username);

  reportInProgress = true;
  let didSubmit = false;

  try {
    // ========================================
    // Phase 1: Wait for page to load
    // ========================================
    console.log('[ReportBot X] Waiting for profile to load...');

    const profileLoaded = await waitFor(() => {
      const userActions = document.querySelector('[data-testid="userActions"]');
      const profileHeader = document.querySelector('[data-testid="UserName"]');
      const notFoundText = document.body?.innerText?.toLowerCase() || '';
      const isNotFound = NOT_FOUND_INDICATORS.some(ind => notFoundText.includes(ind.toLowerCase()));
      return userActions || profileHeader || isNotFound;
    }, TIMEOUTS.PAGE_LOAD, 300);

    if (!profileLoaded) {
      console.log('[ReportBot X] Profile page did not load in time');
      return { success: false, error: 'Page load timeout' };
    }

    // ========================================
    // Phase 2: Pre-flight checks
    // ========================================
    if (!checkProfileExists()) {
      console.log('[ReportBot X] Profile not found');
      return { success: false, notFound: true };
    }

    if (isRateLimited()) {
      console.log('[ReportBot X] Rate limited');
      return { success: false, rateLimited: true, retryAfterMs: 60000 };
    }

    if (isAlreadyReported()) {
      console.log('[ReportBot X] Already reported - treating as success');
      return { success: true };
    }

    // ========================================
    // Step 1: Click options menu (3 dots)
    // ========================================
    console.log('[ReportBot X] Step 1: Click options menu (3 dots)');

    const optionsBtn = await waitForElement(findOptionsButton, TIMEOUTS.ELEMENT_WAIT);
    if (!optionsBtn) {
      console.log('[ReportBot X] Could not find options menu');
      return { success: false, error: 'No options menu' };
    }

    simulateClick(optionsBtn);

    // Wait for menu to open - verify by looking for Report menu item
    const menuOpened = await waitForMenuToOpen(TIMEOUTS.MENU_OPEN);

    if (!menuOpened) {
      // Retry: focus and click again
      console.log('[ReportBot X] Menu did not open, retrying...');
      optionsBtn.focus();
      await sleep(100);
      simulateClick(optionsBtn);

      const retryMenuOpened = await waitForMenuToOpen(TIMEOUTS.MENU_OPEN);
      if (!retryMenuOpened) {
        console.log('[ReportBot X] Menu still did not open');
        await ensureDialogsClosed();
        return { success: false, error: 'Menu did not open' };
      }
    }

    // ========================================
    // Step 2: Click Report @username
    // ========================================
    console.log('[ReportBot X] Step 2: Click Report button');

    const reportBtn = await waitForElement(() => findReportMenuItem(username), TIMEOUTS.ELEMENT_WAIT);
    if (!reportBtn) {
      console.log('[ReportBot X] Could not find Report button');
      await ensureDialogsClosed();
      return { success: false, error: 'No Report button' };
    }

    simulateClick(reportBtn);

    // Wait for the report dialog with options to appear (look for "Hate" option)
    const hateOption = await waitForRadioOption(['Hate'], TIMEOUTS.ELEMENT_WAIT);

    if (!hateOption) {
      console.log('[ReportBot X] Could not find Hate option');
      await ensureDialogsClosed();
      return { success: false, error: 'No Hate option' };
    }

    // ========================================
    // Step 3: Click Hate option
    // ========================================
    console.log('[ReportBot X] Step 3: Click Hate option');

    // Click the label or its radio input
    const radio = hateOption.querySelector('input[type="radio"]');
    if (radio) {
      simulateClick(radio);
      await sleep(100);
    }
    simulateClick(hateOption);

    // Wait for Next button to be clickable (required in most flows)
    const nextBtn1 = await waitForElement(findNextButton, TIMEOUTS.ELEMENT_WAIT);
    if (!nextBtn1) {
      console.log('[ReportBot X] Could not find Next button after Hate');
      await ensureDialogsClosed();
      return { success: false, error: 'No Next button after Hate' };
    }

    console.log('[ReportBot X] Step 3b: Click Next after Hate');
    simulateClick(nextBtn1);

    // CRITICAL: Wait for screen transition - the previous option should disappear
    // before we look for "Dehumanization". Prefer waiting on the actual element.
    console.log('[ReportBot X] Waiting for screen transition...');
    await waitForElementToDisappear(hateOption, TIMEOUTS.ELEMENT_WAIT);

    // Wait for Dehumanization option
    const dehumanOption = await waitForRadioOption(['Dehumanization'], TIMEOUTS.ELEMENT_WAIT);

    if (!dehumanOption) {
      console.log('[ReportBot X] Could not find Dehumanization option');
      await ensureDialogsClosed();
      return { success: false, error: 'No Dehumanization option' };
    }

    // ========================================
    // Step 4: Click Dehumanization option
    // ========================================
    console.log('[ReportBot X] Step 4: Click Dehumanization option');

    const radio2 = dehumanOption.querySelector('input[type="radio"]');
    if (radio2) {
      simulateClick(radio2);
      await sleep(100);
    }
    simulateClick(dehumanOption);

    // ========================================
    // Step 5: Click Submit
    // ========================================
    console.log('[ReportBot X] Step 5: Click Submit');

    const submitBtn = await waitForElement(findNextButton, TIMEOUTS.ELEMENT_WAIT);
    if (!submitBtn) {
      console.log('[ReportBot X] Could not find Submit/Next button');
      await ensureDialogsClosed();
      return { success: false, error: 'No Submit/Next button' };
    }

    simulateClick(submitBtn);
    didSubmit = true;

    // Wait a moment for any confirmation screen
    await sleep(1000);

    // ========================================
    // Step 6: Click any additional confirmation
    // ========================================
    console.log('[ReportBot X] Step 6: Click any confirmation');

    const confirmBtn = await waitForElement(findNextButton, TIMEOUTS.POST_CLICK_VERIFY);
    if (confirmBtn) {
      simulateClick(confirmBtn);
    }

    // ========================================
    // Cleanup
    // ========================================
    await sleep(500);
    await ensureDialogsClosed();

    console.log('[ReportBot X] Report complete for:', username);
    if (!didSubmit) {
      return { success: false, error: 'Report did not reach submit step' };
    }
    return { success: true };

  } catch (e) {
    console.error('[ReportBot X] Error during report:', e);
    await ensureDialogsClosed();
    return { success: false, error: e.message };
  } finally {
    reportInProgress = false;
  }
}

console.log('[ReportBot X] Content script loaded (hardened version)');
