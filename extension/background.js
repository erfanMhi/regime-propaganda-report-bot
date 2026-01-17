// Background Service Worker - Orchestrates the bot for both Instagram and X/Twitter.
//
// MV3 note: service workers can be suspended between events. A long-running loop with `sleep()`
// is not reliable. This file uses an alarm-driven "tick" runner so work can resume safely.

const MAX_ATTEMPTS_PER_TARGET = 3;
const TAB_LOAD_TIMEOUT_MS = 20000;
// Instagram's reporting flow is slower/more variable than Twitter's and can exceed 25s
// (multiple modal steps + UI transitions + network). Use platform-specific timeouts.
const CONTENT_SCRIPT_TIMEOUT_MS_BY_PLATFORM = {
  instagram: 90000,
  twitter: 45000,
};
const TICK_LOCK_TTL_MS = 120000;
const DAILY_LIMIT = 50;

// ============================================================================
// STARTUP RECOVERY
// ============================================================================
// When Chrome restarts, alarms are lost but storage persists.
// This recovers any interrupted bot runs.

chrome.runtime.onStartup.addListener(() => {
  recoverInterruptedRuns();
});

chrome.runtime.onInstalled.addListener(() => {
  recoverInterruptedRuns();
});

async function recoverInterruptedRuns() {
  for (const platform of ['instagram', 'twitter']) {
    const prefix = toPrefix(platform);
    const state = await chrome.storage.local.get([
      `${prefix}_isRunning`,
      `${prefix}_job`,
      `${prefix}_currentIndex`,
      `${prefix}_totalTargets`
    ]);

    if (state[`${prefix}_isRunning`] && state[`${prefix}_job`]) {
      // Bot was running when Chrome closed - mark as paused so user can resume
      console.log(`[ReportBot] Recovering interrupted ${platform} run - marking as paused`);
      await chrome.storage.local.set({
        [`${prefix}_isRunning`]: false,
        // Keep currentIndex and job so Resume works
      });
    }
  }
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'START_BOT') {
    void startBot({
      platform: message.platform,
      tabId: message.tabId,
      targets: message.targets || [],
      startIndex: message.startIndex || 0,
    });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'STOP_BOT') {
    void stopBot(message.platform);
    sendResponse({ ok: true });
    return;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const platform = platformFromAlarmName(alarm && alarm.name);
  if (!platform) return;
  void tick(platform);
});

async function startBot({ platform, tabId, targets, startIndex }) {
  const prefix = toPrefix(platform);
  const safeTargets = Array.isArray(targets)
    ? targets
        .map((t) => String(t || '').trim().replace(/^@+/, ''))
        .filter(Boolean)
    : [];
  const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // Clear any stale lock from a previous crashed/interrupted run to avoid blocking.
  await chrome.storage.local.remove([`${prefix}_tickLock`]);

  // Clear any previous limit-paused state when (re)starting.
  await chrome.storage.local.set({ [`${prefix}_limitPaused`]: false });

  // Persist job state for reliability across SW suspension.
  await chrome.storage.local.set({
    [`${prefix}_runId`]: runId,
    [`${prefix}_job`]: {
      platform,
      tabId,
      targets: safeTargets,
      index: Math.max(0, startIndex || 0),
      attempt: 0,
      runId,
      updatedAt: Date.now(),
    },
  });

  if ((startIndex || 0) === 0) {
    await chrome.storage.local.set({
      [`${prefix}_isRunning`]: true,
      [`${prefix}_currentIndex`]: 0,
      [`${prefix}_results`]: [],
      [`${prefix}_totalTargets`]: safeTargets.length,
    });
  } else {
    await chrome.storage.local.set({
      [`${prefix}_isRunning`]: true,
      [`${prefix}_currentIndex`]: startIndex,
      [`${prefix}_totalTargets`]: safeTargets.length,
    });
  }

  await scheduleTick(platform, 50);
  notifyPopup();
}

