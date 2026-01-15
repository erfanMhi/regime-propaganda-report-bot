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

const $ = id => document.getElementById(id);
let tabId = null;

async function init() {
  const s = await chrome.storage.local.get(['targets', 'results', 'currentIndex', 'isRunning', 'totalTargets']);
  $('targets').value = s.targets || DEFAULT_TARGETS;
  if (!s.targets) await chrome.storage.local.set({ targets: DEFAULT_TARGETS });
  $('targets').oninput = async () => await chrome.storage.local.set({ targets: $('targets').value });
  $('start-btn').onclick = start;
  $('stop-btn').onclick = stop;
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'STATUS_UPDATE') update(m.data) });
  setInterval(check, 1000);
  check();
}

async function check() {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length > 0) {
    tabId = tabs[0].id;
    $('ig-status').textContent = 'Ready';
    $('ig-status').className = 'status-value ready';
    $('warning').style.display = 'none';
    $('start-btn').disabled = false;
  } else {
    tabId = null;
    $('ig-status').textContent = 'Not Found';
    $('ig-status').className = 'status-value not-ready';
    $('warning').style.display = 'block';
    $('start-btn').disabled = true;
  }
  const s = await chrome.storage.local.get(['results', 'currentIndex', 'isRunning', 'totalTargets']);
  update(s);
}

function update(s) {
  const running = s.isRunning || false;
  const idx = s.currentIndex || 0;
  const total = s.totalTargets || 0;
  const results = s.results || [];
  
  $('bot-status').textContent = running ? 'Running...' : 'Idle';
  $('bot-status').className = 'status-value ' + (running ? 'running' : 'ready');
  $('start-btn').disabled = running || !tabId;
  $('stop-btn').disabled = !running;
  $('progress').style.width = total > 0 ? Math.round(idx / total * 100) + '%' : '0%';
  $('progress-text').textContent = idx + ' / ' + total;
  $('results').innerHTML = results.map(r => 
    `<div class="result-item ${r.status}"><span>@${r.username}</span><span>${
      { success: 'Reported ✓', failed: 'Failed ✗', skipped: 'Not Found', processing: 'Processing...' }[r.status] || r.status
    }</span></div>`
  ).join('');
}

async function start() {
  const targets = $('targets').value.split('\n').map(t => t.trim()).filter(t => t);
  if (!targets.length) return alert('Add at least one target');
  await chrome.storage.local.set({
    targets: $('targets').value,
    targetsList: targets,
    totalTargets: targets.length,
    currentIndex: 0,
    results: [],
    isRunning: true
  });
  chrome.runtime.sendMessage({ type: 'START_BOT', tabId, targets });
}

async function stop() {
  await chrome.storage.local.set({ isRunning: false });
  chrome.runtime.sendMessage({ type: 'STOP_BOT' });
}

init();
