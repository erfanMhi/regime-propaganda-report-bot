// Content Script for X - Runs on x.com and twitter.com
// Handles the actual DOM manipulation and clicking for X reporting
// Hardened version with adaptive waiting and robust element detection

(function() {
// Guard against double injection
if (window.__reportBotTwitterLoaded) return;
window.__reportBotTwitterLoaded = true;

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

// Generic "page not found" indicators (account never existed, suspended, etc.)
const NOT_FOUND_INDICATORS = [
  "this account doesn't exist",
  "account doesn't exist",
  "hmm...this page doesn't exist",
];

// Specific indicators for blocked/unavailable profiles (we blocked them, or they blocked us)
// These show a specific error when viewing a profile we've already blocked
const PROFILE_UNAVAILABLE_INDICATORS = [
  "account suspended",
  "this account has been suspended",
  "this account is temporarily unavailable",
  "you're blocked",
  "you blocked",
  "you have blocked",
  "is blocked",  // "@username is blocked" shown in empty state
  "viewing posts won't unblock",  // Specific text shown on blocked profile
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

// ============================================================================
// FOLLOW ACTION SAFEGUARDS - Prevent accidentally clicking Follow buttons
// ============================================================================

/**
 * Blocklist of follow/social action terms in multiple languages.
 * These are actions we must NEVER perform - only reporting is allowed.
 */
const FOLLOW_ACTION_TEXTS = [
  // English
  'follow', 'following', 'unfollow', 'follow back', 'message', 'subscribe',
  // Spanish
  'seguir', 'siguiendo', 'dejar de seguir',
  // French
  'suivre', 'suivi', 'abonné', "s'abonner", 'se désabonner',
  // German
  'folgen', 'gefolgt', 'entfolgen',
  // Portuguese
  'seguindo', 'deixar de seguir',
  // Italian
  'segui', 'seguiti', 'smetti di seguire',
  // Turkish
  'takip et', 'takip ediliyor', 'takibi bırak',
  // Dutch
  'volgen', 'volgend', 'ontvolgen',
  // Polish
  'obserwuj', 'obserwujesz', 'przestań obserwować',
  // Russian
  'подписаться', 'подписки', 'отписаться',
  // Persian/Farsi
  'دنبال کردن', 'دنبال می‌کنید', 'لغو دنبال',
  // Arabic
  'متابعة', 'تتابع', 'إلغاء المتابعة',
  // Chinese (Simplified & Traditional)
  '关注', '已关注', '取消关注', '關注', '已關注', '取消關注',
  // Japanese
  'フォロー', 'フォロー中', 'フォローを解除',
  // Korean
  '팔로우', '팔로잉', '언팔로우',
  // Hindi
  'फ़ॉलो करें', 'फ़ॉलो कर रहे हैं',
];

/**
 * Patterns for data-testid that indicate follow/unfollow buttons.
 * Twitter uses format like "1234567890-follow" or "1234567890-unfollow"
 */
const FOLLOW_TESTID_PATTERNS = [
  /-follow$/i,
  /-unfollow$/i,
  /^follow$/i,
  /^unfollow$/i,
];

/**
 * Normalize text for comparison - lowercase, trim, collapse whitespace
 */
function normalizeText(text) {
  return String(text || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Check if text matches any follow action label
 */
function isFollowActionLabel(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  
  return FOLLOW_ACTION_TEXTS.some((label) => {
    if (normalized === label) return true;
    if (normalized.startsWith(`${label} `)) return true;
    // Check if the primary word is a follow action
    const words = normalized.split(/\s+/);
    if (words.length === 1 && words[0] === label) return true;
    if (words.length <= 3 && words.includes(label)) return true;
    return false;
  });
}

/**
 * Check if an element's data-testid indicates a follow button
 */
function hasFollowTestId(el) {
  if (!el) return false;
  const testId = el.getAttribute('data-testid') || '';
  if (!testId) return false;
  return FOLLOW_TESTID_PATTERNS.some(pattern => pattern.test(testId));
}

/**
 * Check if an element (or its button ancestor) is a follow action.
 * Uses multiple detection strategies for robustness.
 */
function isFollowActionElement(el) {
  if (!el) return false;
  
  // Check the element itself and its closest button ancestor
  const targets = [el];
  const btnAncestor = el.closest('button, [role="button"]');
  if (btnAncestor && btnAncestor !== el) {
    targets.push(btnAncestor);
  }
  
  for (const target of targets) {
    // Strategy 1: Check data-testid pattern (most reliable for Twitter)
    if (hasFollowTestId(target)) {
      console.log('[ReportBot X] BLOCKED: data-testid indicates follow button');
      return true;
    }
    
    // Strategy 2: Check aria-label for "Follow @" pattern
    const ariaLabel = target.getAttribute('aria-label') || '';
    if (/^follow\s*@/i.test(ariaLabel) || /^unfollow\s*@/i.test(ariaLabel)) {
      console.log('[ReportBot X] BLOCKED: aria-label indicates follow button:', ariaLabel);
      return true;
    }
    if (isFollowActionLabel(ariaLabel)) {
      console.log('[ReportBot X] BLOCKED: aria-label matches blocklist:', ariaLabel);
      return true;
    }
    
    // Strategy 3: Check visible text content
    const text = target.textContent || '';
    if (isFollowActionLabel(text)) {
      console.log('[ReportBot X] BLOCKED: text content matches blocklist:', text.substring(0, 50));
      return true;
    }
    
    // Strategy 4: Check title attribute
    const title = target.getAttribute('title') || '';
    if (isFollowActionLabel(title)) {
      console.log('[ReportBot X] BLOCKED: title matches blocklist:', title);
      return true;
    }
  }
  
  return false;
}

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
 * 
 * SAFETY: Refuses to click any element identified as a follow action.
 */
function simulateClick(el) {
  if (!el) return false;

  // CRITICAL SAFETY CHECK: Never click follow buttons
  if (isFollowActionElement(el)) {
    console.warn('[ReportBot X] BLOCKED: Refused to click follow action element');
    return false;
  }

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
 * 
 * SAFETY: Returns false for any follow action element.
 */
function isClickable(el) {
  if (!el || !el.isConnected) return false;

  // SAFETY: Follow action elements are never "clickable" for our purposes
  if (isFollowActionElement(el)) return false;

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

/**
 * Checks if the profile is unavailable (already blocked, suspended, or blocked us).
 * These are different from 404s - the account exists but is inaccessible.
 * 
 * A blocked profile shows:
 * - Button with data-testid ending in "-unblock" showing "Blocked" text
 * - Empty state with data-testid="emptyState" containing "@username is blocked"
 * - Text "Viewing posts won't unblock @username"
 * 
 * @returns {boolean} true if profile is unavailable (should skip without counting)
 */
function isProfileUnavailable() {
  const pageText = document.body?.innerText?.toLowerCase() || '';
  
  // Check 1: Look for "Unblock" button (data-testid ending with "-unblock")
  // This is the most reliable indicator - shows "Blocked" button on blocked profiles
  const unblockBtn = document.querySelector('[data-testid$="-unblock"]');
  if (unblockBtn) {
    console.log('[ReportBot X] Profile unavailable: Found Unblock button (already blocked)');
    return true;
  }
  
  // Check 2: Look for the empty state header that says "@username is blocked"
  const emptyStateHeader = document.querySelector('[data-testid="empty_state_header_text"]');
  if (emptyStateHeader) {
    const headerText = (emptyStateHeader.textContent || '').toLowerCase();
    if (headerText.includes('is blocked')) {
      console.log('[ReportBot X] Profile unavailable: Found "is blocked" in empty state header');
      return true;
    }
  }
  
  // Check 3: Look for the empty state body with "viewing posts won't unblock"
  const emptyStateBody = document.querySelector('[data-testid="empty_state_body_text"]');
  if (emptyStateBody) {
    const bodyText = (emptyStateBody.textContent || '').toLowerCase();
    if (bodyText.includes("viewing posts won't unblock") || bodyText.includes("won't unblock")) {
      console.log('[ReportBot X] Profile unavailable: Found unblock text in empty state body');
      return true;
    }
  }
  
  // Check 4: Text-based indicators as fallback
  for (const indicator of PROFILE_UNAVAILABLE_INDICATORS) {
    if (pageText.includes(indicator.toLowerCase())) {
      // For "is blocked", require it to be preceded by @ to avoid false positives
      if (indicator === 'is blocked') {
        // Check if it's in the context of "@username is blocked"
        if (pageText.includes('@') && pageText.includes('is blocked')) {
          console.log('[ReportBot X] Profile unavailable: Found "@...is blocked" pattern');
          return true;
        }
      } else {
        console.log('[ReportBot X] Profile unavailable: Found indicator:', indicator);
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Checks if the profile exists (generic 404 / not found check)
 * This is different from isProfileUnavailable() - this catches generic 404s.
 * 
 * @returns {boolean} true if profile exists, false if 404
 */
function checkProfileExists() {
  const pageText = document.body?.innerText?.toLowerCase() || '';
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
  // Primary: data-testid="userActions" (the 3-dots menu on profile)
  const userActions = document.querySelector('[data-testid="userActions"]');
  if (userActions && isClickable(userActions)) {
    // Double-check: userActions should NEVER be a follow button, but verify anyway
    if (!isFollowActionElement(userActions)) {
      return userActions;
    }
    console.warn('[ReportBot X] userActions element unexpectedly flagged as follow action');
  }

  // Fallback: aria-label="More" - but verify it's not a follow button
  const moreButton = document.querySelector('[aria-label="More"]');
  if (moreButton && isClickable(moreButton)) {
    // Extra safety: ensure this isn't somehow a follow button
    if (!isFollowActionElement(moreButton)) {
      return moreButton;
    }
    console.warn('[ReportBot X] More button unexpectedly flagged as follow action');
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
// POST-REPORT BLOCK FLOW
// ============================================================================

/**
 * Finds the Block @username menu item in the options menu
 * @param {string} username - The username to block
 */
function findBlockMenuItem(username) {
  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();

  // Look for "Block @username" menu item with data-testid="block"
  for (const item of menuItems) {
    const testId = item.getAttribute('data-testid') || '';
    if (testId === 'block' && isClickable(item)) {
      return item;
    }
  }

  // Strong match: "Block @username"
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (normalizedUsername && t.includes(`block @${normalizedUsername}`) && isClickable(item)) {
      return item;
    }
  }

  // Fallback: any "Block @" item
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if ((t.startsWith('block @') || t.includes('block @')) && isClickable(item)) {
      return item;
    }
  }

  return null;
}

/**
 * Finds the Block confirmation button in the confirmation dialog
 * Uses data-testid="confirmationSheetConfirm" which is specific to Twitter
 */
function findBlockConfirmButton() {
  // Primary: data-testid="confirmationSheetConfirm"
  const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
  if (confirmBtn && isClickable(confirmBtn)) {
    const text = (confirmBtn.textContent || '').toLowerCase();
    // Make sure it says "Block" and not something else
    if (text.includes('block')) {
      return confirmBtn;
    }
  }

  // Fallback: look for confirmation dialog with "Block" button
  const dialogs = document.querySelectorAll('[data-testid="confirmationSheetDialog"], [role="dialog"]');
  for (const dialog of dialogs) {
    const buttons = dialog.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      // Look for exact "block" button (not "unblock" or "block and report")
      if (text === 'block' && isClickable(btn)) {
        return btn;
      }
    }
  }

  return null;
}

/**
 * Checks if we see "Unblock" in the menu or button, indicating already blocked
 */
function isAlreadyBlocked() {
  // Check for unblock button with data-testid pattern
  const unblockBtn = document.querySelector('[data-testid$="-unblock"]');
  if (unblockBtn) return true;

  // Check for "Unblock" in menu items
  const menuItems = document.querySelectorAll('[role="menuitem"]');
  for (const item of menuItems) {
    const text = (item.textContent || '').toLowerCase();
    if (text.includes('unblock') && isClickable(item)) {
      return true;
    }
  }

  return false;
}

/**
 * Performs the block sequence after a report is finished:
 * 1. Click the 3-dots options button
 * 2. Click "Block @username" in the menu
 * 3. Click "Block" in the confirmation dialog
 */
async function performBlockSequence(username) {
  console.log('[ReportBot X] ========================================');
  console.log('[ReportBot X] BLOCK SEQUENCE: Starting for', username);
  console.log('[ReportBot X] ========================================');

  // Ensure any lingering dialogs are closed first
  await ensureDialogsClosed();
  await sleep(300);

  // Step 1: Click options button (3 dots)
  console.log('[ReportBot X] BLOCK: Step 1 - Finding options button...');
  const optionsBtn = await waitForElement(findOptionsButton, TIMEOUTS.ELEMENT_WAIT);
  
  if (!optionsBtn) {
    console.log('[ReportBot X] BLOCK: FAILED - Could not find options button');
    return { success: false, error: 'No options menu for block' };
  }

  console.log('[ReportBot X] BLOCK: Clicking options button...');
  simulateClick(optionsBtn);

  // Wait for menu to open
  const menuOpened = await waitForMenuToOpen(TIMEOUTS.MENU_OPEN);
  if (!menuOpened) {
    console.log('[ReportBot X] BLOCK: Menu did not open, retrying...');
    optionsBtn.focus();
    await sleep(100);
    simulateClick(optionsBtn);
    
    const retryMenuOpened = await waitForMenuToOpen(TIMEOUTS.MENU_OPEN);
    if (!retryMenuOpened) {
      console.log('[ReportBot X] BLOCK: FAILED - Menu still did not open');
      await ensureDialogsClosed();
      return { success: false, error: 'Menu did not open for block' };
    }
  }

  // Check if already blocked (would show "Unblock" instead)
  if (isAlreadyBlocked()) {
    console.log('[ReportBot X] BLOCK: Account already blocked - skipping');
    await ensureDialogsClosed();
    return { success: true, alreadyBlocked: true };
  }

  // Step 2: Click Block @username menu item
  console.log('[ReportBot X] BLOCK: Step 2 - Finding Block menu item...');
  const blockMenuItem = await waitForElement(() => findBlockMenuItem(username), TIMEOUTS.ELEMENT_WAIT);
  
  if (!blockMenuItem) {
    console.log('[ReportBot X] BLOCK: FAILED - Could not find Block menu item');
    // Log what menu items are visible
    const menuItems = document.querySelectorAll('[role="menuitem"]');
    const visibleItems = [];
    for (const item of menuItems) {
      if (isClickable(item)) {
        visibleItems.push(item.textContent?.trim().substring(0, 40) || '(no text)');
      }
    }
    console.log('[ReportBot X] BLOCK: Visible menu items:', visibleItems);
    await ensureDialogsClosed();
    return { success: false, error: 'No Block option in menu' };
  }

  console.log('[ReportBot X] BLOCK: Clicking Block menu item:', blockMenuItem.textContent?.trim());
  simulateClick(blockMenuItem);

  // Step 3: Wait for confirmation dialog and click Block
  console.log('[ReportBot X] BLOCK: Step 3 - Waiting for confirmation dialog...');
  const confirmBtn = await waitForElement(findBlockConfirmButton, TIMEOUTS.ELEMENT_WAIT);
  
  if (!confirmBtn) {
    console.log('[ReportBot X] BLOCK: FAILED - Could not find Block confirmation button');
    // Log what dialogs are visible
    const dialogs = document.querySelectorAll('[role="dialog"], [data-testid="confirmationSheetDialog"]');
    console.log('[ReportBot X] BLOCK: Dialogs found:', dialogs.length);
    for (const d of dialogs) {
      console.log('[ReportBot X] BLOCK: Dialog content:', d.textContent?.substring(0, 100));
    }
    await ensureDialogsClosed();
    return { success: false, error: 'No Block confirmation button' };
  }

  console.log('[ReportBot X] BLOCK: Clicking Block confirmation button...');
  simulateClick(confirmBtn);

  // Wait for the dialog to close (indicates block was successful)
  await sleep(1000);
  
  const dialogClosed = await waitFor(() => {
    const dialog = document.querySelector('[data-testid="confirmationSheetDialog"]');
    return !dialog || !isClickable(dialog.querySelector('button'));
  }, TIMEOUTS.ELEMENT_WAIT, TIMEOUTS.RETRY_INTERVAL);

  if (dialogClosed) {
    console.log('[ReportBot X] ========================================');
    console.log('[ReportBot X] BLOCK SEQUENCE: Completed successfully!');
    console.log('[ReportBot X] ========================================');
  } else {
    console.log('[ReportBot X] BLOCK: Confirmation dialog may still be open, but continuing');
  }

  // Wait 4 seconds on success for user review
  console.log('[ReportBot X] BLOCK: Waiting 4 seconds for user review...');
  await sleep(4000);

  return { success: true };
}

/**
 * Checks for and executes any pending block from a previous page load
 */
async function checkAndExecutePendingBlock() {
  const pendingUsername = localStorage.getItem('reportbot_twitter_pending_block');
  if (!pendingUsername) {
    return;
  }
  
  // Prevent concurrent operations
  if (reportInProgress) {
    console.log('[ReportBot X] Report already in progress, skipping pending block');
    return;
  }
  
  console.log('[ReportBot X] ========================================');
  console.log('[ReportBot X] PENDING BLOCK DETECTED for:', pendingUsername);
  console.log('[ReportBot X] ========================================');
  
  // Clear the flag immediately to prevent re-execution
  localStorage.removeItem('reportbot_twitter_pending_block');
  
  // Set the flag to prevent concurrent operations
  reportInProgress = true;
  
  try {
    // Wait for page to be ready - verify options button OR unavailable state
    console.log('[ReportBot X] Waiting for page to be ready...');
    
    const pageReady = await waitFor(() => {
      const optionsBtn = findOptionsButton();
      const isUnavailable = isProfileUnavailable();
      return !!optionsBtn || isUnavailable;
    }, TIMEOUTS.PAGE_LOAD, 300);
    
    if (!pageReady) {
      console.log('[ReportBot X] Page did not become ready in time');
      return;
    }
    
    // Check if profile is unavailable (already blocked or suspended)
    if (isProfileUnavailable()) {
      console.log('[ReportBot X] Profile unavailable after reload - block already complete or account suspended');
      try {
        chrome.runtime.sendMessage({
          action: 'blockComplete',
          username: pendingUsername,
          success: true,
          alreadyUnavailable: true
        });
      } catch (e) {
        console.log('[ReportBot X] Could not notify extension:', e.message);
      }
      return;
    }
    
    console.log('[ReportBot X] Page is ready, executing block sequence...');
    
    // Verify URL matches expected username
    const currentUrl = window.location.href;
    console.log('[ReportBot X] Current URL:', currentUrl);
    
    const urlLower = currentUrl.toLowerCase();
    const usernameLower = pendingUsername.toLowerCase();
    if (!urlLower.includes('/' + usernameLower) && !urlLower.includes('/' + usernameLower + '/')) {
      console.log('[ReportBot X] WARNING: Current URL does not match expected username');
      console.log('[ReportBot X] Expected:', pendingUsername);
      console.log('[ReportBot X] Proceeding anyway...');
    }
    
    // Execute the block sequence
    const blockResult = await performBlockSequence(pendingUsername);
    
    if (blockResult.success) {
      console.log('[ReportBot X] ========================================');
      console.log('[ReportBot X] BLOCK COMPLETED SUCCESSFULLY!');
      console.log('[ReportBot X] ========================================');
    } else {
      console.log('[ReportBot X] Block sequence failed:', blockResult.error || 'Unknown error');
    }
    
    // Notify the popup/background that block is complete
    try {
      chrome.runtime.sendMessage({
        action: 'blockComplete',
        username: pendingUsername,
        success: blockResult.success,
        error: blockResult.error
      });
    } catch (e) {
      console.log('[ReportBot X] Could not notify extension:', e.message);
    }
  } finally {
    reportInProgress = false;
  }
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
      const pageText = document.body?.innerText?.toLowerCase() || '';
      
      // Check for any "page ready" indicators:
      // 1. Options button or profile header visible (normal profile)
      // 2. Generic 404 page
      // 3. Unavailable profile (suspended, blocked, etc.)
      const isNotFound = NOT_FOUND_INDICATORS.some(ind => pageText.includes(ind.toLowerCase()));
      const isUnavailable = PROFILE_UNAVAILABLE_INDICATORS.some(ind => pageText.includes(ind.toLowerCase()));
      
      return userActions || profileHeader || isNotFound || isUnavailable;
    }, TIMEOUTS.PAGE_LOAD, 300);

    if (!profileLoaded) {
      console.log('[ReportBot X] Profile page did not load in time');
      return { success: false, error: 'Page load timeout' };
    }

    // ========================================
    // Phase 2: Pre-flight checks
    // ========================================
    
    // FIRST: Check if profile is unavailable (already blocked by us, suspended, etc.)
    // This is a fast skip - no report or block needed, don't count toward pause
    if (isProfileUnavailable()) {
      console.log('[ReportBot X] Profile unavailable (blocked/suspended) - skipping fast');
      return { 
        success: false, 
        unavailable: true, 
        message: 'Profile unavailable (already blocked or suspended)' 
      };
    }
    
    if (!checkProfileExists()) {
      console.log('[ReportBot X] Profile not found (404)');
      return { success: false, notFound: true };
    }

    if (isRateLimited()) {
      console.log('[ReportBot X] Rate limited');
      return { success: false, rateLimited: true, retryAfterMs: 60000 };
    }

    if (isAlreadyReported()) {
      console.log('[ReportBot X] Already reported - proceeding to block flow');
      const blockResult = await performBlockSequence(username);
      if (!blockResult.success) {
        console.log('[ReportBot X] Block sequence failed:', blockResult.error || 'Unknown');
        return { success: false, error: blockResult.error || 'Block sequence failed' };
      }
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

    // Wait for the report dialog with options to appear (look for "Violent & hateful entities" option)
    const violentEntitiesOption = await waitForRadioOption(['Violent & hateful entities', 'Violent and hateful entities'], TIMEOUTS.ELEMENT_WAIT);

    if (!violentEntitiesOption) {
      console.log('[ReportBot X] Could not find Violent & hateful entities option');
      await ensureDialogsClosed();
      return { success: false, error: 'No Violent & hateful entities option' };
    }

    // ========================================
    // Step 3: Click Violent & hateful entities option
    // ========================================
    console.log('[ReportBot X] Step 3: Click Violent & hateful entities option');

    // Click the label or its radio input
    const radio = violentEntitiesOption.querySelector('input[type="radio"]');
    if (radio) {
      simulateClick(radio);
      await sleep(100);
    }
    simulateClick(violentEntitiesOption);

    // After clicking this option, it goes directly to the confirmation screen
    // Wait for the confirmation screen with "Thanks for helping" or "Submitted" text
    console.log('[ReportBot X] Step 4: Wait for confirmation screen');

    const confirmationFound = await waitFor(() => {
      const pageText = document.body.innerText.toLowerCase();
      return pageText.includes('thanks for helping') ||
             pageText.includes('submitted') ||
             pageText.includes('your report is in our queue');
    }, TIMEOUTS.ELEMENT_WAIT, TIMEOUTS.RETRY_INTERVAL);

    if (confirmationFound) {
      console.log('[ReportBot X] Confirmation screen detected - report successful');
      didSubmit = true;

      // Click the Done button on the confirmation dialog
      const doneBtn = await waitForElement(findNextButton, TIMEOUTS.POST_CLICK_VERIFY);
      if (doneBtn) {
        console.log('[ReportBot X] Step 5: Click Done button');
        simulateClick(doneBtn);
        await sleep(500);
      }
    } else {
      console.log('[ReportBot X] No confirmation screen found, trying to click Next/Submit anyway');
      const nextBtn = await waitForElement(findNextButton, TIMEOUTS.POST_CLICK_VERIFY);
      if (nextBtn) {
        simulateClick(nextBtn);
        didSubmit = true;
        await sleep(500);
      }
    }

    // ========================================
    // Cleanup
    // ========================================
    await ensureDialogsClosed();

    console.log('[ReportBot X] Report complete for:', username);
    if (!didSubmit) {
      return { success: false, error: 'Report did not reach submit step' };
    }

    // ========================================
    // Post-report: Store pending block and reload page
    // ========================================
    console.log('[ReportBot X] Step 6: Scheduling block after page reload...');
    
    // Store the username for blocking after reload
    localStorage.setItem('reportbot_twitter_pending_block', username);
    console.log('[ReportBot X] Stored pending block for:', username);
    
    // IMPORTANT: We need to return success BEFORE reloading, otherwise the
    // message channel will be destroyed and the background script will time out.
    // We use setTimeout to delay the reload so the response can be sent first.
    console.log('[ReportBot X] Report complete! Scheduling page reload for block...');
    
    // Schedule reload after a short delay to allow response to be sent
    setTimeout(() => {
      console.log('[ReportBot X] Reloading page now...');
      window.location.reload();
    }, 100);
    
    // Return success immediately - block will happen after reload
    return { success: true, pendingBlock: true };

  } catch (e) {
    console.error('[ReportBot X] Error during report:', e);
    await ensureDialogsClosed();
    return { success: false, error: e.message };
  } finally {
    reportInProgress = false;
  }
}

// Check for pending blocks when the script loads
checkAndExecutePendingBlock();

console.log('[ReportBot X] Content script loaded (hardened version)');

})();