async function stopBot(platform) {
  const prefix = toPrefix(platform);
  await chrome.storage.local.set({
    [`${prefix}_isRunning`]: false,
    [`${prefix}_runId`]: null,
    // Manual stop should clear the "paused due to daily limit" state.
    [`${prefix}_limitPaused`]: false,
  });
  await chrome.storage.local.remove([`${prefix}_job`, `${prefix}_tickLock`]);
  await clearTick(platform);
  notifyPopup();
}

async function tick(platform) {
  const prefix = toPrefix(platform);
  const state = await chrome.storage.local.get([`${prefix}_isRunning`, `${prefix}_job`, `${prefix}_runId`, `${prefix}_tickLock`]);

  if (!state[`${prefix}_isRunning`]) {
    await clearTick(platform);
    return;
  }

  const job = state[`${prefix}_job`];
  if (!job || !Array.isArray(job.targets)) {
    // Corrupt/missing job; stop safely.
    await stopBot(platform);
    return;
  }

  // Prevent overlapping ticks (alarms can fire while a previous tick is still running).
  const lockOk = await acquireTickLock(prefix, state[`${prefix}_tickLock`]);
  if (!lockOk) {
    // Another tick is likely in progress; try again shortly.
    await scheduleTick(platform, 1000);
    return;
  }

  const activeRunId = state[`${prefix}_runId`];
  if (!activeRunId || job.runId !== activeRunId) {
    await releaseTickLock(prefix);
    return;
  }

  // If we've already hit today's daily limit (and user hasn't overridden), pause before doing work.
  if (await isDailyLimitReached(prefix)) {
    await chrome.storage.local.set({
      [`${prefix}_isRunning`]: false,
      [`${prefix}_limitPaused`]: true,
    });
    await clearTick(platform);
    await releaseTickLock(prefix);
    notifyPopup();
    return;
  }

  const targets = job.targets;
  const index = Number.isFinite(job.index) ? job.index : 0;
  const attempt = Number.isFinite(job.attempt) ? job.attempt : 0;

  if (index >= targets.length) {
    // All targets processed; stop cleanly.
    await chrome.storage.local.set({
      [`${prefix}_isRunning`]: false,
      [`${prefix}_runId`]: null,
      [`${prefix}_currentIndex`]: targets.length,
    });
    await chrome.storage.local.remove([`${prefix}_job`]);
    await clearTick(platform);
    await releaseTickLock(prefix);
    notifyPopup();
    return;
  }

  const username = targets[index];
  const tabId = job.tabId;
  if (!tabId) {
    // No tab to operate on; pause.
    await releaseTickLock(prefix);
    await stopBot(platform);
    return;
  }

  // Normalize username early to ensure consistency across all result updates.
  const normalizedUsername = String(username || '').trim().replace(/^@+/, '');

  try {
    // Ensure tab exists before we commit to processing this target.
    await chrome.tabs.get(tabId);

    // Mark processing only after we've validated the tab exists.
    await chrome.storage.local.set({ [`${prefix}_currentIndex`]: index });
    await addOrUpdateResult(prefix, normalizedUsername, 'processing');
    const baseUrl = platform === 'instagram' ? 'https://www.instagram.com/' : 'https://x.com/';
    await chrome.tabs.update(tabId, { url: `${baseUrl}${normalizedUsername}` });
    await waitForTabLoad(tabId, TAB_LOAD_TIMEOUT_MS);

    // Check if run was cancelled during navigation.
    if (!await isRunActive(prefix, job.runId)) return;

    // Wait 3-7 seconds (random) so user can review the profile before reporting.
    const reviewDelayMs = 3000 + Math.floor(Math.random() * 4000);
    await new Promise((r) => setTimeout(r, reviewDelayMs));

    // Check again if run was cancelled during the review delay.
    if (!await isRunActive(prefix, job.runId)) return;

    // Ensure content script is present (best-effort).
    await ensureContentScript(platform, tabId);

    // Ask content script to perform the report with a timeout.
    const contentScriptTimeoutMs =
      CONTENT_SCRIPT_TIMEOUT_MS_BY_PLATFORM[platform] || 60000;

    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'DO_REPORT', username: normalizedUsername }),
      contentScriptTimeoutMs
    ).catch(async (err) => {
      // "Receiving end does not exist" often means content script isn't ready yet.
      await ensureContentScript(platform, tabId);
      return await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'DO_REPORT', username: normalizedUsername }),
        contentScriptTimeoutMs
      );
    });

    // Stop/Resume can happen while we're mid-tick. If runId changed, abort without writing state.
    if (!await isRunActive(prefix, job.runId)) return;

    if (response && response.rateLimited && response.retryAfterMs) {
      // Don't fail the target; reschedule the same index later.
      await chrome.storage.local.set({
        [`${prefix}_job`]: { ...job, index, attempt: 0, updatedAt: Date.now() },
      });
      await scheduleTick(platform, Math.max(30000, response.retryAfterMs));
      notifyPopup();
      return;
    }

    if (response && response.success) {
      console.log(`[ReportBot] Report SUCCESS for ${normalizedUsername}, advancing to index ${index + 1}`);
      await addOrUpdateResult(prefix, normalizedUsername, 'success');

      // Increment daily count and check limit
      const newCount = await incrementDailyCount(prefix);
      if (newCount >= DAILY_LIMIT && !await isLimitOverridden(prefix)) {
        // Pause the bot - daily limit reached
        await chrome.storage.local.set({
          [`${prefix}_isRunning`]: false,
          [`${prefix}_limitPaused`]: true,
        });
        await advanceJob(prefix, job, index + 1);
        await clearTick(platform);
        // Lock released by finally block
        return;
      }

      await advanceJob(prefix, job, index + 1);
      await scheduleTick(platform, interTargetDelayMs(platform));
      return;
    }

    if (response && response.notFound) {
      await addOrUpdateResult(prefix, normalizedUsername, 'skipped');
      await advanceJob(prefix, job, index + 1);
      await scheduleTick(platform, interTargetDelayMs(platform));
      return;
    }

    // Unknown/failed response.
    throw new Error((response && response.error) || 'Report failed');
  } catch (err) {
    const stillActive = await isRunActive(prefix, job.runId);
    if (!stillActive) return;

    const nextAttempt = attempt + 1;
    if (nextAttempt < MAX_ATTEMPTS_PER_TARGET) {
      await chrome.storage.local.set({
        [`${prefix}_job`]: { ...job, index, attempt: nextAttempt, updatedAt: Date.now() },
      });
      // Quick retry with backoff.
      await scheduleTick(platform, 2000 * nextAttempt);
      notifyPopup();
      return;
    }

    await addOrUpdateResult(prefix, normalizedUsername, 'failed');
    await advanceJob(prefix, job, index + 1);
    await scheduleTick(platform, interTargetDelayMs(platform));
  } finally {
    notifyPopup();
    await releaseTickLock(prefix);
  }
}

