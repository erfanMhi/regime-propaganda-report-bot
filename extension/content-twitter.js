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

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DO_REPORT') {
    doReport(message.username).then(result => {
      sendResponse(result);
    }).catch(err => {
      console.error('[ReportBot X] Report error:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
  }
});

async function doReport(username) {
  console.log('[ReportBot X] Starting report for:', username);
  
  // Wait for page to stabilize
  await sleep(2000);
  
  // Check if profile exists
  if (!checkProfileExists()) {
    console.log('[ReportBot X] Profile not found');
    return { success: false, notFound: true };
  }
  
  // Check for rate limiting
  if (isRateLimited()) {
    console.log('[ReportBot X] Rate limited, waiting...');
    await sleep(60000);
    return { success: false, error: 'Rate limited' };
  }
  
  try {
    // Step 1: Click the 3 dots menu (userActions button)
    console.log('[ReportBot X] Step 1: Click options menu (3 dots)');
    if (!await clickOptionsMenu()) {
      console.log('[ReportBot X] Could not find options menu');
      return { success: false, error: 'No options menu' };
    }
    await sleep(1000);
    
    // Step 2: Click Report @username button
    console.log('[ReportBot X] Step 2: Click Report button');
    if (!await clickReportButton(username)) {
      console.log('[ReportBot X] Could not find Report button');
      await closeDialogs();
      return { success: false, error: 'No Report button' };
    }
    await sleep(1000);
    
    // Step 3: Click "Hate" option
    console.log('[ReportBot X] Step 3: Click Hate option');
    if (!await clickHateOption()) {
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
    if (!await clickDehumanizationOption()) {
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

async function clickOptionsMenu() {
  // Look for the userActions button (3 dots menu)
  const userActionsButton = document.querySelector('[data-testid="userActions"]');
  if (userActionsButton) {
    userActionsButton.click();
    return true;
  }
  
  // Fallback: look for button with "More" aria-label
  const moreButton = document.querySelector('[aria-label="More"]');
  if (moreButton) {
    moreButton.click();
    return true;
  }
  
  return false;
}

async function clickReportButton(username) {
  // Prefer the menu dialog X shows after clicking userActions
  const dialog = document.querySelector('[data-testid="sheetDialog"]') || document;
  const menuItems = Array.from(dialog.querySelectorAll('[role="menuitem"]'));

  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();

  // Strong match first: "Report @username"
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (normalizedUsername && t.includes(`report @${normalizedUsername}`)) {
      item.scrollIntoView({ block: 'center' });
      await sleep(100);
      item.click();
      return true;
    }
  }

  // Next best: any "Report @" item (assume current profile)
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (t.startsWith('report @') || t.includes('report @')) {
      item.scrollIntoView({ block: 'center' });
      await sleep(100);
      item.click();
      return true;
    }
  }

  // Fallback: any "Report" menu item inside the dialog
  for (const item of menuItems) {
    const t = (item.textContent || '').trim().toLowerCase();
    if (t === 'report' || t.startsWith('report')) {
      item.scrollIntoView({ block: 'center' });
      await sleep(100);
      item.click();
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
          radio.click();
          await sleep(100);
        }
        label.click();
        await sleep(300);
        return true;
      }
    }
  }
  
  // Fallback: look for any clickable element with the text
  const allClickable = document.querySelectorAll('div, span, button');
  for (const text of texts) {
    for (const el of allClickable) {
      const elText = el.textContent?.trim().toLowerCase() || '';
      if (elText === text.toLowerCase() || elText.startsWith(text.toLowerCase())) {
        el.click();
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
    choiceButton.click();
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
        btn.click();
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
    submitButton.click();
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
  await sleep(500);
  
  // Try pressing Escape first
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  await sleep(300);
  
  // Try clicking close buttons
  for (const text of CLOSE_DIALOG_TEXTS) {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim().toLowerCase() || '';
      const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
      if (btnText === text.toLowerCase() || ariaLabel === text.toLowerCase()) {
        btn.click();
        await sleep(300);
        return true;
      }
    }
  }
  
  // Try clicking the close X button
  const closeButton = document.querySelector('[aria-label="Close"]');
  if (closeButton) {
    closeButton.click();
    return true;
  }
  
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('[ReportBot X] Content script loaded');
