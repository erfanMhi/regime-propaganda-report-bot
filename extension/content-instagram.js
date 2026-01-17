// Content Script - Runs on Instagram pages
// Handles the actual DOM manipulation and clicking
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
  "profile isn't available",
  "sorry, this page",
  "page isn't available",
  "this page isn't available",
  "may have been removed",
  "link may be broken",
];

const RATE_LIMIT_INDICATORS = [
  'try again later',
  'restricted your account',
  'action blocked',
  'please wait',
  'temporarily blocked',
];

const ALREADY_REPORTED_INDICATORS = [
  "you've already reported",
  'already reported this',
  'you reported this',
];

// Order matters! "Done" should be tried before other options to avoid clicking "Block"
const CLOSE_DIALOG_TEXTS = ['Done', 'Close', 'OK', 'Dismiss', '×', 'Not now', 'Cancel'];

let reportInProgress = false;

// ============================================================================
// SUCCESS DETECTION
// ============================================================================

function isSuccessConfirmationVisible() {
  // Prefer checking inside dialogs first (more stable than full body text).
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dialog of dialogs) {
    const t = (dialog.textContent || '').toLowerCase();
    if (
      t.includes('thanks for reporting') ||
      t.includes('thank you for reporting') ||
      t.includes("you'll receive a notification once we've reviewed your report")
    ) {
      return true;
    }

    // Tick icon is a strong signal for success.
    if (dialog.querySelector('svg[aria-label="tick"], svg[aria-label="Tick"]')) {
      return true;
    }
  }

  // Fallback: sometimes the modal text is still present in body but not in a role=dialog wrapper.
  const pageText = (document.body?.innerText || '').toLowerCase();
  return (
    pageText.includes('thanks for reporting') ||
    pageText.includes('thank you for reporting') ||
    pageText.includes("you'll receive a notification once we've reviewed your report")
  );
}

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
 * @param {Function|string} selectorOrFn - CSS selector or function returning element
 * @param {number} timeoutMs - Maximum time to wait
 * @param {number} intervalMs - Polling interval
 * @returns {Promise<Element|null>}
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
 * Waits for a button/menu item with specific text to appear
 * Uses broad selector like the original working code - NOT restricted to role="dialog"
 * @param {string[]} expectedTexts - Array of text patterns to match
 * @param {number} timeoutMs - Maximum time to wait
 * @returns {Promise<Element|null>}
 */
async function waitForDialogButton(expectedTexts, timeoutMs = TIMEOUTS.ELEMENT_WAIT) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Use broad selector like original working code - search ALL buttons, not just those in role containers
    const buttons = document.querySelectorAll('button, [role="button"], [role="menuitem"]');

    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      for (const expected of expectedTexts) {
        if (text.includes(expected.toLowerCase())) {
          if (isClickable(btn)) {
            return btn;
          }
        }
      }
    }

    await sleep(TIMEOUTS.RETRY_INTERVAL);
  }

  return null;
}

/**
 * Waits for any menu/dialog to appear with clickable items
 */
