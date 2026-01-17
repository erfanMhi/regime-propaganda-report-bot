// Content Script for X - Runs on x.com and twitter.com
// Handles the actual DOM manipulation and clicking for X reporting

const NOT_FOUND_INDICATORS = [
  "this account doesn't exist",
  "account suspended",
  "this account has been suspended",
  "account doesn't exist",
  "hmm...this page doesn't exist"
];

const CLOSE_DIALOG_TEXTS = ["Close", "Done", "OK", "Dismiss", "×", "Cancel", "Not now"];

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
        console.error('[ReportBot X] Report error:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      });
    return true; // Keep channel open for async response
  }
});

async function doReport(username) {
  console.log('[ReportBot X] Starting report for:', username);

  reportInProgress = true;
  try {
    // Wait for Twitter SPA to actually load the profile content.
    // Look for profile-specific elements that indicate the page is ready.
    console.log('[ReportBot X] Waiting for profile to load...');
    const profileLoaded = await waitFor(() => {
      // Check for userActions button (the 3-dots menu) OR profile not found indicators
      const userActions = document.querySelector('[data-testid="userActions"]');
      const profileHeader = document.querySelector('[data-testid="UserName"]');
      const notFoundText = document.body?.innerText?.toLowerCase() || '';
      const isNotFound = NOT_FOUND_INDICATORS.some(ind => notFoundText.includes(ind.toLowerCase()));
      return userActions || profileHeader || isNotFound;
    }, 15000, 300);

    if (!profileLoaded) {
      console.log('[ReportBot X] Profile page did not load in time');
      return { success: false, error: 'Page load timeout' };
    }

    // Check if profile exists.
    if (!checkProfileExists()) {
      console.log('[ReportBot X] Profile not found');
      return { success: false, notFound: true };
    }

    // Check for rate limiting.
    if (isRateLimited()) {
      console.log('[ReportBot X] Rate limited');
      return { success: false, rateLimited: true, retryAfterMs: 60000 };
    }

    // Check if already reported (Twitter shows "You reported this account")
    if (isAlreadyReported()) {
      console.log('[ReportBot X] Already reported this account');
      return { success: true }; // Count as success since goal is achieved
    }

    // Step 1: Click the 3 dots menu (userActions button)
    console.log('[ReportBot X] Step 1: Click options menu (3 dots)');
    if (!await retryFor(() => clickOptionsMenu(), 10000)) {
      console.log('[ReportBot X] Could not find options menu');
      return { success: false, error: 'No options menu' };
    }
    await sleep(400);
    
    // Step 2: Click Report @username button
    console.log('[ReportBot X] Step 2: Click Report button');
    if (!await retryFor(() => clickReportButton(username), 8000)) {
      console.log('[ReportBot X] Could not find Report button');
      await closeDialogs();
      return { success: false, error: 'No Report button' };
    }
    await sleep(600);
    
    // Step 3: Click "Hate" option
    console.log('[ReportBot X] Step 3: Click Hate option');
    if (!await retryFor(() => clickHateOption(), 8000)) {
      console.log('[ReportBot X] Could not find Hate option');
      await closeDialogs();
      return { success: false, error: 'No Hate option' };
    }
    await sleep(500);
    
    // Step 3b: Click Next to proceed to sub-options
    console.log('[ReportBot X] Step 3b: Click Next after Hate');
    await clickNextButton();
    await sleep(1000);
    
    // Step 4: Click "Dehumanization" option
    console.log('[ReportBot X] Step 4: Click Dehumanization option');
    if (!await retryFor(() => clickDehumanizationOption(), 8000)) {
      console.log('[ReportBot X] Could not find Dehumanization option');
      await closeDialogs();
      return { success: false, error: 'No Dehumanization option' };
    }
    await sleep(1000);
    
    // Step 5: Click Submit button (ChoiceSelectionNextButton)
    console.log('[ReportBot X] Step 5: Click Submit');
    if (!await clickSubmit()) {
      console.log('[ReportBot X] Could not find Submit button, trying alternatives');
    }
    await sleep(1500);
    
    // Step 6: Click any additional confirmation buttons
    console.log('[ReportBot X] Step 6: Click any confirmation');
    await clickNextButton();
    await sleep(1000);
    
    // Close any remaining dialogs
    await closeDialogs();
    
    console.log('[ReportBot X] Report complete for:', username);
    return { success: true };
    
  } catch (e) {
    console.error('[ReportBot X] Error during report:', e);
    await closeDialogs();
    return { success: false, error: e.message };
  } finally {
    reportInProgress = false;
  }
}

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
  return pageText.includes('try again later') || 
         pageText.includes('rate limit') ||
         pageText.includes('too many requests');
}

function isAlreadyReported() {
  const pageText = document.body.innerText.toLowerCase();
  return pageText.includes('you reported this account') ||
         pageText.includes("you've already reported") ||
         pageText.includes('already submitted a report');
}

