// Background Service Worker - Orchestrates the bot for both Instagram and Twitter

// State
let isRunning = { instagram: false, twitter: false };
let currentTabId = { instagram: null, twitter: null };

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_BOT') {
    startBot(message.platform, message.tabId, message.targets, message.startIndex || 0);
  } else if (message.type === 'STOP_BOT') {
    stopBot(message.platform);
  }
  return true;
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REPORT_COMPLETE') {
    handleReportComplete(message.platform, message.username, message.status);
  } else if (message.type === 'REPORT_ERROR') {
    handleReportError(message.platform, message.username, message.error);
  }
  return true;
});

async function startBot(platform, tabId, targets, startIndex) {
  const prefix = platform === 'instagram' ? 'ig' : 'tw';
  const baseUrl = platform === 'instagram' ? 'https://www.instagram.com/' : 'https://x.com/';
  
  isRunning[platform] = true;
  currentTabId[platform] = tabId;
  
  // If starting fresh (index 0), clear results
  if (startIndex === 0) {
    await chrome.storage.local.set({
      [`${prefix}_isRunning`]: true,
      [`${prefix}_currentIndex`]: 0,
      [`${prefix}_results`]: [],
      [`${prefix}_totalTargets`]: targets.length
    });
  } else {
    // Resuming - keep existing results
    await chrome.storage.local.set({
      [`${prefix}_isRunning`]: true,
      [`${prefix}_currentIndex`]: startIndex,
      [`${prefix}_totalTargets`]: targets.length
    });
  }
  
  // Process targets starting from startIndex
  for (let i = startIndex; i < targets.length; i++) {
    // Check if still running
    const state = await chrome.storage.local.get([`${prefix}_isRunning`]);
    if (!state[`${prefix}_isRunning`]) {
      console.log(`[${platform}] Bot stopped by user`);
      break;
    }
    
    const username = targets[i];
    await chrome.storage.local.set({ [`${prefix}_currentIndex`]: i });
    
    // Add processing status
    await addResult(prefix, username, 'processing');
    
    // Navigate to profile
    try {
      await chrome.tabs.update(tabId, {
        url: `${baseUrl}${username}`
      });
      
      // Wait for page to load
      await waitForTabLoad(tabId);
      await sleep(2500); // Give extra time for Twitter's SPA
      
      // Send message to content script to do the report
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'DO_REPORT',
          username: username
        });
        
        if (response && response.success) {
          await updateResult(prefix, username, 'success');
        } else if (response && response.notFound) {
          await updateResult(prefix, username, 'skipped');
        } else {
          await updateResult(prefix, username, 'failed');
        }
      } catch (e) {
        console.error(`[${platform}] Error sending message to content script:`, e);
        await updateResult(prefix, username, 'failed');
      }
      
      // Mark this item as completed (advance progress) before the inter-target delay
      await chrome.storage.local.set({ [`${prefix}_currentIndex`]: i + 1 });
      
      // Wait between profiles (15-25 seconds for Instagram, 20-30 for Twitter)
      if (i < targets.length - 1) {
        const baseDelay = platform === 'twitter' ? 20000 : 15000;
        const delay = baseDelay + Math.random() * 10000;
        await sleep(delay);
      }
      
    } catch (e) {
      console.error(`[${platform}] Error processing`, username, e);
      await updateResult(prefix, username, 'failed');
      // Even on errors, advance progress so Resume continues forward
      await chrome.storage.local.set({ [`${prefix}_currentIndex`]: i + 1 });
    }
  }
  
  // Done
  isRunning[platform] = false;
  await chrome.storage.local.set({ [`${prefix}_isRunning`]: false });
  
  // Update final index
  const state = await chrome.storage.local.get([`${prefix}_totalTargets`]);
  await chrome.storage.local.set({ [`${prefix}_currentIndex`]: state[`${prefix}_totalTargets`] });
}

function stopBot(platform) {
  const prefix = platform === 'instagram' ? 'ig' : 'tw';
  isRunning[platform] = false;
  chrome.storage.local.set({ [`${prefix}_isRunning`]: false });
}

async function addResult(prefix, username, status) {
  const state = await chrome.storage.local.get([`${prefix}_results`]);
  const results = state[`${prefix}_results`] || [];
  // Check if already exists (for resume case)
  const existing = results.findIndex(r => r.username === username);
  if (existing >= 0) {
    results[existing].status = status;
  } else {
    results.push({ username, status });
  }
  await chrome.storage.local.set({ [`${prefix}_results`]: results });
  notifyPopup();
}

async function updateResult(prefix, username, status) {
  const state = await chrome.storage.local.get([`${prefix}_results`]);
  const results = state[`${prefix}_results`] || [];
  const idx = results.findIndex(r => r.username === username);
  if (idx >= 0) {
    results[idx].status = status;
  }
  await chrome.storage.local.set({ [`${prefix}_results`]: results });
  notifyPopup();
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE' }).catch(() => {
    // Popup might be closed, ignore
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    
    // Timeout after 15 seconds
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleReportComplete(platform, username, status) {
  const prefix = platform === 'instagram' ? 'ig' : 'tw';
  await updateResult(prefix, username, status);
}

async function handleReportError(platform, username, error) {
  const prefix = platform === 'instagram' ? 'ig' : 'tw';
  console.error(`[${platform}] Report error for`, username, error);
  await updateResult(prefix, username, 'failed');
}