async function advanceJob(prefix, job, nextIndex) {
  console.log(`[ReportBot] advanceJob: ${prefix} index ${job.index} -> ${nextIndex}`);
  await chrome.storage.local.set({
    [`${prefix}_job`]: { ...job, index: nextIndex, attempt: 0, updatedAt: Date.now() },
    [`${prefix}_currentIndex`]: nextIndex,
  });
}

function interTargetDelayMs(platform) {
  const baseDelay = platform === 'twitter' ? 20000 : 15000;
  return baseDelay + Math.floor(Math.random() * 10000);
}

async function ensureContentScript(platform, tabId) {
  const file = platform === 'instagram' ? 'content-instagram.js' : 'content-twitter.js';
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
    });
  } catch (e) {
    // If injection fails (e.g. wrong URL), the next attempt will surface it via sendMessage.
  }
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (err) reject(err);
      else resolve();
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo && changeInfo.status === 'complete') {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(() => finish(new Error('Tab load timeout')), timeoutMs);
  });
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

async function addOrUpdateResult(prefix, username, status) {
  const state = await chrome.storage.local.get([`${prefix}_results`]);
  const results = state[`${prefix}_results`] || [];
  const existing = results.findIndex((r) => r.username === username);
  if (existing >= 0) results[existing].status = status;
  else results.push({ username, status });
  await chrome.storage.local.set({ [`${prefix}_results`]: results });
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE' }).catch(() => {
    // Popup might be closed; ignore.
  });
}

