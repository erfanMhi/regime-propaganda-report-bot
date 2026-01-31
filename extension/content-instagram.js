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

// Generic "page not found" indicators (profile never existed, broken link, etc.)
const NOT_FOUND_INDICATORS = [
  "sorry, this page",
  "page isn't available",
  "this page isn't available",
];

// Specific indicators for blocked/unavailable profiles (already blocked by us, or profile was removed)
// These show a specific error page with "Profile isn't available" message
const PROFILE_UNAVAILABLE_INDICATORS = [
  "profile isn't available",
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
// CRITICAL: These must NEVER be clicked - guards at multiple levels
// Includes English + common translations (Spanish, French, German, Portuguese, Italian, Turkish, Dutch, Polish, Russian)
const FOLLOW_ACTION_TEXTS = [
  // English
  'follow', 'follow back', 'following', 'requested', 'request', 'unfollow', 'message', 'call',
  // Spanish
  'seguir', 'siguiendo', 'solicitado', 'dejar de seguir', 'mensaje', 'llamar',
  // French
  'suivre', 'suivi', 'suivie', 'abonné', 'abonnée', "s'abonner", 'se désabonner',
  // German
  'folgen', 'gefolgt', 'angefordert', 'entfolgen', 'nachricht', 'anrufen',
  // Portuguese
  'seguindo', 'solicitada', 'deixar de seguir', 'mensagem', 'ligar',
  // Italian
  'segui', 'seguiti', 'segui già', 'richiesto', 'smetti di seguire', 'messaggio', 'chiama',
  // Turkish
  'takip et', 'takip ediliyor', 'takibi bırak', 'mesaj', 'ara',
  // Dutch
  'volgen', 'volgend', 'ontvolgen', 'bericht', 'bellen',
  // Polish
  'obserwuj', 'obserwujesz', 'przestań obserwować', 'wiadomość', 'zadzwoń',
  // Russian
  'подписаться', 'подписки', 'отписаться', 'сообщение', 'позвонить',
  // Persian/Farsi
  'دنبال کردن', 'دنبال می‌کنید', 'لغو دنبال', 'پیام',
  // Arabic
  'متابعة', 'تتابع', 'إلغاء المتابعة', 'رسالة', 'اتصال',
  // Chinese (Simplified & Traditional)
  '关注', '已关注', '取消关注', '關注', '已關注', '取消關注', '私信', '发消息',
  // Japanese
  'フォロー', 'フォロー中', 'フォローする', 'フォローを解除', 'メッセージ',
  // Korean
  '팔로우', '팔로잉', '언팔로우', '팔로우하기', '메시지',
  // Hindi
  'फ़ॉलो करें', 'फ़ॉलो कर रहे हैं', 'अनफ़ॉलो करें', 'संदेश',
  // Thai
  'ติดตาม', 'กำลังติดตาม', 'เลิกติดตาม',
  // Vietnamese
  'theo dõi', 'đang theo dõi', 'bỏ theo dõi',
];

const BLOCK_ACTION_TEXTS = ['block'];
const BLOCK_NEGATIVE_TEXTS = ['unblock', 'block and report', 'block & report'];

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

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isFollowActionLabel(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  // Check for exact match, starts with, or contains the follow action text
  // This catches "Follow", "Follow Back", "Following", etc. in any context
  return FOLLOW_ACTION_TEXTS.some((label) => {
    if (normalized === label) return true;
    if (normalized.startsWith(`${label} `)) return true;
    // Also block if the ONLY word is a follow action (handles whitespace variations)
    const words = normalized.split(/\s+/);
    if (words.length === 1 && words[0] === label) return true;
    if (words.length <= 2 && words.includes(label)) return true;
    return false;
  });
}

function isFollowActionElement(el) {
  if (!el || typeof el.closest !== 'function') return false;
  const buttonEl = el.closest('button, [role="button"]') || el;
  const text = normalizeText(buttonEl.textContent);
  const ariaLabel = normalizeText(buttonEl.getAttribute && buttonEl.getAttribute('aria-label'));
  const title = normalizeText(buttonEl.getAttribute && buttonEl.getAttribute('title'));
  return isFollowActionLabel(text) || isFollowActionLabel(ariaLabel) || isFollowActionLabel(title);
}

function getElementLabelCandidates(el) {
  if (!el) return [];
  return [
    normalizeText(el.textContent),
    normalizeText(el.getAttribute && el.getAttribute('aria-label')),
    normalizeText(el.getAttribute && el.getAttribute('title')),
  ].filter(Boolean);
}

function isBlockActionLabel(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (BLOCK_NEGATIVE_TEXTS.some((blocked) => normalized.includes(blocked))) return false;
  return BLOCK_ACTION_TEXTS.some((label) => (
    normalized === label || normalized.startsWith(`${label} `)
  ));
}

/**
 * Simulates a realistic click event with mousedown, mouseup, and click.
 * This works better with React-based UIs that may not respond to synthetic .click()
 */
function simulateClick(el) {
  if (!el) return false;
  if (isFollowActionElement(el)) {
    console.warn('[ReportBot] Blocked follow action click');
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
 * Aggressive click for buttons that may require special handling (like Block button).
 * Uses multiple approaches: focus, pointer events, mouse events, keyboard, and native click.
 */
async function aggressiveClick(el) {
  if (!el) return false;
  
  console.log('[ReportBot] aggressiveClick: Starting on element:', el.textContent?.trim().substring(0, 30));
  console.log('[ReportBot] aggressiveClick: Element tag:', el.tagName, 'role:', el.getAttribute('role'));
  
  // Step 1: Scroll into view
  el.scrollIntoView({ block: 'center', behavior: 'auto' });
  await sleep(100);
  
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  
  console.log('[ReportBot] aggressiveClick: Element position x:', x, 'y:', y);
  console.log('[ReportBot] aggressiveClick: userActivation', {
    isActive: navigator.userActivation?.isActive,
    hasBeenActive: navigator.userActivation?.hasBeenActive,
  });
  
  // Verify we're clicking the right element
  const elementAtPoint = document.elementFromPoint(x, y);
  const closestButton = elementAtPoint?.closest('button, [role="button"]');
  let targetEl = el;
  if (closestButton && closestButton !== el && isClickable(closestButton)) {
    console.log('[ReportBot] aggressiveClick: Retargeting to element at point:', closestButton.textContent?.trim().substring(0, 30));
    targetEl = closestButton;
  } else {
    console.log('[ReportBot] aggressiveClick: Element at click point:', elementAtPoint?.textContent?.trim().substring(0, 30));
  }
  
  // Step 2: Focus the element
  try {
    targetEl.focus();
    console.log('[ReportBot] aggressiveClick: Focused element');
    await sleep(50);
  } catch (e) {
    console.log('[ReportBot] aggressiveClick: Focus failed:', e.message);
  }
  
  // Step 3: Try keyboard Enter (simulates pressing Enter on focused button)
  console.log('[ReportBot] aggressiveClick: Trying keyboard Enter...');
  targetEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  targetEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  targetEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  await sleep(100);
  
  // Step 4: Dispatch pointer events (for modern React apps)
  console.log('[ReportBot] aggressiveClick: Trying pointer events...');
  const pointerEventOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };
  
  try {
    targetEl.dispatchEvent(new PointerEvent('pointerdown', pointerEventOptions));
    await sleep(50);
    targetEl.dispatchEvent(new PointerEvent('pointerup', pointerEventOptions));
  } catch (e) {
    console.log('[ReportBot] aggressiveClick: PointerEvent failed:', e.message);
  }
  await sleep(100);
  
  // Step 5: Dispatch mouse events with proper timing
  console.log('[ReportBot] aggressiveClick: Trying mouse events...');
  const mouseEventOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
  };
  
  targetEl.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
  await sleep(50);
  targetEl.dispatchEvent(new MouseEvent('mouseup', mouseEventOptions));
  await sleep(50);
  targetEl.dispatchEvent(new MouseEvent('click', mouseEventOptions));
  await sleep(100);
  
  // Step 6: Try native click
  console.log('[ReportBot] aggressiveClick: Trying native click...');
  targetEl.click();
  await sleep(100);
  
  console.log('[ReportBot] aggressiveClick: Completed all click attempts');
  return true;
}

function isAriaHidden(el) {
  if (!el) return false;
  return el.closest('[aria-hidden="true"]') !== null;
}

/**
 * Checks if an element is actually clickable (visible, not disabled, not hidden)
 * Note: Does NOT check viewport position since simulateClick() handles scrolling
 */
function isClickable(el) {
  if (!el || !el.isConnected) return false;
  if (isFollowActionElement(el)) return false;

  try {
    if (isAriaHidden(el)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.pointerEvents === 'none') return false;
    if (parseFloat(style.opacity) < 0.1) return false;

    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;

    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;

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
 * @param {string} debugLabel - Optional label for debugging
 * @returns {Promise<Element|null>}
 */
async function waitForElement(selectorOrFn, timeoutMs = TIMEOUTS.ELEMENT_WAIT, intervalMs = TIMEOUTS.RETRY_INTERVAL, debugLabel = '') {
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount++;
    try {
      const el = typeof selectorOrFn === 'function'
        ? selectorOrFn()
        : document.querySelector(selectorOrFn);

      if (el && isClickable(el)) {
        if (debugLabel) console.log(`[ReportBot] waitForElement(${debugLabel}): Found after ${pollCount} polls`);
        return el;
      }
    } catch (e) {
      // Element might not exist yet, continue polling
      if (debugLabel && pollCount <= 3) console.log(`[ReportBot] waitForElement(${debugLabel}): Poll ${pollCount} threw error:`, e.message);
    }
    await sleep(intervalMs);
  }
  
  if (debugLabel) console.log(`[ReportBot] waitForElement(${debugLabel}): TIMEOUT after ${pollCount} polls (${timeoutMs}ms)`);

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
    const dialogRoot = getActiveDialogRoot() || document;
    const buttons = dialogRoot.querySelectorAll('button, [role="button"], [role="menuitem"]');

    for (const btn of buttons) {
      if (isFollowActionElement(btn)) continue;
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

function getActiveDialogRoot() {
  const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]');
  if (!dialogs.length) return null;
  return dialogs[dialogs.length - 1];
}

/**
 * SAFETY: Validates that an element is inside a dialog/menu before clicking
 * Returns false if the element is outside dialog (e.g., profile Follow button)
 */
function isInsideDialog(el) {
  if (!el) return false;
  return el.closest('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]') !== null;
}

function isInsideModalDialog(el) {
  if (!el) return false;
  return el.closest('[role="dialog"], [aria-modal="true"]') !== null;
}

/**
 * Safe click that only proceeds if element is inside a dialog
 * Used during report flow to prevent clicking profile buttons
 */
function safeDialogClick(el) {
  if (!el) return false;
  if (isFollowActionElement(el)) {
    console.warn('[ReportBot] BLOCKED: Attempted to click follow action');
    return false;
  }
  if (!isInsideDialog(el)) {
    console.warn('[ReportBot] BLOCKED: Element is outside dialog - refusing to click');
    return false;
  }
  return simulateClick(el);
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
 * Checks if the profile page shows "Profile isn't available" error.
 * This happens when:
 * 1. We've already blocked this account
 * 2. The account was removed/banned by Instagram
 * 3. The account blocked us
 * 
 * The page shows a specific error UI with:
 * - Error icon (SVG with aria-label="error")
 * - "Profile isn't available" heading
 * - "The link may be broken or the profile may have been removed." subtext
 * 
 * @returns {boolean} true if profile is unavailable (should skip without counting)
 */
function isProfileUnavailable() {
  const pageText = document.body?.innerText?.toLowerCase() || '';
  
  // Check for error icon (SVG with aria-label="error") - this is a strong signal
  const errorIcon = document.querySelector('svg[aria-label="error"]');
  
  // Check for unavailable indicators in page text
  const hasUnavailableText = PROFILE_UNAVAILABLE_INDICATORS.some(
    indicator => pageText.includes(indicator.toLowerCase())
  );
  
  // If we have both error icon AND unavailable text, it's definitely unavailable
  if (errorIcon && hasUnavailableText) {
    console.log('[ReportBot] Profile unavailable: Found error icon AND unavailable text');
    return true;
  }
  
  // Check for the specific combination: "profile isn't available" + "may have been removed"
  // This is the exact text on the blocked/removed profile page
  if (
    pageText.includes("profile isn't available") &&
    (pageText.includes("may have been removed") || pageText.includes("link may be broken"))
  ) {
    console.log('[ReportBot] Profile unavailable: Found unavailable heading + removed text');
    return true;
  }
  
  // Fallback: Check if we see error icon with any unavailable indicator
  if (errorIcon) {
    for (const indicator of PROFILE_UNAVAILABLE_INDICATORS) {
      if (pageText.includes(indicator.toLowerCase())) {
        console.log('[ReportBot] Profile unavailable: Found error icon + indicator:', indicator);
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Checks if the profile exists (generic 404 / not found check)
 * This is different from isProfileUnavailable() - this catches generic 404s
 * where the profile never existed or was permanently deleted.
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
 * @param {boolean} verbose - If true, log detailed debug info
 */
function findOptionsButton(verbose = false) {
  if (verbose) console.log('[ReportBot] findOptionsButton: Starting search...');
  
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
      if (verbose) console.log(`[ReportBot] findOptionsButton: Found element with selector "${selector}"`);
      const button = el.closest('button') || el.closest('[role="button"]');
      if (button) {
        const clickable = isClickable(button);
        if (verbose) console.log(`[ReportBot] findOptionsButton: Button found, isClickable=${clickable}`);
        if (clickable) {
          return button;
        }
      } else {
        if (verbose) console.log(`[ReportBot] findOptionsButton: Element found but no parent button`);
      }
    }
  }

  if (verbose) console.log('[ReportBot] findOptionsButton: No aria-label selector matched, trying header fallback...');

  // Fallback: look for buttons in header with ellipsis-like icons
  // The Options button (3 dots) has an SVG icon and NO text - Follow/Message have text
  const header = document.querySelector('header');
  if (header) {
    const buttons = header.querySelectorAll('[role="button"], button');
    if (verbose) console.log(`[ReportBot] findOptionsButton: Found ${buttons.length} buttons in header`);
    
    // Usually the options button is the last interactive element in the header row
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      
      // CRITICAL: Options button has an SVG icon and minimal/no visible text
      // Follow/Message buttons have text like "Follow", "Message", etc.
      const hasSvg = btn.querySelector('svg') !== null;
      const text = normalizeText(btn.textContent);
      const svgAriaLabel = btn.querySelector('svg')?.getAttribute('aria-label') || '';
      
      if (verbose) console.log(`[ReportBot] findOptionsButton: Button[${i}] hasSvg=${hasSvg}, text="${text.substring(0,30)}", svgAriaLabel="${svgAriaLabel}"`);
      
      // Skip if button has any meaningful text (Follow, Message, Edit Profile, etc.)
      // The Options button should have empty or very minimal text (just icon)
      if (text.length > 0 && !hasSvg) {
        if (verbose) console.log(`[ReportBot] findOptionsButton: Skipping - has text but no SVG`);
        continue;
      }
      
      // Skip if text matches any known action words
      if (text.length > 0) {
        const hasActionText = FOLLOW_ACTION_TEXTS.some(action => text.includes(action));
        if (hasActionText) {
          if (verbose) console.log(`[ReportBot] findOptionsButton: Skipping - contains follow action text`);
          continue;
        }
        // Also skip common profile actions
        if (text.includes('edit') || text.includes('share') || text.includes('profile')) {
          if (verbose) console.log(`[ReportBot] findOptionsButton: Skipping - contains edit/share/profile`);
          continue;
        }
      }
      
      // Prefer buttons with SVG icons (the 3-dots menu has an SVG)
      if (hasSvg && isClickable(btn)) {
        if (verbose) console.log(`[ReportBot] findOptionsButton: FOUND via header fallback at index ${i}`);
        return btn;
      }
    }
    
    // Second pass: if no SVG button found, look for truly empty buttons (icon-only)
    if (verbose) console.log('[ReportBot] findOptionsButton: First pass failed, trying second pass for empty buttons...');
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      const text = normalizeText(btn.textContent);
      // Only accept buttons with NO text at all
      if (text.length === 0 && isClickable(btn)) {
        if (verbose) console.log(`[ReportBot] findOptionsButton: FOUND empty button at index ${i}`);
        return btn;
      }
    }
  } else {
    if (verbose) console.log('[ReportBot] findOptionsButton: No header element found on page!');
  }

  if (verbose) console.log('[ReportBot] findOptionsButton: FAILED - no options button found');
  return null;
}

// ============================================================================
// DIALOG MANAGEMENT
// ============================================================================

/**
 * Closes any open dialogs - tries fastest methods first
 */
async function closeDialogs() {
  console.log('[ReportBot] closeDialogs: Starting...');
  
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
        console.log(`[ReportBot] closeDialogs: Clicking button with text "${text}"`);
        // Use simple click like original code - more compatible
        btn.click();
        await sleep(300);
        return true;
      }
    }
  }

  console.log('[ReportBot] closeDialogs: No text-based close button found, trying Escape key...');
  
  // Strategy 2: Try Escape key
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  await sleep(200);

  // Strategy 3: Try aria-label="Close" button
  const closeByAriaLabel = document.querySelector('[aria-label="Close"], [aria-label="close"]');
  if (closeByAriaLabel && isClickable(closeByAriaLabel)) {
    console.log('[ReportBot] closeDialogs: Clicking aria-label="Close" button');
    closeByAriaLabel.click();
    await sleep(300);
    return true;
  }

  console.log('[ReportBot] closeDialogs: No close method worked, returning anyway');
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
// POST-REPORT BLOCK FLOW
// ============================================================================

function findBlockMenuState() {
  const searchRoot = getActiveDialogRoot() || document;
  const buttons = searchRoot.querySelectorAll('button, [role="button"], [role="menuitem"]');
  let alreadyBlocked = false;

  for (const btn of buttons) {
    if (!isInsideDialog(btn)) continue;
    if (isFollowActionElement(btn)) continue;

    const labels = getElementLabelCandidates(btn);
    if (labels.some((label) => label.includes('unblock'))) {
      alreadyBlocked = true;
      continue;
    }

    if (labels.some((label) => isBlockActionLabel(label)) && isClickable(btn)) {
      return { blockBtn: btn, alreadyBlocked: false };
    }
  }

  return { blockBtn: null, alreadyBlocked };
}

async function waitForBlockMenuAction(timeoutMs = TIMEOUTS.MENU_OPEN) {
  const deadline = Date.now() + timeoutMs;
  let lastState = { blockBtn: null, alreadyBlocked: false };

  while (Date.now() < deadline) {
    lastState = findBlockMenuState();
    if (lastState.blockBtn || lastState.alreadyBlocked) return lastState;
    await sleep(TIMEOUTS.RETRY_INTERVAL);
  }

  return lastState;
}

function findBlockConfirmButton() {
  // Look for a button that says exactly "Block" (or "block") in any dialog
  // This is the confirmation button in the "Block username?" popup
  const activeDialog = getActiveDialogRoot();
  const dialogs = activeDialog
    ? [activeDialog]
    : Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'));
  
  for (const dialog of dialogs) {
    const buttons = dialog.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (isFollowActionElement(btn)) continue;
      if (!isClickable(btn)) continue;
      
      const text = btn.textContent?.trim().toLowerCase() || '';
      // Look for exact "block" text (not "block username", not "unblock")
      if (text === 'block') {
        return btn;
      }
    }
  }
  
  // Fallback: try the original label-based approach
  for (const dialog of dialogs) {
    const buttons = dialog.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (isFollowActionElement(btn)) continue;
      if (!isClickable(btn)) continue;
      
      const labels = getElementLabelCandidates(btn);
      if (labels.some((label) => isBlockActionLabel(label))) {
        return btn;
      }
    }
  }
  
  return null;
}

