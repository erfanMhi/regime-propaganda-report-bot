// Content Script - Runs on Instagram pages
// Handles the actual DOM manipulation and clicking

const NOT_FOUND_INDICATORS = [
  "profile isn't available",
  "sorry, this page",
  "page isn't available",
  "this page isn't available",
  "may have been removed",
  "link may be broken"
];

const CLOSE_DIALOG_TEXTS = ["Close", "Done", "OK", "Dismiss", "×", "Not now", "Cancel"];

let reportInProgress = false;

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        console.error('Report error:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      });
    return true; // Keep channel open for async response
  }
});

async function doReport(username) {
  console.log('[ReportBot] Starting report for:', username);

  reportInProgress = true;
  try {
    // Wait for Instagram SPA to actually load the profile content.
    console.log('[ReportBot] Waiting for profile to load...');
    const profileLoaded = await waitFor(() => {
      // Check for Options button (3-dots menu) OR profile not found indicators
      const optionsBtn = document.querySelector('svg[aria-label="Options"]') || 
                         document.querySelector('svg[aria-label="More options"]') ||
                         document.querySelector('[aria-label="Options"]');
      const header = document.querySelector('header');
      const notFoundText = document.body?.innerText?.toLowerCase() || '';
      const isNotFound = NOT_FOUND_INDICATORS.some(ind => notFoundText.includes(ind.toLowerCase()));
      return optionsBtn || (header && header.querySelector('[role="button"]')) || isNotFound;
    }, 15000, 300);

    if (!profileLoaded) {
      console.log('[ReportBot] Profile page did not load in time');
      return { success: false, error: 'Page load timeout' };
    }

    // Check if profile exists.
    if (!checkProfileExists()) {
      console.log('[ReportBot] Profile not found');
      return { success: false, notFound: true };
    }
  
    // Check for rate limiting.
    if (isRateLimited()) {
      console.log('[ReportBot] Rate limited');
      return { success: false, rateLimited: true, retryAfterMs: 60000 };
    }
  
    // Step 1: Click options menu (3 dots)
    console.log('[ReportBot] Step 1: Click options menu');
    if (!await retryFor(() => clickOptionsMenu(), 10000)) {
      console.log('[ReportBot] Could not find options menu');
      return { success: false, error: 'No options menu' };
    }
    await sleep(400);
    
    // Step 2: Click Report button
    console.log('[ReportBot] Step 2: Click Report');
    if (!await retryFor(() => clickReport(), 8000)) {
      console.log('[ReportBot] Could not find Report button');
      await closeDialogs();
      return { success: false, error: 'No Report button' };
    }
    await sleep(600);
    
    // Step 3: Click Report Account
    console.log('[ReportBot] Step 3: Click Report Account');
    if (!await retryFor(() => clickReportAccount(), 8000)) {
      console.log('[ReportBot] Could not find Report Account option');
      await closeDialogs();
      return { success: false, error: 'No Report Account' };
    }
    await sleep(600);
    
    // Step 4: Click first option (posting content)
    console.log('[ReportBot] Step 4: Click posting content option');
    if (!await retryFor(() => clickPostingContent(), 8000)) {
      console.log('[ReportBot] Could not find posting content option');
      await closeDialogs();
      return { success: false, error: 'No posting content' };
    }
    await sleep(600);
    
    // Step 5: Click False Information
    console.log('[ReportBot] Step 5: Click False Information');
    if (!await retryFor(() => clickFalseInformation(), 8000)) {
      console.log('[ReportBot] Could not find False Information option');
      await closeDialogs();
      return { success: false, error: 'No False Information option' };
    }
    await sleep(600);
    
    // Step 6: Click any sub-option if present (e.g., "Health", "Politics", etc.)
    console.log('[ReportBot] Step 6: Click sub-option if present');
    await clickFirstListOption();
    await sleep(600);
    
    // Step 7: Click Submit (if present)
    console.log('[ReportBot] Step 7: Click Submit');
    await clickSubmit();
    await sleep(800);
    
    // Close any remaining dialogs
    await closeDialogs();
    
    console.log('[ReportBot] Report complete for:', username);
    return { success: true };
    
  } catch (e) {
    console.error('[ReportBot] Error during report:', e);
    await closeDialogs();
    return { success: false, error: e.message };
  } finally {
    reportInProgress = false;
  }
}

function checkProfileExists() {
  const pageText = document.body.innerText.toLowerCase();
  for (const indicator of NOT_FOUND_INDICATORS) {
    if (pageText.includes(indicator)) {
      return false;
    }
  }
  return true;
}

function isRateLimited() {
  const pageText = document.body.innerText.toLowerCase();
  return pageText.includes('try again later') || 
         pageText.includes('restricted your account');
}

async function clickOptionsMenu() {
  // Try multiple selectors for the 3-dots menu
  const selectors = [
    'svg[aria-label="Options"]',
    'svg[aria-label="More options"]',
    '[aria-label="Options"]',
    '[aria-label="More options"]'
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const button = el.closest('button') || el.closest('[role="button"]');
      if (button) {
        button.click();
        return true;
      }
    }
  }
  
  // Fallback: find by header button
  const headerButtons = document.querySelectorAll('header [role="button"]');
  if (headerButtons.length > 0) {
    headerButtons[headerButtons.length - 1].click();
    return true;
  }
  
  return false;
}

async function clickReport() {
  return await clickButtonByText(['Report']);
}

async function clickReportAccount() {
  // Try to click "Report Account" option
  if (await clickButtonByText(['Report Account', 'Report account'])) {
    return true;
  }
  
  // Fallback: click second button in list
  const listButtons = document.querySelectorAll('[role="list"] button, [role="dialog"] button');
  if (listButtons.length >= 2) {
    listButtons[1].click();
    return true;
  }
  
  return false;
}

async function clickPostingContent() {
  // Usually the first option in the list
  const listButtons = document.querySelectorAll('[role="list"] button');
  if (listButtons.length > 0) {
    listButtons[0].click();
    return true;
  }
  
  // Try by text
  return await clickButtonByText([
    "posting content that shouldn't be on Instagram",
    "posting content",
    "shouldn't be on Instagram"
  ]);
}

async function clickFalseInformation() {
  return await clickButtonByText([
    'False information',
    'false information',
    'Misinformation'
  ]);
}

async function clickFirstListOption() {
  // Click first available option in a list (for sub-categories)
  const listButtons = document.querySelectorAll('[role="list"] button');
  if (listButtons.length > 0) {
    listButtons[0].click();
    return true;
  }
  return false;
}

async function clickSubmit() {
  return await clickButtonByText([
    'Submit',
    'Submit report',
    'Done'
  ]);
}

async function closeDialogs() {
  await sleep(500);
  
  for (const text of CLOSE_DIALOG_TEXTS) {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim().toLowerCase() || '';
      if (btnText === text.toLowerCase() && !btnText.includes('block')) {
        btn.click();
        await sleep(300);
        return true;
      }
    }
  }
  
  // Try clicking outside dialog (press Escape)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  
  return false;
}

async function clickButtonByText(texts) {
  const allClickable = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
  
  for (const text of texts) {
    for (const el of allClickable) {
      const elText = el.textContent?.toLowerCase() || '';
      if (elText.includes(text.toLowerCase())) {
        el.scrollIntoView({ block: 'center' });
        await sleep(100);
        el.click();
        return true;
      }
    }
  }
  
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await fn();
      if (ok) return true;
    } catch (e) {
      // ignore and retry
    }
    await sleep(250);
  }
  return false;
}

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

console.log('[ReportBot] Content script loaded');