async function scheduleTick(platform, delayMs) {
  const name = alarmName(platform);
  await chrome.alarms.create(name, { when: Date.now() + Math.max(0, delayMs || 0) });
}

async function clearTick(platform) {
  await chrome.alarms.clear(alarmName(platform));
}

function alarmName(platform) {
  return `reportbot_tick_${platform}`;
}

function platformFromAlarmName(name) {
  if (!name || typeof name !== 'string') return null;
  if (name === alarmName('instagram')) return 'instagram';
  if (name === alarmName('twitter')) return 'twitter';
  return null;
}

function toPrefix(platform) {
  return platform === 'instagram' ? 'ig' : 'tw';
}

async function isRunActive(prefix, runId) {
  const s = await chrome.storage.local.get([`${prefix}_isRunning`, `${prefix}_runId`]);
  return Boolean(s[`${prefix}_isRunning`]) && s[`${prefix}_runId`] === runId;
}

async function acquireTickLock(prefix, existingLock) {
  const now = Date.now();
  if (existingLock && existingLock.expiresAt && existingLock.expiresAt > now) return false;

  const token = `${now}_${Math.random().toString(16).slice(2)}`;
  const lock = { token, expiresAt: now + TICK_LOCK_TTL_MS };
  await chrome.storage.local.set({ [`${prefix}_tickLock`]: lock });

  const confirm = await chrome.storage.local.get([`${prefix}_tickLock`]);
  return confirm[`${prefix}_tickLock`] && confirm[`${prefix}_tickLock`].token === token;
}

async function releaseTickLock(prefix) {
  await chrome.storage.local.remove([`${prefix}_tickLock`]);
}

// ============================================================================
// DAILY LIMIT TRACKING
// ============================================================================

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

async function getDailyCount(prefix) {
  const key = `${prefix}_daily_count`;
  const dateKey = `${prefix}_daily_date`;
  const today = getTodayKey();

  const data = await chrome.storage.local.get([key, dateKey]);

  if (data[dateKey] !== today) {
    await chrome.storage.local.set({ [key]: 0, [dateKey]: today });
    return 0;
  }

  return data[key] || 0;
}

async function incrementDailyCount(prefix) {
  const key = `${prefix}_daily_count`;
  const dateKey = `${prefix}_daily_date`;
  const today = getTodayKey();

  const data = await chrome.storage.local.get([key, dateKey]);

  if (data[dateKey] !== today) {
    await chrome.storage.local.set({ [key]: 1, [dateKey]: today });
    return 1;
  }

  const newCount = (data[key] || 0) + 1;
  await chrome.storage.local.set({ [key]: newCount });
  return newCount;
}

async function isDailyLimitReached(prefix) {
  const count = await getDailyCount(prefix);
  const overrideKey = `${prefix}_limit_override`;
  const data = await chrome.storage.local.get([overrideKey]);

  // If user has overridden the limit for today, don't pause
  if (data[overrideKey] === getTodayKey()) {
    return false;
  }

  return count >= DAILY_LIMIT;
}

async function isLimitOverridden(prefix) {
  const overrideKey = `${prefix}_limit_override`;
  const data = await chrome.storage.local.get([overrideKey]);
  return data[overrideKey] === getTodayKey();
}
