// Default targets for Instagram
const DEFAULT_IG_TARGETS = `khameneiii_sarbazann
saeedism_iri
meysame_tamaaarr4
hosseinmohajer_official
alirezahp128
sohrab_khatami73
aqaaye_h
musareza_arfei
seyyedoona
az_mantagheh
seyyedoona_official
seyyedoona.text
mo.darzi9191
_amiri8303
miss_gilanii
ahmadsafariofficial
amir.malekniya
farshidbabai62
nazdikesobeh
mohammad_.reza68690
sheykh_azad
hamidkeramatkhah
basirat.ammar3
ihanif2_ir
sanazshaerii
kalamesaleh
khanoommhajii
velayat_1362
abolhasani_officiall
muhammad_shahi
bedoonemarze
navaei.ir
nanototv2
mr_langeruodi
a.r.geraie
mohammad.tajik313
saayebanoo
ali.zahraei.110
mojtaba.azhdari81`;

// Default targets for Twitter (add your targets here)
const DEFAULT_TW_TARGETS = ``;

const $ = id => document.getElementById(id);
let igTabId = null;
let twTabId = null;
let currentPlatform = 'instagram';

async function init() {
  // Setup tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  
  // Load saved targets
  const s = await chrome.storage.local.get([
    'ig_targets', 'ig_results', 'ig_currentIndex', 'ig_isRunning', 'ig_totalTargets',
    'tw_targets', 'tw_results', 'tw_currentIndex', 'tw_isRunning', 'tw_totalTargets'
  ]);
  
  // Instagram
  $('ig-targets').value = s.ig_targets || DEFAULT_IG_TARGETS;
  if (!s.ig_targets) await chrome.storage.local.set({ ig_targets: DEFAULT_IG_TARGETS });
  $('ig-targets').oninput = async () => await chrome.storage.local.set({ ig_targets: $('ig-targets').value });
  $('ig-start-btn').onclick = () => start('instagram');
  $('ig-resume-btn').onclick = () => resume('instagram');
  $('ig-stop-btn').onclick = () => stop('instagram');
  
  // Twitter
  $('tw-targets').value = s.tw_targets || DEFAULT_TW_TARGETS;
  if (!s.tw_targets && DEFAULT_TW_TARGETS) await chrome.storage.local.set({ tw_targets: DEFAULT_TW_TARGETS });
  $('tw-targets').oninput = async () => await chrome.storage.local.set({ tw_targets: $('tw-targets').value });
  $('tw-start-btn').onclick = () => start('twitter');
  $('tw-resume-btn').onclick = () => resume('twitter');
  $('tw-stop-btn').onclick = () => stop('twitter');
  
  // Listen for status updates
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'STATUS_UPDATE') check() });
  
  setInterval(check, 1000);
  check();
}

function switchTab(platform) {
  currentPlatform = platform;
  
  // Update tab active state
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === platform);
    if (tab.dataset.tab === 'twitter') {
      tab.classList.toggle('twitter', tab.dataset.tab === platform);
    }
  });
  
  // Show/hide content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });
  $(`${platform === 'instagram' ? 'instagram' : 'twitter'}-content`).classList.add('active');
}

async function check() {
  // Check for Instagram tabs
  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (igTabs.length > 0) {
    igTabId = igTabs[0].id;
    $('ig-status').textContent = 'Ready';
    $('ig-status').className = 'status-value ready';
    $('ig-warning').style.display = 'none';
  } else {
    igTabId = null;
    $('ig-status').textContent = 'Not Found';
    $('ig-status').className = 'status-value not-ready';
    $('ig-warning').style.display = 'block';
  }
  
  // Check for Twitter tabs
  const twTabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (twTabs.length > 0) {
    twTabId = twTabs[0].id;
    $('tw-status').textContent = 'Ready';
    $('tw-status').className = 'status-value ready twitter';
    $('tw-warning').style.display = 'none';
  } else {
    twTabId = null;
    $('tw-status').textContent = 'Not Found';
    $('tw-status').className = 'status-value not-ready';
    $('tw-warning').style.display = 'block';
  }
  
  // Update UI for both platforms
  const s = await chrome.storage.local.get([
    'ig_results', 'ig_currentIndex', 'ig_isRunning', 'ig_totalTargets',
    'tw_results', 'tw_currentIndex', 'tw_isRunning', 'tw_totalTargets'
  ]);
  
  updatePlatformUI('ig', s.ig_isRunning, s.ig_currentIndex, s.ig_totalTargets, s.ig_results, igTabId);
  updatePlatformUI('tw', s.tw_isRunning, s.tw_currentIndex, s.tw_totalTargets, s.tw_results, twTabId);
}