function findBlockSuccessHeading() {
  // Look for a heading that starts with "Blocked " (e.g., "Blocked yaser69_n133.")
  // The SUCCESS dialog has:
  //   - Heading: "Blocked [username]." (past tense, ends with period)
  //   - Text: "You can unblock them at any time from their profile."
  // The CONFIRMATION dialog has:
  //   - Heading: "Block [username]?" (ends with question mark)
  //   - Text: "They won't be able to find your profile..."
  
  const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
  
  for (const dialog of dialogs) {
    if (dialog.getAttribute('aria-hidden') === 'true') continue;
    const headings = dialog.querySelectorAll('h1, [role="heading"]');
    
    for (const h of headings) {
      if (isAriaHidden(h)) continue;
      const text = (h.textContent || '').trim();
      const textLower = text.toLowerCase();
      
      // SUCCESS heading: starts with "blocked " and does NOT end with "?"
      // e.g., "Blocked yaser69_n133." or "Blocked yaser69_n133"
      if (textLower.startsWith('blocked ') && !text.endsWith('?')) {
        console.log('[ReportBot] findBlockSuccessHeading: Found success heading:', text);
        return h;
      }
    }
    
    // Also check if the dialog contains the SUCCESS-specific message
    // "You can unblock them at any time" is ONLY in the success dialog
    const dialogText = (dialog.textContent || '').toLowerCase();
    if (dialogText.includes('you can unblock them at any time')) {
      console.log('[ReportBot] findBlockSuccessHeading: Found success dialog by text pattern');
      // Return the first heading from this success dialog
      for (const h of headings) {
        if (isAriaHidden(h)) continue;
        return h;
      }
    }
  }
  
  return null;
}