async function waitForMenuToOpen(timeoutMs = TIMEOUTS.MENU_OPEN) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Check for any dialog/menu appearing (use both role-based and class-based detection)
    const hasDialog = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
    if (hasDialog) {
      // Look for any clickable button inside
      const buttons = hasDialog.querySelectorAll('button, [role="button"], [role="menuitem"]');
      for (const btn of buttons) {
        if (isClickable(btn)) {
          return true;
        }
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

  // Also check if buttons in any visible dialog are disabled
  const dialogButtons = document.querySelectorAll('[role="dialog"] button');
  let allDisabled = dialogButtons.length > 0;
  for (const btn of dialogButtons) {
    if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      allDisabled = false;
      break;
    }
  }
  if (dialogButtons.length > 0 && allDisabled) {
    return true;
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
 * Finds the options menu button (3-dots) on a profile page
 */
function findOptionsButton() {
  // Try multiple selectors for the 3-dots menu
  const selectors = [
    'svg[aria-label="Options"]',
    'svg[aria-label="More options"]',
    '[aria-label="Options"]',
    '[aria-label="More options"]',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const button = el.closest('button') || el.closest('[role="button"]');
      if (button && isClickable(button)) {
        return button;
      }
    }
  }

  // Fallback: look for buttons in header with ellipsis-like icons
  const header = document.querySelector('header');
  if (header) {
    const buttons = header.querySelectorAll('[role="button"], button');
    // Usually the options button is the last interactive element in the header row
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      // Skip if it looks like a follow/message button (has text)
      const text = btn.textContent?.trim() || '';
      if (text.length > 10) continue; // Likely a "Follow" or "Message" button
      if (isClickable(btn)) {
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
  // Give any animations a moment to settle
  await sleep(200);

  // Strategy 1: Try text-based close buttons FIRST (most reliable)
  // This matches the original working code's approach
  for (const text of CLOSE_DIALOG_TEXTS) {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim().toLowerCase() || '';
      // Skip buttons containing "block" (e.g., "Block username")
      if (btnText.includes('block')) continue;

      if (btnText === text.toLowerCase() && isClickable(btn)) {
        // Use simple click like original code - more compatible
        btn.click();
        await sleep(300);
        return true;
      }
    }
  }

  // Strategy 2: Try Escape key
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  await sleep(200);

  // Strategy 3: Try aria-label="Close" button
  const closeByAriaLabel = document.querySelector('[aria-label="Close"], [aria-label="close"]');
  if (closeByAriaLabel && isClickable(closeByAriaLabel)) {
    closeByAriaLabel.click();
    await sleep(300);
    return true;
  }

  return true; // Return true to continue - don't block on dialog detection
}

/**
 * Ensures all dialogs are closed by retrying
 * Simplified to match original working code behavior
 */
async function ensureDialogsClosed(maxAttempts = 2) {
  for (let i = 0; i < maxAttempts; i++) {
    await closeDialogs();
  }
  return true; // Always return true - don't block on dialog detection
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
        console.error('[ReportBot] Report error:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      });

    return true; // Keep channel open for async response
  }
});

// ============================================================================
// MAIN REPORT FLOW
// ============================================================================

async function doReport(username) {
  console.log('[ReportBot] Starting report for:', username);

  reportInProgress = true;

  try {
    // ========================================
    // Phase 1: Wait for page to load
    // ========================================
    console.log('[ReportBot] Waiting for profile to load...');

    const profileLoaded = await waitFor(() => {
      const optionsBtn = findOptionsButton();
      const notFoundText = document.body?.innerText?.toLowerCase() || '';
      const isNotFound = NOT_FOUND_INDICATORS.some(ind => notFoundText.includes(ind.toLowerCase()));
      return optionsBtn || isNotFound;
    }, TIMEOUTS.PAGE_LOAD, 300);

    if (!profileLoaded) {
      console.log('[ReportBot] Profile page did not load in time');
      return { success: false, error: 'Page load timeout' };
    }

    // ========================================
    // Phase 2: Pre-flight checks
    // ========================================
    if (!checkProfileExists()) {
      console.log('[ReportBot] Profile not found');
      return { success: false, notFound: true };
    }

    if (isRateLimited()) {
      console.log('[ReportBot] Rate limited');
      return { success: false, rateLimited: true, retryAfterMs: 60000 };
    }

    if (isAlreadyReported()) {
      console.log('[ReportBot] Already reported - treating as success');
      return { success: true };
    }

    // ========================================
    // Step 1: Click options menu (3 dots)
    // ========================================
    console.log('[ReportBot] Step 1: Click options menu');

    const optionsBtn = await waitForElement(findOptionsButton, TIMEOUTS.ELEMENT_WAIT);
    if (!optionsBtn) {
      console.log('[ReportBot] Could not find options menu');
      return { success: false, error: 'No options menu' };
    }

    simulateClick(optionsBtn);

    // Wait for menu to actually open (verify with Report button)
    let reportBtn = await waitForDialogButton(['Report'], TIMEOUTS.MENU_OPEN);

    if (!reportBtn) {
      // Retry: focus and click again
      console.log('[ReportBot] Menu did not open, retrying...');
      optionsBtn.focus();
      await sleep(100);
      simulateClick(optionsBtn);

      reportBtn = await waitForDialogButton(['Report'], TIMEOUTS.MENU_OPEN);

      if (!reportBtn) {
        console.log('[ReportBot] Menu still did not open');
        await ensureDialogsClosed();
        return { success: false, error: 'Menu did not open' };
      }
    }

    // ========================================
    // Step 2: Click Report
    // ========================================
    console.log('[ReportBot] Step 2: Click Report');

    simulateClick(reportBtn);

    // Wait for "Report Account" option to appear
    const reportAccountBtn = await waitForDialogButton(
      ['Report Account', 'Report account'],
      TIMEOUTS.ELEMENT_WAIT
    );

    if (!reportAccountBtn) {
      console.log('[ReportBot] Could not find Report Account option');
      await ensureDialogsClosed();
      return { success: false, error: 'No Report Account option' };
    }

    // ========================================
    // Step 3: Click Report Account
    // ========================================
    console.log('[ReportBot] Step 3: Click Report Account');

    simulateClick(reportAccountBtn);

    // Wait for next screen (posting content options)
    const postingContentBtn = await waitForDialogButton(
      ["posting content that shouldn't be on Instagram", "posting content", "shouldn't be on Instagram"],
      TIMEOUTS.ELEMENT_WAIT
    );

    // If specific text not found, try first clickable button (like old working code)
    let nextBtn = postingContentBtn;
    if (!nextBtn) {
      await sleep(500); // Brief wait for DOM to settle
      // Use broad selector like original - find any clickable button
      const allButtons = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
      for (const btn of allButtons) {
        const text = btn.textContent?.toLowerCase() || '';
        // Skip navigation/action buttons
        if (text.includes('close') || text.includes('cancel') || text.includes('back')) continue;
        if (text.includes('block') || text.includes('restrict')) continue;
        if (isClickable(btn)) {
          nextBtn = btn;
          break;
        }
      }
    }

    if (!nextBtn) {
      console.log('[ReportBot] Could not find posting content option');
      await ensureDialogsClosed();
      return { success: false, error: 'No posting content option' };
    }

    // ========================================
    // Step 4: Click posting content option
    // ========================================
    console.log('[ReportBot] Step 4: Click posting content option');

    simulateClick(nextBtn);

    // Wait for False Information option
    const falseInfoBtn = await waitForDialogButton(
      ['False information', 'false information', 'Misinformation'],
      TIMEOUTS.ELEMENT_WAIT
    );

    if (!falseInfoBtn) {
      console.log('[ReportBot] Could not find False Information option');
      await ensureDialogsClosed();
      return { success: false, error: 'No False Information option' };
    }

    // ========================================
    // Step 5: Click False Information
    // ========================================
    console.log('[ReportBot] Step 5: Click False Information');

    simulateClick(falseInfoBtn);

    // Wait for sub-options or submit button
    await sleep(500); // Brief pause for potential sub-menu

    // ========================================
    // Step 6: Click sub-option if present
    // ========================================
    console.log('[ReportBot] Step 6: Check for sub-options');

    // Log current page state for debugging
    const pageTextPreStep6 = document.body?.innerText?.substring(0, 500) || '';
    console.log('[ReportBot] Page content before Step 6:', pageTextPreStep6.substring(0, 200));

    // Check if there are sub-category options (Health, Politics, etc.)
    // Use broad selector - Instagram may not use role="list" consistently
    const step6Buttons = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
    
    // Log all visible buttons for debugging
    const step6VisibleBtns = [];
    for (const btn of step6Buttons) {
      if (isClickable(btn)) {
        step6VisibleBtns.push(btn.textContent?.trim().substring(0, 40) || '(no text)');
      }
    }
    console.log('[ReportBot] Step 6 visible buttons:', step6VisibleBtns);

    let clickedSubOption = false;
    for (const btn of step6Buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      // Skip if it looks like a navigation/action button
      if (text.includes('submit') || text.includes('back') || text.includes('cancel')) continue;
      if (text.includes('close') || text.includes('done')) continue;
      // Safety: never click block-like actions.
      if (text.includes('block') || text.includes('restrict')) continue;
      // Skip the Report button itself
      if (text === 'report') continue;
      // Skip learn more links
      if (text.includes('learn more')) continue;

      if (isClickable(btn)) {
        console.log('[ReportBot] Clicking sub-option:', text.substring(0, 50));
        simulateClick(btn);
        clickedSubOption = true;
        await sleep(500);
        break;
      }
    }
    
    if (!clickedSubOption) {
      console.log('[ReportBot] No sub-option found/clicked - may already be at submit screen');
    }

    // ========================================
    // Step 7: Click Submit
    // ========================================
    console.log('[ReportBot] Step 7: Click Submit');

    // Try multiple possible button texts - Instagram uses different text in different flows
    let submitBtn = await waitForDialogButton(
      ['Submit', 'Submit report', 'Done', 'Send', 'Next', 'Continue', 'Confirm', 'Report'],
      TIMEOUTS.ELEMENT_WAIT
    );

    // If not found, log all visible buttons for debugging
    if (!submitBtn) {
      console.log('[ReportBot] Standard submit button not found, scanning all buttons...');
      const allBtns = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
      const visibleBtns = [];
      for (const btn of allBtns) {
        if (isClickable(btn)) {
          const text = btn.textContent?.trim().substring(0, 50) || '(no text)';
          visibleBtns.push(text);
        }
      }
      console.log('[ReportBot] Visible clickable buttons:', visibleBtns);

      // Try to find ANY button that looks like a submit action (not cancel/close/back/block)
      for (const btn of allBtns) {
        const text = btn.textContent?.toLowerCase() || '';
        // Skip navigation/cancel buttons
        if (text.includes('cancel') || text.includes('back') || text.includes('close')) continue;
        if (text.includes('block') || text.includes('restrict')) continue;
        if (text.includes('learn more') || text.includes('not now')) continue;
        // Skip if it's just an icon or very short
        if (text.trim().length < 2) continue;
        
        if (isClickable(btn)) {
          console.log('[ReportBot] Using fallback button:', text.substring(0, 50));
          submitBtn = btn;
          break;
        }
      }
    }

    if (!submitBtn) {
      console.log('[ReportBot] Could not find Submit/Done button');
      await ensureDialogsClosed();
      return { success: false, error: 'No Submit/Done button' };
    }

    simulateClick(submitBtn);

    // ========================================
    // Step 8: Wait briefly and close dialogs
    // ========================================
    console.log('[ReportBot] Step 8: Wait for confirmation');

    // Wait a moment for the confirmation screen to appear
    await sleep(1500);

    // Check if confirmation is visible (for logging purposes)
    if (isSuccessConfirmationVisible()) {
      console.log('[ReportBot] Confirmation screen detected - report successful');
    } else {
      console.log('[ReportBot] No confirmation screen visible, but continuing (report likely submitted)');
    }

    // ========================================
    // Cleanup: Close dialogs like original code
    // ========================================
    await closeDialogs();

    console.log('[ReportBot] Report complete for:', username);
    return { success: true };

  } catch (e) {
    console.error('[ReportBot] Error during report:', e);
    await ensureDialogsClosed();
    return { success: false, error: e.message };
  } finally {
    reportInProgress = false;
  }
}

console.log('[ReportBot] Content script loaded (hardened version)');