function updatePlatformUI(prefix, running, idx, total, results, tabId) {
  running = running || false;
  idx = idx || 0;
  total = total || 0;
  results = results || [];
  
  const hasProgress = idx > 0 && idx < total && !running;
  
  $(`${prefix}-bot-status`).textContent = running ? 'Running...' : (hasProgress ? 'Paused' : 'Idle');
  $(`${prefix}-bot-status`).className = 'status-value ' + (running ? 'running' : (hasProgress ? 'paused' : 'ready'));
  
  $(`${prefix}-start-btn`).disabled = running || !tabId;
  $(`${prefix}-resume-btn`).disabled = running || !tabId;
  $(`${prefix}-stop-btn`).disabled = !running;
  
  if (hasProgress) {
    $(`${prefix}-resume-btn`).classList.remove('hidden');
  } else {
    $(`${prefix}-resume-btn`).classList.add('hidden');
  }
  
  $(`${prefix}-progress`).style.width = total > 0 ? Math.round(idx / total * 100) + '%' : '0%';
  $(`${prefix}-progress-text`).textContent = idx + ' / ' + total;
  $(`${prefix}-results`).innerHTML = results.map(r => 
    `<div class="result-item ${r.status}"><span>@${r.username}</span><span>${
      { success: 'Reported ✓', failed: 'Failed ✗', skipped: 'Not Found', processing: 'Processing...' }[r.status] || r.status
    }</span></div>`
  ).join('');
}

async function start(platform) {
  const prefix = platform === 'instagram' ? 'ig' : 'tw';
  const tabId = platform === 'instagram' ? igTabId : twTabId;
  const targets = $(`${prefix}-targets`).value.split('\n').map(t => t.trim()).filter(t => t);
  
  if (!targets.length) return alert('Add at least one target');
  
  await chrome.storage.local.set({
    [`${prefix}_targets`]: $(`${prefix}-targets`).value,
    [`${prefix}_targetsList`]: targets,
    [`${prefix}_totalTargets`]: targets.length,
    [`${prefix}_currentIndex`]: 0,
    [`${prefix}_results`]: [],
    [`${prefix}_isRunning`]: true
  });
  
  chrome.runtime.sendMessage({ type: 'START_BOT', platform, tabId, targets, startIndex: 0 });
}

async function resume(platform) {
  const prefix = platform === 'instagram' ? 'ig' : 'tw';
  const tabId = platform === 'instagram' ? igTabId : twTabId;
  const s = await chrome.storage.local.get([`${prefix}_currentIndex`, `${prefix}_totalTargets`, `${prefix}_results`]);
  const targets = $(`${prefix}-targets`).value.split('\n').map(t => t.trim()).filter(t => t);
  
  if (!targets.length) return alert('Add at least one target');
  
  const startIndex = s[`${prefix}_currentIndex`] || 0;
  
  await chrome.storage.local.set({
    [`${prefix}_targets`]: $(`${prefix}-targets`).value,
    [`${prefix}_targetsList`]: targets,
    [`${prefix}_totalTargets`]: targets.length,
    [`${prefix}_isRunning`]: true
  });
  
  chrome.runtime.sendMessage({ type: 'START_BOT', platform, tabId, targets, startIndex });
}

async function stop(platform) {
  const prefix = platform === 'instagram' ? 'ig' : 'tw';
  await chrome.storage.local.set({ [`${prefix}_isRunning`]: false });
  chrome.runtime.sendMessage({ type: 'STOP_BOT', platform });
}

init();
