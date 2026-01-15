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

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DO_REPORT') {
    doReport(message.username).then(result => {
      sendResponse(result);
    }).catch(err => {
      console.error('Report error:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
  }
});

async function doReport(username) {
  console.log('[ReportBot] Starting report for:', username);
  
  // Wait for page to stabilize
  await sleep(1500);
  
  // Check if profile exists
  if (!checkProfileExists()) {
    console.log('[ReportBot] Profile not found');
    return { success: false, notFound: true };
  }
  
  // Check for rate limiting
  if (isRateLimited()) {
    console.log('[ReportBot] Rate limited, waiting...');
    await sleep(60000);
    return { success: false, error: 'Rate limited' };
  }
  
  try {
    // Step 1: Click options menu (3 dots)
    console.log('[ReportBot] Step 1: Click options menu');
    if (!await clickOptionsMenu()) {
      console.log('[ReportBot] Could not find options menu');
      return { success: false, error: 'No options menu' };
    }
    await sleep(1000);
    
    // Step 2: Click Report button
    console.log('[ReportBot] Step 2: Click Report');
    if (!await clickReport()) {
      console.log('[ReportBot] Could not find Report button');
      await closeDialogs();
      return { success: false, error: 'No Report button' };
    }
    await sleep(1000);
    
    // Step 3: Click Report Account
    console.log('[ReportBot] Step 3: Click Report Account');
    if (!await clickReportAccount()) {
      console.log('[ReportBot] Could not find Report Account option');
      await closeDialogs();
      return { success: false, error: 'No Report Account' };
    }
    await sleep(1000);
    
    // Step 4: Click first option (posting content)
    console.log('[ReportBot] Step 4: Click posting content option');
    if (!await clickPostingContent()) {
      console.log('[ReportBot] Could not find posting content option');
      await closeDialogs();
      return { success: false, error: 'No posting content' };
    }
    await sleep(1000);
    
    // Step 5: Click Violence option
    console.log('[ReportBot] Step 5: Click Violence option');
    if (!await clickViolenceOption()) {
      console.log('[ReportBot] Could not find Violence option');
      await closeDialogs();
      return { success: false, error: 'No Violence option' };
    }
    await sleep(1000);
    
    // Step 6: Click Calling for Violence
    console.log('[ReportBot] Step 6: Click Calling for Violence');
    if (!await clickCallingForViolence()) {
      console.log('[ReportBot] Could not find Calling for Violence option');
      await closeDialogs();
      return { success: false, error: 'No Calling for Violence' };
    }
    await sleep(1000);
    
    // Step 7: Click Submit (if present)
    console.log('[ReportBot] Step 7: Click Submit');
    await clickSubmit();
    await sleep(1500);
    
    // Close any remaining dialogs
    await closeDialogs();
    
    console.log('[ReportBot] Report complete for:', username);
    return { success: true };
    
  } catch (e) {
    console.error('[ReportBot] Error during report:', e);
    await closeDialogs();
    return { success: false, error: e.message };
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

async function clickViolenceOption() {
  return await clickButtonByText([
    'Violence, hate or exploitation',
    'Violence',
    'hate or exploitation'
  ]);
}

async function clickCallingForViolence() {
  return await clickButtonByText([
    'Calling for violence',
    'violence'
  ]);
}

async function clickSubmit() {
  return await clickButtonByText([
    'Submit',
    'Submit report'
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
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
  
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

console.log('[ReportBot] Content script loaded');
