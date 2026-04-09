/* ════════════════════════════════════════════════════════════
   Smart Dairy Monitor — Dashboard JS
   Local simulation: reads diagram.json values via backend,
   interactive sliders mirror Wokwi component controls.
   ════════════════════════════════════════════════════════════ */

const WS_URL   = `ws://${location.host}/ws`;
const API_BASE = `http://${location.host}/api`;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const connDot     = document.getElementById('connDot');
const connLabel   = document.getElementById('connLabel');
const lastUpdated = document.getElementById('lastUpdated');
const statusHero  = document.getElementById('statusHero');
const statusBadge = document.getElementById('statusBadge');
const statusScores= document.getElementById('statusScores');
const ledRed      = document.getElementById('ledRed');
const ledYellow   = document.getElementById('ledYellow');
const ledGreen    = document.getElementById('ledGreen');
const ledBuzzer   = document.getElementById('ledBuzzer');
const histBody    = document.getElementById('histBody');

// ── Product thresholds (mirrors sketch.ino) ────────────────────────────────
const THRESHOLDS = {
  MILK:   { t_min: 2,  t_max: 6,  ph_min: 6.5, ph_max: 6.8 },
  CURD:   { t_min: 4,  t_max: 8,  ph_min: 4.0, ph_max: 4.6 },
  CHEESE: { t_min: 4,  t_max: 10, ph_min: 5.0, ph_max: 6.0 },
  BUTTER: { t_min: 5,  t_max: 10, ph_min: 5.8, ph_max: 6.5 },
};

let currentProduct = 'MILK';
let activeOverrides = new Set();    // sensors currently locked by user

// ══════════════════════════════════════════════════════════════════════════════
// Chart.js
// ══════════════════════════════════════════════════════════════════════════════
const ctx = document.getElementById('histChart').getContext('2d');
const chartData = {
  labels: [],
  datasets: [
    { label: 'Milk Temp (°C)', data: [], borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,.08)',  tension: .4, pointRadius: 0, borderWidth: 2 },
    { label: 'pH',             data: [], borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,.08)', tension: .4, pointRadius: 0, borderWidth: 2 },
    { label: 'Air Temp (°C)',  data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.08)', tension: .4, pointRadius: 0, borderWidth: 2 },
    { label: 'Humidity (%)',   data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.08)',  tension: .4, pointRadius: 0, borderWidth: 2 },
  ],
};

const histChart = new Chart(ctx, {
  type: 'line',
  data: chartData,
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11, family: 'Inter' } } },
      tooltip: { backgroundColor: '#1c2138', titleColor: '#e2e8f0', bodyColor: '#94a3b8', borderColor: 'rgba(255,255,255,.1)', borderWidth: 1, padding: 10 },
    },
    scales: {
      x: { ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,.04)' } },
      y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } },
    },
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════
const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d));
const timeLabel = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const clamp = (v, mn, mx) => Math.max(0, Math.min(100, ((v - mn) / (mx - mn)) * 100));

function classify(sensor, v, product) {
  const th = THRESHOLDS[product] || THRESHOLDS.MILK;
  switch (sensor) {
    case 'milk_temp':
      if (v < th.t_min || v > th.t_max)            return 'DANGER';
      if (v < th.t_min + 1 || v > th.t_max - 1)   return 'WARNING';
      return 'SAFE';
    case 'ph':
      if (v < th.ph_min || v > th.ph_max)          return 'DANGER';
      if (v < th.ph_min + .2 || v > th.ph_max - .2) return 'WARNING';
      return 'SAFE';
    case 'gas':
      return v > 2200 ? 'DANGER' : v > 1600 ? 'WARNING' : 'SAFE';
    case 'turbidity':
      return v < 1300 ? 'DANGER' : v < 2000 ? 'WARNING' : 'SAFE';
    case 'air_temp':
      return v > 35 ? 'WARNING' : 'SAFE';
    case 'humidity':
      return v > 80 ? 'WARNING' : 'SAFE';
    case 'weight':
      return (v < 100 || v > 2000) ? 'WARNING' : 'SAFE';
    default: return 'SAFE';
  }
}

function updateCard(cardId, valId, barId, displayVal, cls, barPct) {
  const el   = document.getElementById(valId);
  const bar  = document.getElementById(barId);
  const card = document.getElementById(cardId);
  if (el)   { el.textContent = displayVal; el.className = `card-value ${cls}`; }
  if (bar)  { bar.style.width = `${barPct}%`; bar.className = `card-bar ${cls}`; }
  if (card) { card.className = `sensor-card state-${cls}`; }
}

// ══════════════════════════════════════════════════════════════════════════════
// Slider controls
// ══════════════════════════════════════════════════════════════════════════════

