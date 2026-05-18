/* ═══════════════════════════════════════════════════════════════════════════
   HERALD — herald.js
   Frontend logic: Leaflet map, town markers, detail panel, journey
   simulation, week slider, and view-mode toggle (Latest / Peak Risk).

   Map tile strategy
   ─────────────────
   We use a SINGLE tile source (OpenStreetMap) for both themes.
   • Light mode: OSM tiles rendered as-is → Kenya roads, lakes, borders
     are clearly visible.
   • Dark mode:  same OSM tiles with a CSS  invert + hue-rotate filter.
     Inverting a light map gives a dark background while keeping all
     geographic features readable. Far more reliable than CartoDB dark-
     matter tiles, which render Kenya as near-black.

   View-mode toggle
   ────────────────
   Two sidebar buttons let the user switch between:
   • Latest Week  — most recent week in the 2-year dataset
   • Peak Risk    — week where average composite score across all towns
                    is highest (most outbreak activity, best for demo)

   The active mode is stored in STATE.viewMode and sent as ?mode=latest
   or ?mode=peak on every API call. Dragging the slider switches to
   "custom" mode automatically and deactivates both named buttons.
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Global application state ───────────────────────────────────────────────
const STATE = {
  towns:         [],       // Array of town objects from /api/towns
  weeks:         [],       // All week date strings for the slider
  currentWeek:   null,     // YYYY-MM-DD string currently displayed
  latestWeek:    null,     // Most recent week in dataset
  peakWeek:      null,     // Highest-risk week in dataset
  viewMode:      'peak',   // 'latest' | 'peak' | 'custom'
  selectedTown:  null,     // Town name whose detail panel is open
  journeyActive: false,
  journeyStep:   0,
  journeyTimer:  null,
  markers:       {},       // Leaflet circleMarkers keyed by town name
  pulseRings:    {},       // Leaflet pulse rings for RED towns
  map:           null,     // Leaflet map instance
  tileLayer:     null,     // Single OSM tile layer (filter toggled by CSS)
  routeLine:     null,     // Leaflet polyline for corridor route
  darkMode:      false,
};

// Alert level → hex colour for markers and highlights
const COLORS = { GREEN: '#27AE60', AMBER: '#E8A21A', RED: '#C0392B' };

// ══════════════════════════════════════════════════════════════════════════
// INITIALISATION
// ══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  // Load dataset metadata first (latest/peak week dates), then town data
  loadMeta().then(() => loadTowns());
  setupSlider();
  document.getElementById('btn-start-journey').addEventListener('click', startJourney);
  document.getElementById('btn-reset-journey').addEventListener('click', resetJourney);
  initThemeToggle();
});

// ── Map initialisation ─────────────────────────────────────────────────────
function initMap() {
  STATE.map = L.map('map', {
    center:           [-1.8, 37.0],   // Centre on Kenya corridor
    zoom:             7,
    zoomControl:      true,
    attributionControl: false,
  });

  // Single OSM tile layer for both themes.
  // className='herald-tiles' is the CSS hook used to apply the dark-mode
  // invert filter without swapping the tile source.
  STATE.tileLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 18, minZoom: 5, className: 'herald-tiles' }
  ).addTo(STATE.map);

  L.control.attribution({ prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors')
    .addTo(STATE.map);

  // Default: light mode
  document.body.classList.add('light-mode');
  document.getElementById('theme-toggle').textContent = '🌙';
}

// ══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════════════════════

// Load dataset-level metadata: latest week, peak week, total week count.
// Called once on startup before town data is fetched.
async function loadMeta() {
  const res  = await fetch('/api/meta');
  const data = await res.json();

  STATE.latestWeek = data.latest_week;
  STATE.peakWeek   = data.peak_week;

  // Fetch all week strings for the slider index → date mapping
  const weeksRes = await fetch('/api/weeks');
  STATE.weeks     = await weeksRes.json();

  // Initialise slider bounds
  const slider = document.getElementById('week-slider');
  slider.max   = STATE.weeks.length - 1;

  // Snap slider to the peak-risk week (default view)
  const peakIdx = STATE.weeks.indexOf(data.peak_week);
  if (peakIdx >= 0) slider.value = peakIdx;
  updateWeekLabel(`Peak Risk — ${data.peak_week}`);
}

// Fetch town alert data for the current view mode/week and refresh the UI.
async function loadTowns() {
  const url  = buildTownsUrl();
  const res  = await fetch(url);
  STATE.towns = await res.json();

  // Sync currentWeek from the API response
  if (STATE.towns.length) STATE.currentWeek = STATE.towns[0].week;

  renderTownList();
  renderMapMarkers();
  updateHeader();
}

// Build /api/towns URL based on current view mode
function buildTownsUrl() {
  if (STATE.viewMode === 'peak')   return '/api/towns?mode=peak';
  if (STATE.viewMode === 'latest') return '/api/towns?mode=latest';
  return `/api/towns?week=${STATE.currentWeek}`;  // custom / slider
}

// Fetch full detail for one town (history, drugs, weather)
async function loadTownDetail(townName) {
  const res  = await fetch(`/api/town/${encodeURIComponent(townName)}`);
  const data = await res.json();
  renderDetailPanel(data);
}

// ══════════════════════════════════════════════════════════════════════════
// VIEW MODE TOGGLE  (Latest Week ↔ Peak Risk)
// ══════════════════════════════════════════════════════════════════════════

// Called by onclick on the two sidebar buttons.
// mode: 'latest' | 'peak'
function setViewMode(mode) {
  STATE.viewMode = mode;

  // Highlight the active button, deactivate the other
  document.getElementById('vmb-latest').classList.toggle('vmb-active', mode === 'latest');
  document.getElementById('vmb-peak').classList.toggle('vmb-active',   mode === 'peak');

  // Snap slider to the correct week
  const targetWeek = mode === 'peak' ? STATE.peakWeek : STATE.latestWeek;
  const idx = STATE.weeks.indexOf(targetWeek);
  if (idx >= 0) document.getElementById('week-slider').value = idx;
  updateWeekLabel(mode === 'peak'
    ? `Peak Risk — ${targetWeek}`
    : `Latest — ${targetWeek}`);

  // Reload map and (if open) detail panel for the new week
  loadTowns();
  if (STATE.selectedTown) loadTownDetail(STATE.selectedTown);
}

// ══════════════════════════════════════════════════════════════════════════
// HEADER SUMMARY PILLS
// ══════════════════════════════════════════════════════════════════════════

function updateHeader() {
  const green = STATE.towns.filter(t => t.alert_level === 'GREEN').length;
  const amber = STATE.towns.filter(t => t.alert_level === 'AMBER').length;
  const red   = STATE.towns.filter(t => t.alert_level === 'RED').length;

  document.getElementById('count-green').textContent = `${green} 🟢`;
  document.getElementById('count-amber').textContent = `${amber} 🟡`;
  document.getElementById('count-red').textContent   = `${red} 🔴`;

  const modeLabel = STATE.viewMode === 'peak'   ? '🔴 Peak Risk'
                  : STATE.viewMode === 'latest' ? '📅 Latest'
                  : '📆 Custom';
  document.getElementById('current-week').textContent =
    `${modeLabel} · ${STATE.currentWeek || ''}`;
}

// ══════════════════════════════════════════════════════════════════════════
// SIDEBAR TOWN LIST
// ══════════════════════════════════════════════════════════════════════════

function renderTownList() {
  const container = document.getElementById('town-list');
  container.innerHTML = '';

  [...STATE.towns]
    .sort((a, b) => a.order - b.order)
    .forEach(town => {
      const card = document.createElement('div');
      card.className = `town-card ${STATE.selectedTown === town.town ? 'active' : ''}`;
      card.innerHTML = `
        <div class="tc-dot ${town.alert_level}"></div>
        <div class="tc-info">
          <div class="tc-name">${town.town}</div>
          <div class="tc-county">${town.county} County</div>
        </div>
        <div class="tc-score ${town.alert_level}">${town.alert_level}</div>
      `;
      card.addEventListener('click', () => selectTown(town.town));
      container.appendChild(card);
    });
}

// ══════════════════════════════════════════════════════════════════════════
// MAP MARKERS
// ══════════════════════════════════════════════════════════════════════════

function renderMapMarkers() {
  // Remove all previous markers and route line
  Object.values(STATE.markers).forEach(m => STATE.map.removeLayer(m));
  Object.values(STATE.pulseRings).forEach(r => STATE.map.removeLayer(r));
  if (STATE.routeLine) STATE.map.removeLayer(STATE.routeLine);
  STATE.markers    = {};
  STATE.pulseRings = {};

  // Dashed polyline connecting towns in corridor order
  const latLons = [...STATE.towns]
    .sort((a, b) => a.order - b.order)
    .map(t => [t.lat, t.lon]);

  STATE.routeLine = L.polyline(latLons, {
    color:     '#1A6B3C',  // HERALD green — visible on both light and dark tiles
    weight:    4,
    opacity:   0.8,
    dashArray: '10 7',
  }).addTo(STATE.map);

  STATE.towns.forEach(town => {
    const level  = town.alert_level;
    const color  = COLORS[level];

    // Bubble size scales with composite score so higher-risk towns are bigger
    const radius = 10 + (town.score_composite * 22);

    // Animated ring behind RED markers for visual urgency
    if (level === 'RED') {
      STATE.pulseRings[town.town] = L.circleMarker([town.lat, town.lon], {
        radius: radius + 9, color, weight: 2,
        opacity: 0.4, fill: false, className: 'pulse-ring',
      }).addTo(STATE.map);
    }

    // Main filled bubble
    const marker = L.circleMarker([town.lat, town.lon], {
      radius,
      color:       '#FFFFFF',  // white border for contrast on both tile themes
      weight:      2.5,
      fillColor:   color,
      fillOpacity: 0.85,
      className:   `herald-circle ${level}`,
    }).addTo(STATE.map);

    marker.bindPopup(buildPopupHTML(town), { maxWidth: 240 });
    marker.on('click', () => selectTown(town.town));

    // Always-visible town name label
    marker.bindTooltip(town.town, {
      permanent: true, direction: 'top',
      offset: [0, -(radius + 4)], className: 'map-label',
    }).addTo(STATE.map);

    STATE.markers[town.town] = marker;
  });
}

function buildPopupHTML(town) {
  return `
    <div class="popup-inner">
      <div class="popup-town">${town.climate_icon} ${town.town}</div>
      <div class="popup-county">${town.county} County · ${town.climate}</div>
      <div class="popup-alert ${town.alert_level}">${town.advice.emoji} ${town.advice.label}</div>
      <div class="popup-scores">
        <div class="ps-item">🦟 <span class="ps-val">${town.score_malaria.toFixed(2)}</span></div>
        <div class="ps-item">🤢 <span class="ps-val">${town.score_gi.toFixed(2)}</span></div>
        <div class="ps-item">🤧 <span class="ps-val">${town.score_respiratory.toFixed(2)}</span></div>
      </div>
      <button class="popup-btn" onclick="selectTown('${town.town}')">View Full Detail →</button>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
// TOWN SELECTION & DETAIL PANEL
// ══════════════════════════════════════════════════════════════════════════

function selectTown(townName) {
  STATE.selectedTown = townName;
  renderTownList();
  const town = STATE.towns.find(t => t.town === townName);
  if (town) {
    STATE.map.flyTo([town.lat, town.lon], 9, { duration: 1.2 });
    STATE.markers[townName]?.openPopup();
  }
  loadTownDetail(townName);
}

function renderDetailPanel(data) {
  document.getElementById('dp-placeholder').style.display = 'none';
  const content = document.getElementById('dp-content');
  content.style.display = 'flex';

  const c      = data.current || {};
  const level  = c.alert_level || 'GREEN';
  const advice = data.advice   || {};

  // Score bar: maps 0–1.5 range to 0–100% width (1.5 = strong outbreak signal)
  const scoreBar = (val, cls) => {
    const pct = Math.min((val / 1.5) * 100, 100);
    return `<div class="score-bar-wrap">
              <div class="score-bar ${cls}" style="width:${pct}%"></div>
            </div>`;
  };

  // ── 12-week sparkline explanation ─────────────────────────────────────
  // WHAT IS PLOTTED: score_composite for each of the last 12 weeks.
  // BAR HEIGHT = week's score / max score in the window × 100%
  //   → the chart always fills vertically, making trends easy to read
  //   → hover a bar to see the exact week and score value
  // BAR COLOUR = alert level that week (GREEN / AMBER / RED)
  //   → lets you instantly see when the town was under an alert vs safe
  // X-AXIS: left = oldest of the 12 weeks, right = most recent
  const history   = data.history || [];
  const maxScore  = Math.max(...history.map(h => h.score_composite), 0.01);
  const sparkBars = history.map(h => {
    const pct = Math.round((h.score_composite / maxScore) * 100);
    return `<div class="mc-bar ${h.alert_level}"
                 style="height:${Math.max(pct, 4)}%"
                 title="${h.week}: score=${h.score_composite.toFixed(3)}">
            </div>`;
  }).join('');

  // Top 5 drugs by units sold this week
  const drugs    = data.drugs_latest || {};
  const drugRows = Object.entries(drugs)
    .sort((a, b) => b[1].units_sold - a[1].units_sold)
    .slice(0, 5)
    .map(([name, d]) => `
      <div class="drug-row">
        <div>
          <div class="dr-name">${name}</div>
          <div class="dr-signal">${d.signal} · weight=${d.weight}</div>
        </div>
        <div class="dr-units">${d.units_sold.toLocaleString()}</div>
      </div>`).join('');

  content.innerHTML = `
    <div class="dp-town-header">
      <div class="dp-town-name">${data.climate_icon || ''} ${data.town}</div>
      <div class="dp-town-county">${data.county} County</div>
      <div class="dp-climate">${data.climate || ''} · ${data.elevation_m || '—'}m asl</div>
    </div>

    <div class="dp-alert-badge ${level}">${advice.emoji || ''} ${advice.label || level}</div>

    <div>
      <div class="dp-section-title" style="margin-bottom:8px">Disease Signal Scores</div>
      <div class="score-bars">
        <div class="score-row">
          <div class="score-meta">
            <span class="score-label">🦟 Malaria</span>
            <span class="score-val">${(c.score_malaria||0).toFixed(3)}</span>
          </div>${scoreBar(c.score_malaria||0, 'malaria')}
        </div>
        <div class="score-row">
          <div class="score-meta">
            <span class="score-label">🤢 GI / Diarrhoeal</span>
            <span class="score-val">${(c.score_gi||0).toFixed(3)}</span>
          </div>${scoreBar(c.score_gi||0, 'gi')}
        </div>
        <div class="score-row">
          <div class="score-meta">
            <span class="score-label">🤧 Respiratory</span>
            <span class="score-val">${(c.score_respiratory||0).toFixed(3)}</span>
          </div>${scoreBar(c.score_respiratory||0, 'respiratory')}
        </div>
        <div class="score-row">
          <div class="score-meta">
            <span class="score-label">⚡ Composite</span>
            <span class="score-val">${(c.score_composite||0).toFixed(3)}</span>
          </div>${scoreBar(c.score_composite||0, 'composite')}
        </div>
      </div>
    </div>

    <!-- Weekly climate averages are SYNTHETIC (from NumPy generator),
         not from a live weather API. In production, replace with
         OpenWeatherMap or similar. -->
    <div>
      <div class="dp-section-title" style="margin-bottom:8px">
        Weekly Climate
        <span style="font-size:9px;color:#6B9080;margin-left:4px">(synthetic)</span>
      </div>
      <div class="weather-grid">
        <div class="weather-card">
          <div class="wc-val">${(c.temp_c||0).toFixed(0)}°C</div>
          <div class="wc-label">Temp</div>
        </div>
        <div class="weather-card">
          <div class="wc-val">${(c.rainfall_mm||0).toFixed(0)}mm</div>
          <div class="wc-label">Rainfall</div>
        </div>
        <div class="weather-card">
          <div class="wc-val">${(c.humidity_pct||0).toFixed(0)}%</div>
          <div class="wc-label">Humidity</div>
        </div>
      </div>
    </div>

    <div>
      <div class="dp-section-title" style="margin-bottom:6px">
        12-Week Score Trend
        <span style="font-size:9px;color:#6B9080;margin-left:4px">
          composite · colour = alert level
        </span>
      </div>
      <div class="mini-chart">
        <div class="mc-bar-wrap">${sparkBars}</div>
        <div class="mc-labels">
          <span class="mc-label">${history[0]?.week?.slice(5) || ''}</span>
          <span class="mc-label">${history[history.length-1]?.week?.slice(5) || 'Now'}</span>
        </div>
      </div>
    </div>

    <div>
      <div class="dp-section-title" style="margin-bottom:8px">Top Drugs This Week</div>
      <div class="drug-list">${drugRows || '<div class="dr-signal">No data</div>'}</div>
    </div>

    <div>
      <div class="dp-section-title" style="margin-bottom:8px">Traveller Advice</div>
      <div class="advice-box">
        <div class="advice-summary">${advice.summary || ''}</div>
        <div class="advice-actions">
          ${(advice.actions||[]).map(a=>`<div class="advice-action">${a}</div>`).join('')}
        </div>
      </div>
    </div>

    ${data.travel_tip
      ? `<div class="advice-box">
           <div class="advice-summary">💡 <strong>Local Tip:</strong> ${data.travel_tip}</div>
         </div>`
      : ''}
  `;
}

// ══════════════════════════════════════════════════════════════════════════
// WEEK SLIDER
// ══════════════════════════════════════════════════════════════════════════

function setupSlider() {
  const slider = document.getElementById('week-slider');
  let debounce;

  slider.addEventListener('input', () => {
    const week = STATE.weeks[parseInt(slider.value)];
    updateWeekLabel(`Custom — ${week}`);

    // Dragging the slider enters "custom" mode — deactivate named buttons
    STATE.viewMode = 'custom';
    document.getElementById('vmb-latest').classList.remove('vmb-active');
    document.getElementById('vmb-peak').classList.remove('vmb-active');

    // Debounce: wait for slider to stop moving before hitting the API
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      STATE.currentWeek = week;
      loadTowns();
      if (STATE.selectedTown) loadTownDetail(STATE.selectedTown);
    }, 300);
  });
}

function updateWeekLabel(text) {
  document.getElementById('week-slider-label').textContent = text;
}

// ══════════════════════════════════════════════════════════════════════════
// JOURNEY SIMULATION
// ══════════════════════════════════════════════════════════════════════════

async function startJourney() {
  if (STATE.journeyActive) return;
  STATE.journeyActive = true;
  STATE.journeyStep   = 0;

  document.getElementById('btn-start-journey').style.display = 'none';
  document.getElementById('btn-reset-journey').style.display = 'block';
  document.getElementById('journey-progress').style.display  = 'flex';

  // Journey uses the same week/mode as the current map view
  const url = STATE.viewMode === 'peak'   ? '/api/journey?mode=peak'
            : STATE.viewMode === 'latest' ? '/api/journey?mode=latest'
            : `/api/journey?week=${STATE.currentWeek}`;

  const res   = await fetch(url);
  const stops = await res.json();

  // Zoom out to show full corridor before stepping through
  STATE.map.fitBounds(stops.map(s => [s.lat, s.lon]), { padding: [60, 60] });
  await sleep(1200);
  runJourneyStep(stops, 0);
}

function runJourneyStep(stops, idx) {
  if (idx >= stops.length) {
    setJourneyProgress(100, '✅ Journey complete! Mombasa reached.');
    STATE.journeyActive = false;
    return;
  }

  const stop = stops[idx];
  const pct  = Math.round((idx / (stops.length - 1)) * 100);
  setJourneyProgress(pct, `📍 Entering ${stop.town} (${stop.county} County)…`);

  STATE.map.flyTo([stop.lat, stop.lon], 9, { duration: 1.0 });

  // Flash marker white to signal arrival, then restore colour
  const marker = STATE.markers[stop.town];
  if (marker) {
    marker.setStyle({ fillColor: '#FFFFFF', fillOpacity: 1 });
    setTimeout(() => marker.setStyle({ fillColor: COLORS[stop.alert_level], fillOpacity: 0.85 }), 400);
  }

  STATE.journeyStep = idx;

  // Always show modal on first/last town and for any non-GREEN alert
  if (stop.alert_level !== 'GREEN' || idx === 0 || idx === stops.length - 1) {
    setTimeout(() => showJourneyAlert(stop), 800);
    // Auto-advance after 6s if user doesn't dismiss manually
    STATE.journeyTimer = setTimeout(() => {
      closeAlert();
      runJourneyStep(stops, idx + 1);
    }, 6000);
  } else {
    // GREEN town — brief pause then continue automatically
    STATE.journeyTimer = setTimeout(() => runJourneyStep(stops, idx + 1), 1800);
  }
}

function showJourneyAlert(stop) {
  const level  = stop.alert_level;
  const advice = stop.advice;

  document.getElementById('am-header').className      = `am-header ${level}`;
  document.getElementById('am-level').className       = `am-level ${level}`;
  document.getElementById('am-level').textContent     = `${advice.emoji} ${advice.label.toUpperCase()}`;
  document.getElementById('am-town').textContent      = `Entering ${stop.town} — ${stop.county} County`;
  document.getElementById('am-summary').textContent   = advice.summary;

  const sc = v => v < 0.15 ? 'low' : v < 0.4 ? 'medium' : 'high';
  document.getElementById('am-scores').innerHTML = `
    <div class="ams-card"><div class="ams-icon">🦟</div>
      <div class="ams-label">Malaria</div>
      <div class="ams-val ${sc(stop.score_malaria)}">${stop.score_malaria.toFixed(2)}</div></div>
    <div class="ams-card"><div class="ams-icon">🤢</div>
      <div class="ams-label">GI</div>
      <div class="ams-val ${sc(stop.score_gi)}">${stop.score_gi.toFixed(2)}</div></div>
    <div class="ams-card"><div class="ams-icon">🤧</div>
      <div class="ams-label">Respiratory</div>
      <div class="ams-val ${sc(stop.score_respiratory)}">${stop.score_respiratory.toFixed(2)}</div></div>`;

  document.getElementById('am-actions').innerHTML =
    (advice.actions||[]).map(a => `<div class="ama-item">${a}</div>`).join('');

  const tip = document.getElementById('am-tip');
  tip.style.display = stop.travel_tip ? 'block' : 'none';
  if (stop.travel_tip) tip.textContent = `💡 ${stop.travel_tip}`;

  document.getElementById('alert-overlay').style.display = 'flex';
}

function closeAlert() {
  document.getElementById('alert-overlay').style.display = 'none';

  if (STATE.journeyActive && STATE.journeyTimer) {
    clearTimeout(STATE.journeyTimer);
    STATE.journeyTimer = null;
    const url = STATE.viewMode === 'peak'   ? '/api/journey?mode=peak'
              : STATE.viewMode === 'latest' ? '/api/journey?mode=latest'
              : `/api/journey?week=${STATE.currentWeek}`;
    fetch(url).then(r => r.json())
              .then(stops => runJourneyStep(stops, STATE.journeyStep + 1));
  }
}

function resetJourney() {
  if (STATE.journeyTimer) clearTimeout(STATE.journeyTimer);
  STATE.journeyActive = false;
  STATE.journeyStep   = 0;
  document.getElementById('btn-start-journey').style.display = 'block';
  document.getElementById('btn-reset-journey').style.display = 'none';
  document.getElementById('journey-progress').style.display  = 'none';
  document.getElementById('alert-overlay').style.display     = 'none';
  const bounds = STATE.towns.map(t => [t.lat, t.lon]);
  if (bounds.length) STATE.map.fitBounds(bounds, { padding: [60, 60] });
}

function setJourneyProgress(pct, label) {
  document.getElementById('jp-bar').style.width   = `${pct}%`;
  document.getElementById('jp-label').textContent = label;
}

// ══════════════════════════════════════════════════════════════════════════
// THEME TOGGLE  (Light ↔ Dark)
// ══════════════════════════════════════════════════════════════════════════

function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  btn.addEventListener('click', () => {
    STATE.darkMode = !STATE.darkMode;

    if (STATE.darkMode) {
      // ── Switching to dark mode ─────────────────────────────────────
      // We keep the same OSM tile layer but apply a CSS filter to the
      // .herald-tiles elements (the actual <img> tiles):
      //
      //   invert(100%)        — flips white→black, black→white.
      //                         The light map background becomes dark.
      //   hue-rotate(180deg)  — corrects the hue shift introduced by
      //                         invert so natural colours are restored:
      //                         green stays green, blue stays blue,
      //                         water still looks like water.
      //   brightness(0.85)    — dims slightly so the result isn't harsh.
      //   saturate(0.7)       — reduces saturation for a muted dark look.
      //
      // Result: dark map that clearly shows Kenya's roads, lakes, county
      // boundaries and town features — unlike CartoDB dark-matter tiles
      // which make geographic features nearly invisible on Kenya's terrain.
      document.body.classList.remove('light-mode');
      document.body.classList.add('dark-mode');
      btn.textContent = '☀️';
    } else {
      // ── Switching to light mode ────────────────────────────────────
      // Remove dark-mode class — the CSS filter is no longer applied
      // and OSM tiles render normally showing Kenya clearly.
      document.body.classList.remove('dark-mode');
      document.body.classList.add('light-mode');
      btn.textContent = '🌙';
    }

    // Re-render markers so popup/label colours update for new theme
    renderMapMarkers();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
