// Background Service Worker - Orchestrates the bot

// State
let isRunning = false;
let currentTabId = null;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_BOT') {
    startBot(message.tabId, message.targets, message.startIndex || 0);
  } else if (message.type === 'STOP_BOT') {
    stopBot();
  }
  return true;
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REPORT_COMPLETE') {
    handleReportComplete(message.username, message.status);
  } else if (message.type === 'REPORT_ERROR') {
    handleReportError(message.username, message.error);
  }
  return true;
});

async function startBot(tabId, targets, startIndex) {
  isRunning = true;
  currentTabId = tabId;
  
  // If starting fresh (index 0), clear results
  if (startIndex === 0) {
    await chrome.storage.local.set({
      isRunning: true,
      currentIndex: 0,
      results: [],
      totalTargets: targets.length
    });
  } else {
    // Resuming - keep existing results
    await chrome.storage.local.set({
      isRunning: true,
      currentIndex: startIndex,
      totalTargets: targets.length
    });
  }
  
  // Process targets starting from startIndex
  for (let i = startIndex; i < targets.length; i++) {
    // Check if still running
    const state = await chrome.storage.local.get(['isRunning']);
    if (!state.isRunning) {
      console.log('Bot stopped by user');
      break;
    }
    
    const username = targets[i];
    await chrome.storage.local.set({ currentIndex: i });
    
    // Add processing status
    await addResult(username, 'processing');
    
    // Navigate to profile
    try {
      await chrome.tabs.update(tabId, {
        url: `https://www.instagram.com/${username}/`
      });
      
      // Wait for page to load
      await waitForTabLoad(tabId);
      await sleep(2000);
      
      // Send message to content script to do the report
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'DO_REPORT',
          username: username
        });
        
        if (response && response.success) {
          await updateResult(username, 'success');
        } else if (response && response.notFound) {
          await updateResult(username, 'skipped');
        } else {
          await updateResult(username, 'failed');
        }
      } catch (e) {
        console.error('Error sending message to content script:', e);
        await updateResult(username, 'failed');
      }

      // Mark this item as completed (advance progress) before the inter-target delay
      await chrome.storage.local.set({ currentIndex: i + 1 });
      
      // Wait between profiles (15-25 seconds)
      if (i < targets.length - 1) {
        const delay = 15000 + Math.random() * 10000;
        await sleep(delay);
      }
      
    } catch (e) {
      console.error('Error processing', username, e);
      await updateResult(username, 'failed');
      // Even on errors, advance progress so Resume continues forward
      await chrome.storage.local.set({ currentIndex: i + 1 });
    }
  }
  
  // Done
  isRunning = false;
  await chrome.storage.local.set({ isRunning: false });
  
  // Update final index
  const state = await chrome.storage.local.get(['totalTargets']);
  await chrome.storage.local.set({ currentIndex: state.totalTargets });
}

function stopBot() {
  isRunning = false;
  chrome.storage.local.set({ isRunning: false });
}

async function addResult(username, status) {
  const state = await chrome.storage.local.get(['results']);
  const results = state.results || [];
  // Check if already exists (for resume case)
  const existing = results.findIndex(r => r.username === username);
  if (existing >= 0) {
    results[existing].status = status;
  } else {
    results.push({ username, status });
  }
  await chrome.storage.local.set({ results });
  notifyPopup();
}

async function updateResult(username, status) {
  const state = await chrome.storage.local.get(['results']);
  const results = state.results || [];
  const idx = results.findIndex(r => r.username === username);
  if (idx >= 0) {
    results[idx].status = status;
  }
  await chrome.storage.local.set({ results });
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
    
    // Timeout after 10 seconds
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleReportComplete(username, status) {
  await updateResult(username, status);
}

async function handleReportError(username, error) {
  console.error('Report error for', username, error);
  await updateResult(username, 'failed');
}