// Called on every slider input event (updates the displayed value instantly)
function onSlider(sensor, rawVal) {
  const val = parseFloat(rawVal);
  const units = { milk_temp: '°C', ph: 'pH', gas: 'ADC', turbidity: 'ADC', air_temp: '°C', humidity: '%', weight: 'g' };
  const decs  = { milk_temp: 1,    ph: 2,    gas: 0,      turbidity: 0,      air_temp: 1,    humidity: 1,   weight: 0  };
  const sv = document.getElementById(`sv-${sensor}`);
  if (sv) sv.textContent = `${val.toFixed(decs[sensor])} ${units[sensor]}`;
  // Mark card as overridden
  const card = document.getElementById(`ctrl-${sensor}`);
  if (card) card.classList.add('overridden');
}

// Called on change (mouseup / touchend) — actually sends the override to backend
let sliderDebounce = {};
async function pushOverride(sensor, rawVal) {
  clearTimeout(sliderDebounce[sensor]);
  sliderDebounce[sensor] = setTimeout(async () => {
    const val = parseFloat(rawVal);
    activeOverrides.add(sensor);
    try {
      await fetch(`${API_BASE}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sensor, value: val }),
      });
    } catch (e) { console.warn('override failed', e); }
  }, 80);
}

async function releaseOverride(sensor) {
  activeOverrides.delete(sensor);
  const card = document.getElementById(`ctrl-${sensor}`);
  if (card) card.classList.remove('overridden');
  try {
    await fetch(`${API_BASE}/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sensor, value: null }),
    });
  } catch (e) { console.warn('release failed', e); }
}

async function resetAllOverrides() {
  activeOverrides.clear();
  document.querySelectorAll('.ctrl-card').forEach(c => c.classList.remove('overridden'));
  try {
    await fetch(`${API_BASE}/reset`, { method: 'POST' });
  } catch (e) { console.warn('reset failed', e); }
}

// Sync slider position to live value when sensor is NOT overridden
function syncSlider(sensor, liveVal) {
  if (activeOverrides.has(sensor)) return;   // user is controlling it
  const sl = document.getElementById(`sl-${sensor}`);
  if (sl) sl.value = liveVal;
  onSlider(sensor, liveVal);
}

// Update the "live" readout on each slider card
function setLiveLabel(sensor, val, unit, decimals) {
  const el = document.getElementById(`live-${sensor}`);
  if (el) el.textContent = `${Number(val).toFixed(decimals)} ${unit}`;
}

