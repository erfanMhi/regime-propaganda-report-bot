// Popup UI Logic

// Default targets (pre-filled)
const DEFAULT_TARGETS = `khameneiii_sarbazann
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

// DOM elements
const igStatus = document.getElementById('ig-status');
const botStatus = document.getElementById('bot-status');
const warning = document.getElementById('warning');
const targetsInput = document.getElementById('targets');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const progressFill = document.getElementById('progress');
const progressText = document.getElementById('progress-text');
const resultsDiv = document.getElementById('results');

// State
let instagramTabId = null;

// Initialize
async function init() {
  // Load saved targets or use defaults
  const stored = await chrome.storage.local.get(['targets', 'results', 'currentIndex', 'isRunning']);
  
  if (stored.targets) {
    targetsInput.value = stored.targets;
  } else {
    targetsInput.value = DEFAULT_TARGETS;
    await chrome.storage.local.set({ targets: DEFAULT_TARGETS });
  }
  
  // Save targets on change
  targetsInput.addEventListener('input', async () => {
    await chrome.storage.local.set({ targets: targetsInput.value });
  });
  
  // Check for Instagram tab
  await checkInstagramTab();
  
  // Update UI from stored state
  updateUIFromStorage(stored);
  
  // Set up button handlers
  startBtn.addEventListener('click', startBot);
  stopBtn.addEventListener('click', stopBot);
  
  // Listen for updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATUS_UPDATE') {
      updateUI(message.data);
    }
  });
  
  // Poll for status
  setInterval(checkStatus, 1000);
}

async function checkInstagramTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    
    if (tabs.length > 0) {
      instagramTabId = tabs[0].id;
      igStatus.textContent = 'Ready';
      igStatus.className = 'status-value ready';
      warning.style.display = 'none';
      startBtn.disabled = false;
    } else {
      instagramTabId = null;
      igStatus.textContent = 'Not Found';
      igStatus.className = 'status-value not-ready';
      warning.style.display = 'block';
      startBtn.disabled = true;
    }
  } catch (e) {
    console.error('Error checking tabs:', e);
  }
}

async function checkStatus() {
  await checkInstagramTab();
  
  const stored = await chrome.storage.local.get(['results', 'currentIndex', 'isRunning', 'totalTargets']);
  updateUIFromStorage(stored);
}

function updateUIFromStorage(stored) {
  const isRunning = stored.isRunning || false;
  const currentIndex = stored.currentIndex || 0;
  const totalTargets = stored.totalTargets || 0;
  const results = stored.results || [];
  
  // Update bot status
  if (isRunning) {
    botStatus.textContent = 'Running...';
    botStatus.className = 'status-value running';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    botStatus.textContent = 'Idle';
    botStatus.className = 'status-value ready';
    stopBtn.disabled = true;
    if (instagramTabId) {
      startBtn.disabled = false;
    }
  }
  
  // Update progress
  if (totalTargets > 0) {
    const percent = Math.round((currentIndex / totalTargets) * 100);
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${currentIndex} / ${totalTargets}`;
  } else {
    progressFill.style.width = '0%';
    progressText.textContent = '0 / 0';
  }
  
  // Update results
  renderResults(results);
}

function updateUI(data) {
  updateUIFromStorage(data);
}

function renderResults(results) {
  if (!results || results.length === 0) {
    resultsDiv.innerHTML = '';
    return;
  }
  
  const html = results.map(r => `
    <div class="result-item ${r.status}">
      <span class="result-username">@${r.username}</span>
      <span class="result-status">${getStatusText(r.status)}</span>
    </div>
  `).join('');
  
  resultsDiv.innerHTML = html;
  resultsDiv.scrollTop = resultsDiv.scrollHeight;
}

function getStatusText(status) {
  const texts = {
    success: 'Reported ✓',
    failed: 'Failed ✗',
    skipped: 'Not Found',
    processing: 'Processing...'
  };
  return texts[status] || status;
}

async function startBot() {
  const targets = targetsInput.value
    .split('\n')
    .map(t => t.trim())
    .filter(t => t.length > 0);
  
  if (targets.length === 0) {
    alert('Please add at least one target username');
    return;
  }
  
  // Save state
  await chrome.storage.local.set({
    targets: targetsInput.value,
    targetsList: targets,
    totalTargets: targets.length,
    currentIndex: 0,
    results: [],
    isRunning: true
  });
  
  // Send message to background to start
  chrome.runtime.sendMessage({
    type: 'START_BOT',
    tabId: instagramTabId,
    targets: targets
  });
  
  startBtn.disabled = true;
  stopBtn.disabled = false;
  botStatus.textContent = 'Running...';
  botStatus.className = 'status-value running';
}

async function stopBot() {
  await chrome.storage.local.set({ isRunning: false });
  
  chrome.runtime.sendMessage({ type: 'STOP_BOT' });
  
  startBtn.disabled = false;
  stopBtn.disabled = true;
  botStatus.textContent = 'Stopped';
  botStatus.className = 'status-value not-ready';
}

// Initialize on load
init();