async function performBlockSequence() {
  console.log('[ReportBot] ========================================');
  console.log('[ReportBot] BLOCK SEQUENCE: Starting...');
  console.log('[ReportBot] ========================================');

  // Check current page state
  const currentUrl = window.location.href;
  console.log('[ReportBot] BLOCK: Current URL:', currentUrl);
  
  // Check for open dialogs before closing
  const dialogsBefore = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]');
  console.log('[ReportBot] BLOCK: Open dialogs before close attempt:', dialogsBefore.length);
  for (const d of dialogsBefore) {
    console.log('[ReportBot] BLOCK: Dialog role:', d.getAttribute('role'), 'aria-modal:', d.getAttribute('aria-modal'));
  }

  console.log('[ReportBot] BLOCK: Calling ensureDialogsClosed...');
  await ensureDialogsClosed();
  await sleep(200);

  // Check for open dialogs after closing
  const dialogsAfter = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]');
  console.log('[ReportBot] BLOCK: Open dialogs after close attempt:', dialogsAfter.length);

  // Check if header exists
  const header = document.querySelector('header');
  console.log('[ReportBot] BLOCK: Header element exists:', !!header);
  if (header) {
    const headerButtons = header.querySelectorAll('[role="button"], button');
    console.log('[ReportBot] BLOCK: Buttons in header:', headerButtons.length);
  }

  // Try to find options button with verbose logging
  console.log('[ReportBot] BLOCK: Attempting to find options button (verbose)...');
  const optionsBtnImmediate = findOptionsButton(true);
  console.log('[ReportBot] BLOCK: Immediate findOptionsButton result:', !!optionsBtnImmediate);

  // Now wait with polling
  console.log('[ReportBot] BLOCK: Waiting for options button with timeout...');
  const optionsBtn = await waitForElement(() => findOptionsButton(false), TIMEOUTS.ELEMENT_WAIT, TIMEOUTS.RETRY_INTERVAL, 'optionsBtn-for-block');
  
  if (!optionsBtn) {
    console.log('[ReportBot] BLOCK: FAILED - Could not find options menu after waiting');
    console.log('[ReportBot] BLOCK: Page body text (first 500 chars):', document.body?.innerText?.substring(0, 500));
    console.log('[ReportBot] Waiting 5 seconds before continuing...');
    await sleep(5000);
    return { success: false, error: 'No options menu for block' };
  }

  console.log('[ReportBot] BLOCK: Options button found! Clicking...');
  const clickResult = simulateClick(optionsBtn);
  console.log('[ReportBot] BLOCK: simulateClick result:', clickResult);

  console.log('[ReportBot] BLOCK: Waiting for Block option in menu...');
  let menuState = await waitForBlockMenuAction(TIMEOUTS.MENU_OPEN);
  console.log('[ReportBot] BLOCK: Menu state after first wait:', JSON.stringify({ blockBtn: !!menuState.blockBtn, alreadyBlocked: menuState.alreadyBlocked }));
  
  if (!menuState.blockBtn && !menuState.alreadyBlocked) {
    console.log('[ReportBot] BLOCK: Block option not found, retrying menu click...');
    optionsBtn.focus();
    await sleep(100);
    const retryClickResult = simulateClick(optionsBtn);
    console.log('[ReportBot] BLOCK: Retry simulateClick result:', retryClickResult);
    menuState = await waitForBlockMenuAction(TIMEOUTS.MENU_OPEN);
    console.log('[ReportBot] BLOCK: Menu state after retry:', JSON.stringify({ blockBtn: !!menuState.blockBtn, alreadyBlocked: menuState.alreadyBlocked }));
  }

  if (menuState.alreadyBlocked) {
    console.log('[ReportBot] BLOCK: Account already blocked - skipping block confirm');
    await ensureDialogsClosed();
    return { success: true, alreadyBlocked: true };
  }

  if (!menuState.blockBtn) {
    console.log('[ReportBot] BLOCK: FAILED - Could not find Block option in menu');
    // Log what buttons ARE in the menu
    const activeDialog = getActiveDialogRoot();
    if (activeDialog) {
      const menuButtons = activeDialog.querySelectorAll('button, [role="button"], [role="menuitem"]');
      console.log('[ReportBot] BLOCK: Buttons found in active dialog:', menuButtons.length);
      for (const btn of menuButtons) {
        console.log('[ReportBot] BLOCK: Menu button text:', btn.textContent?.trim().substring(0, 50));
      }
    } else {
      console.log('[ReportBot] BLOCK: No active dialog found');
    }
    await ensureDialogsClosed();
    console.log('[ReportBot] Waiting 5 seconds before continuing...');
    await sleep(5000);
    return { success: false, error: 'No Block option in menu' };
  }

  console.log('[ReportBot] BLOCK: Clicking Block button in menu...');
  console.log('[ReportBot] BLOCK: Block button text:', menuState.blockBtn.textContent?.trim());
  
  // Use aggressive click - Instagram's React app may need pointer/mouse events
  await aggressiveClick(menuState.blockBtn);

  // Wait for confirmation dialog to appear
  console.log('[ReportBot] BLOCK: Waiting for confirmation dialog...');
  const confirmBtn = await waitForElement(findBlockConfirmButton, TIMEOUTS.ELEMENT_WAIT * 2, TIMEOUTS.RETRY_INTERVAL, 'blockConfirmBtn');
  if (!confirmBtn) {
    console.log('[ReportBot] BLOCK: FAILED - Could not find Block confirmation button');
    const allDialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    console.log('[ReportBot] BLOCK: Dialogs on page:', allDialogs.length);
    for (const d of allDialogs) {
      const btns = d.querySelectorAll('button, [role="button"]');
      const btnTexts = [];
      for (const b of btns) {
        if (isClickable(b)) {
          btnTexts.push(b.textContent?.trim().substring(0, 30) || '(no text)');
        }
      }
      console.log('[ReportBot] BLOCK: Dialog buttons:', btnTexts);
      console.log('[ReportBot] BLOCK: Dialog text:', d.textContent?.substring(0, 200));
    }
    await ensureDialogsClosed();
    console.log('[ReportBot] Waiting 5 seconds before continuing...');
    await sleep(5000);
    return { success: false, error: 'No Block confirmation button' };
  }

  console.log('[ReportBot] BLOCK: Found confirmation button with text:', confirmBtn.textContent?.trim());
  console.log('[ReportBot] BLOCK: Clicking Block confirmation button...');
  
  // Use aggressive click - Instagram's React app may need pointer/mouse events
  await aggressiveClick(confirmBtn);
  
  // Wait a moment for Instagram to process the block action
  // The block action takes 1-2 seconds to complete, during which the confirmation dialog is still visible
  console.log('[ReportBot] BLOCK: Waiting for Instagram to process block action...');
  await sleep(2000);
  
  // Wait for the success confirmation popup ("Blocked [username].")
  console.log('[ReportBot] BLOCK: Waiting for block success confirmation...');
  let successHeading = null;
  const successFound = await waitFor(() => {
    successHeading = findBlockSuccessHeading();
    return !!successHeading;
  }, TIMEOUTS.ELEMENT_WAIT * 2, TIMEOUTS.RETRY_INTERVAL);

  if (successFound && successHeading) {
    console.log('[ReportBot] BLOCK: Success confirmation found:', successHeading.textContent?.trim());
    console.log('[ReportBot] BLOCK: Block confirmed!');
    
    // Stay on the success screen for 4 seconds as requested
    console.log('[ReportBot] BLOCK: Waiting 4 seconds on success screen...');
    await sleep(4000);
  } else {
    console.log('[ReportBot] BLOCK: No explicit success confirmation found');
    // Log what's visible for debugging
    const visibleDialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    console.log('[ReportBot] BLOCK: Visible dialogs:', visibleDialogs.length);
    for (const d of visibleDialogs) {
      const headings = d.querySelectorAll('h1, [role="heading"]');
      for (const h of headings) {
        console.log('[ReportBot] BLOCK: Heading text:', h.textContent?.trim());
      }
    }
    
    // DO NOT call closeDialogs() here - it clicks Cancel and undoes the block!
    // Just wait 4 seconds and continue
    console.log('[ReportBot] BLOCK: Waiting 4 seconds before continuing...');
    await sleep(4000);
  }
  
  console.log('[ReportBot] ========================================');
  console.log('[ReportBot] BLOCK SEQUENCE: Completed successfully!');
  console.log('[ReportBot] ========================================');
  
  // Wait 5 seconds so user can read the console before page changes
  console.log('[ReportBot] Waiting 5 seconds before continuing...');
  await sleep(5000);
  
  return { success: true };
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
      const pageText = document.body?.innerText?.toLowerCase() || '';
      
      // Check for any "page ready" indicators:
      // 1. Options button visible (normal profile)
      // 2. Generic 404 page
      // 3. Unavailable profile (already blocked/removed)
      const isNotFound = NOT_FOUND_INDICATORS.some(ind => pageText.includes(ind.toLowerCase()));
      const isUnavailable = PROFILE_UNAVAILABLE_INDICATORS.some(ind => pageText.includes(ind.toLowerCase()));
      
      return optionsBtn || isNotFound || isUnavailable;
    }, TIMEOUTS.PAGE_LOAD, 300);

    if (!profileLoaded) {
      console.log('[ReportBot] Profile page did not load in time');
      return { success: false, error: 'Page load timeout' };
    }

    // ========================================
    // Phase 2: Pre-flight checks
    // ========================================
    
    // FIRST: Check if profile is unavailable (already blocked by us, or removed)
    // This is a fast skip - no report or block needed, don't count toward pause
    if (isProfileUnavailable()) {
      console.log('[ReportBot] Profile unavailable (already blocked/removed) - skipping fast');
      return { 
        success: false, 
        unavailable: true, 
        message: 'Profile unavailable (already blocked or removed)' 
      };
    }
    
    if (!checkProfileExists()) {
      console.log('[ReportBot] Profile not found (404)');
      return { success: false, notFound: true };
    }

    if (isRateLimited()) {
      console.log('[ReportBot] Rate limited');
      return { success: false, rateLimited: true, retryAfterMs: 60000 };
    }

    if (isAlreadyReported()) {
      console.log('[ReportBot] Already reported - proceeding to block flow');
      const blockResult = await performBlockSequence();
      if (!blockResult.success) {
        console.log('[ReportBot] Block sequence failed:', blockResult.error || 'Unknown');
        return { success: false, error: blockResult.error || 'Block sequence failed' };
      }
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

    if (!safeDialogClick(reportBtn)) {
      console.log('[ReportBot] Failed to click Report button safely');
      await ensureDialogsClosed();
      return { success: false, error: 'Report button click blocked' };
    }

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

    if (!safeDialogClick(reportAccountBtn)) {
      console.log('[ReportBot] Failed to click Report Account button safely');
      await ensureDialogsClosed();
      return { success: false, error: 'Report Account button click blocked' };
    }

    // Wait for next screen (posting content options)
    const postingContentBtn = await waitForDialogButton(
      ["posting content that shouldn't be on Instagram", "posting content", "shouldn't be on Instagram"],
      TIMEOUTS.ELEMENT_WAIT
    );

    // If specific text not found, try first clickable button (like old working code)
    let nextBtn = postingContentBtn;
    if (!nextBtn) {
      await sleep(500); // Brief wait for DOM to settle
      // CRITICAL: ONLY search within the active dialog - never profile buttons
      const dialogRoot = getActiveDialogRoot();
      if (!dialogRoot) {
        console.log('[ReportBot] SAFETY: No active dialog found - refusing to search page');
        await ensureDialogsClosed();
        return { success: false, error: 'No dialog found for posting content' };
      }
      const searchRoot = dialogRoot;
      const allButtons = searchRoot.querySelectorAll('button, [role="button"], [role="menuitem"]');
      for (const btn of allButtons) {
        const text = btn.textContent?.toLowerCase() || '';
        // Skip navigation/action buttons
        if (text.includes('close') || text.includes('cancel') || text.includes('back')) continue;
        if (text.includes('block') || text.includes('restrict')) continue;
        // CRITICAL: Never click follow/message actions
        if (text.includes('follow') || text.includes('following') || text.includes('requested')) continue;
        if (text.includes('message') || text.includes('call')) continue;
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

    if (!safeDialogClick(nextBtn)) {
      console.log('[ReportBot] Failed to click posting content option safely');
      await ensureDialogsClosed();
      return { success: false, error: 'Posting content button click blocked' };
    }

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

    if (!safeDialogClick(falseInfoBtn)) {
      console.log('[ReportBot] Failed to click False Information safely');
      await ensureDialogsClosed();
      return { success: false, error: 'False Information button click blocked' };
    }

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
    const dialogRoot = getActiveDialogRoot() || document;
    const step6Buttons = dialogRoot.querySelectorAll('button, [role="button"], [role="menuitem"]');
    
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
      // CRITICAL: Never click follow/message actions
      if (text.includes('follow') || text.includes('requested') || text.includes('following')) continue;
      if (text.includes('message') || text.includes('call')) continue;
      // Skip the Report button itself
      if (text === 'report') continue;
      // Skip learn more links
      if (text.includes('learn more')) continue;

      if (isClickable(btn)) {
        console.log('[ReportBot] Clicking sub-option:', text.substring(0, 50));
        if (safeDialogClick(btn)) {
          clickedSubOption = true;
          await sleep(500);
          break;
        }
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
      const dialogRoot = getActiveDialogRoot();
      if (!dialogRoot) {
        console.log('[ReportBot] SAFETY: No active dialog found - refusing to search page for submit');
        await ensureDialogsClosed();
        return { success: false, error: 'No dialog found for submit' };
      }
      const allBtns = dialogRoot.querySelectorAll('button, [role="button"], [role="menuitem"]');
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
        // CRITICAL: Never click follow/message actions
        if (text.includes('follow') || text.includes('requested') || text.includes('following')) continue;
        if (text.includes('message') || text.includes('call')) continue;
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

    // Check if we're at the "report complete" screen (no submit button found)
    // This can happen when Instagram shows "Block [username]" and "Close" buttons
    // In this case, we just click Close and schedule a block after page reload
    let reportAlreadyComplete = false;
    
    if (!submitBtn) {
      console.log('[ReportBot] Standard submit not found, checking for report-complete screen...');
      const dialogRoot2 = getActiveDialogRoot();
      if (dialogRoot2) {
        const allBtns2 = dialogRoot2.querySelectorAll('button, [role="button"], [role="menuitem"]');
        let closeBtn = null;
        
        for (const btn of allBtns2) {
          const text = btn.textContent?.trim().toLowerCase() || '';
          // Match "close", "close " (with trailing space/chars), but not "close account" etc.
          if ((text === 'close' || text === 'done' || text === 'ok') && isClickable(btn)) {
            closeBtn = btn;
            break;
          }
        }
        
        // Log what buttons are available for debugging
        if (!closeBtn) {
          const btnTexts = [];
          for (const btn of allBtns2) {
            if (isClickable(btn)) {
              btnTexts.push(btn.textContent?.trim().substring(0, 30) || '(empty)');
            }
          }
          console.log('[ReportBot] No close button found. Available buttons:', btnTexts);
        }
        
        if (closeBtn) {
          console.log('[ReportBot] Found Close/Done button - report is likely complete');
          console.log('[ReportBot] Button text:', closeBtn.textContent?.trim());
          console.log('[ReportBot] Clicking and scheduling block after reload...');
          closeBtn.click();
          await sleep(500);
          reportAlreadyComplete = true;
        }
      }
    }

    if (!submitBtn && !reportAlreadyComplete) {
      console.log('[ReportBot] Could not find Submit/Done button');
      await ensureDialogsClosed();
      return { success: false, error: 'No Submit/Done button' };
    }

    // If we have a normal submit button, click it
    if (submitBtn && !reportAlreadyComplete) {
      if (!safeDialogClick(submitBtn)) {
        console.log('[ReportBot] Failed to click Submit button safely');
        await ensureDialogsClosed();
        return { success: false, error: 'Submit button click blocked' };
      }

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
      console.log('[ReportBot] Step 9: Closing report dialogs...');
      await closeDialogs();
      await sleep(500);
    }

    // ========================================
    // Post-report: Store pending block and reload page
    // ========================================
    console.log('[ReportBot] Step 10: Scheduling block after page reload...');
    
    // Store the username for blocking after reload
    localStorage.setItem('reportbot_pending_block', username);
    console.log('[ReportBot] Stored pending block for:', username);
    
    // IMPORTANT: We need to return success BEFORE reloading, otherwise the
    // message channel will be destroyed and the background script will time out.
    // We use setTimeout to delay the reload so the response can be sent first.
    console.log('[ReportBot] Report complete! Scheduling page reload for block...');
    
    // Schedule reload after a short delay to allow response to be sent
    setTimeout(() => {
      console.log('[ReportBot] Reloading page now...');
      window.location.reload();
    }, 100);
    
    // Return success immediately - block will happen after reload
    return { success: true, pendingBlock: true };

  } catch (e) {
    console.error('[ReportBot] Error during report:', e);
    await ensureDialogsClosed();
    return { success: false, error: e.message };
  } finally {
    reportInProgress = false;
  }
}

// ============================================================================
// PENDING BLOCK CHECK ON PAGE LOAD
// ============================================================================

async function checkAndExecutePendingBlock() {
  const pendingUsername = localStorage.getItem('reportbot_pending_block');
  if (!pendingUsername) {
    return;
  }
  
  // Prevent concurrent operations
  if (reportInProgress) {
    console.log('[ReportBot] Report already in progress, skipping pending block');
    return;
  }
  
  console.log('[ReportBot] ========================================');
  console.log('[ReportBot] PENDING BLOCK DETECTED for:', pendingUsername);
  console.log('[ReportBot] ========================================');
  
  // Clear the flag immediately to prevent re-execution
  localStorage.removeItem('reportbot_pending_block');
  
  // Set the flag to prevent concurrent operations
  reportInProgress = true;
  
  try {
    // Wait for page to fully load - verify options button is visible OR unavailable
    console.log('[ReportBot] Waiting for page to be ready...');
    
    const pageReady = await waitFor(() => {
      const optionsBtn = findOptionsButton();
      // Also check for unavailable state (already blocked)
      const isUnavailable = isProfileUnavailable();
      return !!optionsBtn || isUnavailable;
    }, TIMEOUTS.PAGE_LOAD, 300);
    
    if (!pageReady) {
      console.log('[ReportBot] Page did not become ready in time');
      return;
    }
    
    // Check if profile became unavailable (shouldn't happen, but handle gracefully)
    if (isProfileUnavailable()) {
      console.log('[ReportBot] Profile unavailable after reload - block already complete or profile removed');
      try {
        chrome.runtime.sendMessage({
          action: 'blockComplete',
          username: pendingUsername,
          success: true,
          alreadyUnavailable: true
        });
      } catch (e) {
        console.log('[ReportBot] Could not notify extension:', e.message);
      }
      return;
    }
    
    console.log('[ReportBot] Page is ready');
    
    // Verify we're on the right profile page
    const currentUrl = window.location.href;
    console.log('[ReportBot] Current URL:', currentUrl);
    
    // Check if URL contains username (with proper boundary check)
    const urlLower = currentUrl.toLowerCase();
    const usernameLower = pendingUsername.toLowerCase();
    if (!urlLower.includes('/' + usernameLower) && !urlLower.includes('/' + usernameLower + '/')) {
      console.log('[ReportBot] WARNING: Current URL does not match expected username');
      console.log('[ReportBot] Expected:', pendingUsername);
      console.log('[ReportBot] Proceeding anyway...');
    }
    
    // Execute the block sequence
    console.log('[ReportBot] Executing block sequence...');
    const blockResult = await performBlockSequence();
    
    if (blockResult.success) {
      console.log('[ReportBot] ========================================');
      console.log('[ReportBot] BLOCK COMPLETED SUCCESSFULLY!');
      console.log('[ReportBot] ========================================');
    } else {
      console.log('[ReportBot] Block sequence failed:', blockResult.error || 'Unknown error');
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
      console.log('[ReportBot] Could not notify extension:', e.message);
    }
  } finally {
    reportInProgress = false;
  }
}

// Check for pending blocks when the script loads
checkAndExecutePendingBlock();

console.log('[ReportBot] Content script loaded (hardened version)');