// Load base values from /api/config into the UI labels
async function loadConfig() {
  try {
    const res = await fetch(`${API_BASE}/config`);
    const cfg = await res.json();
    const base = cfg.base;
    if (base.milk_temp_base !== undefined) {
      document.getElementById('base-milk_temp').textContent = `Base: ${base.milk_temp_base} °C`;
      document.getElementById('sl-milk_temp').value = base.milk_temp_base;
      onSlider('milk_temp', base.milk_temp_base);
    }
    if (base.air_temp_base !== undefined) {
      document.getElementById('base-air_temp').textContent = `Base: ${base.air_temp_base} °C`;
      document.getElementById('sl-air_temp').value = base.air_temp_base;
      onSlider('air_temp', base.air_temp_base);
    }
    if (base.humidity_base !== undefined) {
      document.getElementById('base-humidity').textContent = `Base: ${base.humidity_base} %`;
      document.getElementById('sl-humidity').value = base.humidity_base;
      onSlider('humidity', base.humidity_base);
    }
    // Update product buttons
    if (cfg.product) {
      document.querySelectorAll('.prod-btn').forEach(b => b.classList.remove('active'));
      const btn = document.getElementById(`btn-${cfg.product}`);
      if (btn) btn.classList.add('active');
      currentProduct = cfg.product;
    }
  } catch (e) { /* backend not ready */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// Render a data payload
// ══════════════════════════════════════════════════════════════════════════════
function render(d) {
  currentProduct = d.product;

  // ── Status Hero ───────────────────────────────────────────────────────────
  statusHero.className   = `status-hero state-${d.status}`;
  statusBadge.textContent = (d.status === 'SAFE' ? '✅ ' : d.status === 'WARNING' ? '⚠️ ' : '🚨 ') + d.status;
  statusBadge.className  = `status-badge ${d.status}`;
  statusScores.textContent = `Danger Score: ${d.danger_score}  |  Warning Score: ${d.warning_score}  |  Product: ${d.product}`;

  // ── LEDs ──────────────────────────────────────────────────────────────────
  ledRed.className    = `led led-red    ${d.led_red    ? 'on-red'    : ''}`;
  ledYellow.className = `led led-yellow ${d.led_yellow ? 'on-yellow' : ''}`;
  ledGreen.className  = `led led-green  ${d.led_green  ? 'on-green'  : ''}`;
  ledBuzzer.className = `led led-buzzer ${d.buzzer     ? 'on-buzzer' : ''}`;

  // ── Threshold range labels ─────────────────────────────────────────────────
  const th = THRESHOLDS[d.product] || THRESHOLDS.MILK;
  document.getElementById('range-milkTemp').textContent = `Safe: ${th.t_min} – ${th.t_max} °C`;
  document.getElementById('range-ph').textContent       = `Safe: ${th.ph_min} – ${th.ph_max} pH`;

  // ── Sensor cards ──────────────────────────────────────────────────────────
  const mtCls = classify('milk_temp', d.milk_temp, d.product);
  updateCard('card-milk-temp', 'val-milkTemp', 'bar-milkTemp', fmt(d.milk_temp), mtCls, clamp(d.milk_temp, -10, 30));

  const phCls = classify('ph', d.ph, d.product);
  updateCard('card-ph', 'val-ph', 'bar-ph', fmt(d.ph, 2), phCls, clamp(d.ph, 0, 14));

  const gasCls = classify('gas', d.gas, d.product);
  updateCard('card-gas', 'val-gas', 'bar-gas', d.gas, gasCls, clamp(d.gas, 0, 4095));

  const turbCls = classify('turbidity', d.turbidity, d.product);
  updateCard('card-turbidity', 'val-turbidity', 'bar-turbidity', d.turbidity, turbCls, clamp(d.turbidity, 0, 4095));

  const atCls = classify('air_temp', d.air_temp, d.product);
  updateCard('card-air-temp', 'val-airTemp', 'bar-airTemp', fmt(d.air_temp), atCls, clamp(d.air_temp, 0, 50));

  const humCls = classify('humidity', d.humidity, d.product);
  updateCard('card-humidity', 'val-humidity', 'bar-humidity', fmt(d.humidity), humCls, clamp(d.humidity, 0, 100));

  const wCls = classify('weight', d.weight, d.product);
  updateCard('card-weight', 'val-weight', 'bar-weight', fmt(d.weight, 0), wCls, clamp(d.weight, 0, 2000));

  // ── Sync sliders in auto mode ─────────────────────────────────────────────
  syncSlider('milk_temp', d.milk_temp);
  syncSlider('air_temp',  d.air_temp);
  syncSlider('humidity',  d.humidity);
  syncSlider('ph',        d.ph);
  syncSlider('gas',       d.gas);
  syncSlider('turbidity', d.turbidity);
  syncSlider('weight',    d.weight);

  // Live labels
  setLiveLabel('milk_temp', d.milk_temp, '°C', 1);
  setLiveLabel('air_temp',  d.air_temp,  '°C', 1);
  setLiveLabel('humidity',  d.humidity,  '%',  1);
  setLiveLabel('ph',        d.ph,        'pH', 2);
  setLiveLabel('gas',       d.gas,       'ADC', 0);
  setLiveLabel('turbidity', d.turbidity, 'ADC', 0);
  setLiveLabel('weight',    d.weight,    'g',   0);

  // ── Chart ─────────────────────────────────────────────────────────────────
  const label = timeLabel(d.timestamp);
  if (chartData.labels.length >= 60) {
    chartData.labels.shift();
    chartData.datasets.forEach(ds => ds.data.shift());
  }
  chartData.labels.push(label);
  chartData.datasets[0].data.push(d.milk_temp);
  chartData.datasets[1].data.push(d.ph);
  chartData.datasets[2].data.push(d.air_temp);
  chartData.datasets[3].data.push(d.humidity);
  histChart.update('none');

  // ── Table row ─────────────────────────────────────────────────────────────
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${timeLabel(d.timestamp)}</td>
    <td>${d.product}</td>
    <td>${fmt(d.milk_temp)}</td>
    <td>${fmt(d.ph, 2)}</td>
    <td>${d.gas}</td>
    <td>${d.turbidity}</td>
    <td>${fmt(d.weight, 0)}</td>
    <td>${fmt(d.air_temp)}</td>
    <td>${fmt(d.humidity)}</td>
    <td><span class="pill ${d.status}">${d.status}</span></td>
  `;
  histBody.prepend(tr);
  while (histBody.children.length > 50) histBody.removeChild(histBody.lastChild);

  lastUpdated.textContent = `Last tick: ${timeLabel(d.timestamp)}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// WebSocket
// ══════════════════════════════════════════════════════════════════════════════
let ws = null;
let reconnectDelay = 1500;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    connDot.className    = 'conn-dot live';
    connLabel.textContent = 'Live';
    reconnectDelay = 1500;
  };

  ws.onmessage = ({ data }) => {
    try { render(JSON.parse(data)); } catch (e) { console.warn('Bad payload', e); }
  };

  ws.onclose = ws.onerror = () => {
    connDot.className    = 'conn-dot offline';
    connLabel.textContent = 'Reconnecting…';
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };
}

connect();
setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20000);

// ══════════════════════════════════════════════════════════════════════════════
// Product Selector
// ══════════════════════════════════════════════════════════════════════════════
async function selectProduct(name) {
  try { await fetch(`${API_BASE}/product/${name}`, { method: 'POST' }); } catch (e) {}
  document.querySelectorAll('.prod-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`btn-${name}`);
  if (btn) btn.classList.add('active');
  currentProduct = name;
}

// ══════════════════════════════════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════════════════════════════════
(async function init() {
  await loadConfig();
  try {
    const res  = await fetch(`${API_BASE}/history`);
    const hist = await res.json();
    if (Array.isArray(hist) && hist.length) hist.forEach(d => render(d));
  } catch (e) {}
})();