async function clickOptionsMenu() {
  // Look for the userActions button (3 dots menu)
  const userActionsButton = document.querySelector('[data-testid="userActions"]');
  if (userActionsButton) {
    // Use robust click with event dispatch
    simulateClick(userActionsButton);
    // Wait for menu to actually appear
    const menuOpened = await waitFor(() => {
      // Check if menu items appeared (dropdown/sheet)
      const menuItems = document.querySelectorAll('[role="menuitem"]');
      return menuItems.length > 0;
    }, 3000, 100);
    if (menuOpened) return true;
    // Menu didn't open - try again with different click
    userActionsButton.focus();
    userActionsButton.click();
    await sleep(500);
    return document.querySelectorAll('[role="menuitem"]').length > 0;
  }
  
  // Fallback: look for button with "More" aria-label
  const moreButton = document.querySelector('[aria-label="More"]');
  if (moreButton) {
    simulateClick(moreButton);
    await sleep(500);
    return document.querySelectorAll('[role="menuitem"]').length > 0;
  }
  
  return false;
}

function simulateClick(el) {
  if (!el) return;
  // Dispatch mouse events for better compatibility with React/Twitter
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  
  ['mousedown', 'mouseup', 'click'].forEach(type => {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
    }));
  });
}

async function clickReportButton(username) {
  // Look for menu items in any visible menu/dropdown
  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
  
  if (menuItems.length === 0) {
    // No menu items visible yet
    return false;
  }

  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();

  // Strong match first: "Report @username"
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (normalizedUsername && t.includes(`report @${normalizedUsername}`)) {
      item.scrollIntoView({ block: 'center' });
      await sleep(100);
      simulateClick(item);
      return true;
    }
  }

  // Next best: any "Report @" item (assume current profile)
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (t.startsWith('report @') || t.includes('report @')) {
      item.scrollIntoView({ block: 'center' });
      await sleep(100);
      simulateClick(item);
      return true;
    }
  }

  // Fallback: any "Report" menu item
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (t === 'report' || t.startsWith('report')) {
      item.scrollIntoView({ block: 'center' });
      await sleep(100);
      simulateClick(item);
      return true;
    }
  }

  return false;
}

async function clickHateOption() {
  // Look for "Hate" label in the report dialog
  return await clickRadioOptionByText(['Hate']);
}

async function clickDehumanizationOption() {
  // Look for "Dehumanization" label
  return await clickRadioOptionByText(['Dehumanization']);
}

async function clickRadioOptionByText(texts) {
  // Twitter uses radio inputs inside labels
  const labels = document.querySelectorAll('label');
  
  for (const text of texts) {
    for (const label of labels) {
      const labelText = label.textContent?.toLowerCase() || '';
      if (labelText.includes(text.toLowerCase())) {
        // Click the label or its radio input
        const radio = label.querySelector('input[type="radio"]');
        if (radio) {
          simulateClick(radio);
          await sleep(100);
        }
        simulateClick(label);
        await sleep(300);
        return true;
      }
    }
  }
  
  // Fallback: look for any clickable element with the text
  const allClickable = document.querySelectorAll('div[role="option"], div[role="radio"], span, button');
  for (const text of texts) {
    for (const el of allClickable) {
      const elText = el.textContent?.trim().toLowerCase() || '';
      if (elText === text.toLowerCase() || elText.startsWith(text.toLowerCase())) {
        simulateClick(el);
        await sleep(300);
        return true;
      }
    }
  }
  
  return false;
}

async function clickNextButton() {
  // First try the specific data-testid for Twitter's choice selection button
  const choiceButton = document.querySelector('[data-testid="ChoiceSelectionNextButton"]');
  if (choiceButton && isClickable(choiceButton)) {
    choiceButton.scrollIntoView({ block: 'center' });
    await sleep(100);
    simulateClick(choiceButton);
    return true;
  }
  
  // Look for Next, Submit, or Continue button by text
  const buttonTexts = ['Next', 'Submit', 'Continue', 'Done'];
  const buttons = document.querySelectorAll('button, [role="button"]');
  
  for (const btn of buttons) {
    if (!isClickable(btn)) continue;
    const btnText = btn.textContent?.trim() || '';
    for (const text of buttonTexts) {
      if (btnText.toLowerCase() === text.toLowerCase()) {
        btn.scrollIntoView({ block: 'center' });
        await sleep(100);
        simulateClick(btn);
        return true;
      }
    }
  }
  return false;
}

async function clickSubmit() {
  // First try the specific Submit button with data-testid
  const submitButton = document.querySelector('[data-testid="ChoiceSelectionNextButton"]');
  if (submitButton && isClickable(submitButton)) {
    submitButton.scrollIntoView({ block: 'center' });
    await sleep(100);
    simulateClick(submitButton);
    return true;
  }
  
  // Fallback to generic next button
  return await clickNextButton();
}

function isClickable(el) {
  if (!el) return false;
  if (el.disabled === true) return false;
  const ariaDisabled = el.getAttribute && el.getAttribute('aria-disabled');
  return ariaDisabled !== 'true';
}

async function closeDialogs() {
  await sleep(300);
  
  // Try pressing Escape first
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  await sleep(200);
  
  // Try clicking close buttons
  for (const text of CLOSE_DIALOG_TEXTS) {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim().toLowerCase() || '';
      const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
      if ((btnText === text.toLowerCase() || ariaLabel === text.toLowerCase()) && !btnText.includes('block')) {
        simulateClick(btn);
        await sleep(200);
        return true;
      }
    }
  }
  
  // Try clicking the close X button
  const closeButton = document.querySelector('[aria-label="Close"]');
  if (closeButton) {
    simulateClick(closeButton);
    return true;
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

console.log('[ReportBot X] Content script loaded');
