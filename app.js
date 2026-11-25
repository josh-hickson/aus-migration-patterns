// Where young Australians move: SA2 migration map.
//
// Reads the files stage 04 writes to data/ and draws them. Every
// number shown comes from the release tables; the page computes
// only map shading breaks and the approximate 95% interval on rates.
'use strict';

// -- settings ----
const GROUPS = [
  { id: 'all', label: 'All', name: 'All children', split: 'all' },
  { id: 'q1', label: 'Q1', name: 'Parental income, bottom quartile', split: 'income' },
  { id: 'q2', label: 'Q2', name: 'Parental income, second quartile', split: 'income' },
  { id: 'q3', label: 'Q3', name: 'Parental income, third quartile', split: 'income' },
  { id: 'q4', label: 'Q4', name: 'Parental income, top quartile', split: 'income' },
  { id: 'female', label: 'Women', name: 'Women', split: 'sex' },
  { id: 'male', label: 'Men', name: 'Men', split: 'sex' },
];
const GROUP_BY_ID = Object.fromEntries(GROUPS.map((group) => [group.id, group]));

// Position of each statistic in a summary.json row.
const SUMMARY_POSITION = { n: 0, rate: 1, mean: 2, median: 3 };

const MEASURES = {
  from: [
    { id: 'rate', kind: 'share', label: 'Share still in their SA2', legend: 'Still in their SA2 at {dest}' },
    { id: 'median', kind: 'km', label: 'Median distance moved (movers)', legend: 'Median km moved, movers' },
    { id: 'mean', kind: 'km', label: 'Mean distance moved (everyone)', legend: 'Mean km moved, everyone' },
  ],
  to: [
    { id: 'rate', kind: 'share', label: 'Share who grew up elsewhere', legend: 'Grew up in another SA2' },
    { id: 'median', kind: 'km', label: 'Median distance moved (movers)', legend: 'Median km moved, movers' },
    { id: 'mean', kind: 'km', label: 'Mean distance moved (everyone)', legend: 'Mean km moved, everyone' },
  ],
};

// Sequential blues for the map (ColorBrewer Blues, 7 classes); a
// separate orange ramp marks the linked SA2s, rank 1 darkest.
// Blue against orange stays distinct under the common colour-vision
// deficiencies.
const PALETTE = ['#eff3ff', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#084594'];
const NO_DATA_COLOUR = '#d9dce1';
const LINK_COLOURS = ['#9a3412', '#c2410c', '#ea580c', '#f97316', '#fb923c'];
const SELECTED_COLOUR = '#1b2230';

// SA2s offered as starting points, if they exist in the lookup.
const EXAMPLE_NAMES = ['Mount Isa', 'Broken Hill', 'Dubbo', 'Alice Springs', 'Burnie - Wivenhoe', 'Mildura'];

const AUSTRALIA_BOUNDS = [[-43.8, 112.9], [-10.5, 153.8]];

// Capital-city labels for orientation. The site has no basemap: tile
// services now want an API key or forbid heavy use, and the SA2
// polygons cover all of Australia anyway.
const CITY_LABELS = [
  ['Sydney', -33.87, 151.21], ['Melbourne', -37.81, 144.96], ['Brisbane', -27.47, 153.03],
  ['Perth', -31.95, 115.86], ['Adelaide', -34.93, 138.60], ['Hobart', -42.88, 147.33],
  ['Darwin', -12.46, 130.84], ['Canberra', -35.28, 149.13],
];

// -- state ----
const state = { dir: 'from', group: 'all', measure: 'rate', sa2: null };
let meta, lookupByCode, summary, map, sa2Layer, linkOverlay, legendControl;
const layerByCode = new Map();
const linkCache = new Map();
let currentLinks = [];
let linkRankByCode = new Map();
let breaks = { thresholds: [], min: undefined, max: undefined };

// -- formatting ----
const numberFormat = new Intl.NumberFormat('en-AU');
const formatShare = (value) => `${(value * 100).toFixed(1)}%`;
const formatKm = (value) => (value < 10 ? `${value.toFixed(1)} km` : `${numberFormat.format(Math.round(value))} km`);
const formatValue = (kind, value) => (kind === 'share' ? formatShare(value) : formatKm(value));
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function measureFor(direction = state.dir, measureId = state.measure) {
  return MEASURES[direction].find((m) => m.id === measureId);
}

function fill(template) {
  return template.replace('{dest}', meta.destination_age).replace('{origin}', meta.origin_age);
}

// -- data access ----
function summaryRow(code, direction = state.dir, group = state.group) {
  return summary[direction]?.[group]?.[code] ?? null;
}

function statistic(code, measureId = state.measure, direction = state.dir, group = state.group) {
  const row = summaryRow(code, direction, group);
  return row ? row[SUMMARY_POSITION[measureId]] : null;
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function linksFor(direction, group) {
  const key = `${direction}-${group}`;
  if (!linkCache.has(key)) linkCache.set(key, fetchJson(`data/links-${key}.json`));
  return linkCache.get(key);
}

// -- map shading ----
// Quantile breaks over every SA2 with a published value, so each of
// the seven colours covers about a seventh of SA2s.
function computeBreaks() {
  const values = [];
  for (const code of lookupByCode.keys()) {
    const value = statistic(code);
    if (value !== null && value !== undefined) values.push(value);
  }
  values.sort((a, b) => a - b);
  const thresholds = [];
  for (let k = 1; k < PALETTE.length; k += 1) {
    thresholds.push(values[Math.min(values.length - 1, Math.floor((k * values.length) / PALETTE.length))]);
  }
  breaks = { thresholds, min: values[0], max: values[values.length - 1] };
}

function colourFor(value) {
  if (value === null || value === undefined) return NO_DATA_COLOUR;
  let index = 0;
  while (index < breaks.thresholds.length && value >= breaks.thresholds[index]) index += 1;
  return PALETTE[index];
}

function styleFor(code) {
  const style = { fillColor: colourFor(statistic(code)), fillOpacity: 0.82, color: '#ffffff', weight: 0.35, opacity: 0.9 };
  if (!state.sa2) return style;
  style.fillOpacity = 0.32;
  const rank = linkRankByCode.get(code);
  if (rank) Object.assign(style, { fillColor: LINK_COLOURS[rank - 1], fillOpacity: 0.92, color: '#7c2d12', weight: 1 });
  if (code === state.sa2) Object.assign(style, { fillColor: SELECTED_COLOUR, fillOpacity: 0.6, color: SELECTED_COLOUR, weight: 2.5 });
  return style;
}

function restyleMap() {
  sa2Layer.eachLayer((layer) => layer.setStyle(styleFor(layer.feature.properties.sa2_code)));
  // Linked and selected SA2s drawn last, so their outlines are not
  // painted over by neighbours.
  linkRankByCode.forEach((_, code) => layerByCode.get(code)?.bringToFront());
  if (state.sa2) layerByCode.get(state.sa2)?.bringToFront();
}

function tooltipFor(layer) {
  const code = layer.feature.properties.sa2_code;
  const place = lookupByCode.get(code);
  const measure = measureFor();
  const row = summaryRow(code);
  const value = statistic(code);
  let valueLine;
  if (!row) valueLine = '<span class="muted">No children in the data</span>';
  else if (value === null) valueLine = `<span class="muted">Suppressed: fewer than ${meta.min_base_count} children</span>`;
  else valueLine = `${escapeHtml(measure.label)}: <strong>${formatValue(measure.kind, value)}</strong>`;
  const rank = linkRankByCode.get(code);
  let linkLine = '';
  if (rank) {
    const link = currentLinks[rank - 1];
    const what = state.dir === 'from' ? 'destination' : 'origin';
    linkLine = `<br>#${rank} ${what}: <strong>${formatShare(link[2])}</strong> of ${state.dir === 'from' ? 'children from' : '26-year-olds in'} ${escapeHtml(lookupByCode.get(state.sa2).name)}`;
  }
  return `<strong>${escapeHtml(place.name)}</strong><br><span class="muted">${escapeHtml(place.state)}</span><br>${valueLine}${linkLine}`;
}

// -- legend ----
function renderLegend() {
  const measure = measureFor();
  const rows = PALETTE.map((colour, index) => {
    const low = index === 0 ? breaks.min : breaks.thresholds[index - 1];
    const high = index === PALETTE.length - 1 ? breaks.max : breaks.thresholds[index];
    if (low === undefined || high === undefined) return '';
    return `<div class="legend-row"><span class="swatch" style="background:${colour}"></span>${formatValue(measure.kind, low)} – ${formatValue(measure.kind, high)}</div>`;
  }).join('');
  let linkRows = '';
  if (state.sa2 && currentLinks.length) {
    const what = state.dir === 'from' ? 'destinations' : 'origins';
    linkRows = `<div class="legend-sep"></div><div class="legend-row"><span class="swatch" style="background:${SELECTED_COLOUR}"></span>Selected SA2</div>`
      + `<div class="legend-row"><span class="swatch" style="background:${LINK_COLOURS[0]}"></span>Top ${what}, 1 to ${currentLinks.length}</div>`;
  }
  legendControl.getContainer().innerHTML = `<div class="legend-title">${escapeHtml(fill(measure.legend))}<br><span class="muted">${escapeHtml(GROUP_BY_ID[state.group].name)}</span></div>${rows}`
    + `<div class="legend-row"><span class="swatch" style="background:${NO_DATA_COLOUR}"></span>Suppressed or none</div>${linkRows}`;
}

// -- links on the map ----
// A gentle arc from origin to destination: a quadratic Bezier whose
// control point sits off the midpoint, perpendicular to the chord.
function arcPoints(fromLatLng, toLatLng) {
  const [lat1, lon1] = fromLatLng;
  const [lat2, lon2] = toLatLng;
  const midLat = (lat1 + lat2) / 2;
  const midLon = (lon1 + lon2) / 2;
  const controlLat = midLat + (lon2 - lon1) * 0.18;
  const controlLon = midLon - (lat2 - lat1) * 0.18;
  const points = [];
  for (let step = 0; step <= 32; step += 1) {
    const t = step / 32;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    points.push([a * lat1 + b * controlLat + c * lat2, a * lon1 + b * controlLon + c * lon2]);
  }
  return points;
}

function drawLinks() {
  linkOverlay.clearLayers();
  if (!state.sa2) return;
  const here = lookupByCode.get(state.sa2);
  currentLinks.forEach((link, index) => {
    const other = lookupByCode.get(link[0]);
    const hereLatLng = [here.lat, here.lon];
    const otherLatLng = [other.lat, other.lon];
    const points = state.dir === 'from' ? arcPoints(hereLatLng, otherLatLng) : arcPoints(otherLatLng, hereLatLng);
    L.polyline(points, { color: '#7c2d12', weight: 1.5 + 10 * Math.min(link[2], 0.3), opacity: 0.75, interactive: false }).addTo(linkOverlay);
    L.marker(otherLatLng, {
      icon: L.divIcon({ className: 'rank-marker', html: `<span>${index + 1}</span>`, iconSize: [22, 22] }),
      keyboard: false, interactive: false,
    }).addTo(linkOverlay);
  });
}

// Move the view only when the selection or its links are off screen.
function fitSelection() {
  const here = lookupByCode.get(state.sa2);
  const latLngs = [[here.lat, here.lon], ...currentLinks.map((link) => {
    const other = lookupByCode.get(link[0]);
    return [other.lat, other.lon];
  })];
  const bounds = L.latLngBounds(latLngs).extend(layerByCode.get(state.sa2).getBounds());
  if (!map.getBounds().contains(bounds)) map.flyToBounds(bounds.pad(0.25), { maxZoom: 11, duration: 0.6 });
}

// -- panel ----
function approximateInterval(rate, n) {
  if (rate === null || !n) return null;
  return 1.96 * Math.sqrt((rate * (1 - rate)) / n);
}

function statBlock(label, value, note, primary = false) {
  return `<div class="stat${primary ? ' primary' : ''}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;
}

function renderIntro() {
  const examples = EXAMPLE_NAMES
    .map((name) => [...lookupByCode.values()].find((place) => place.name === name))
    .filter(Boolean)
    .map((place) => `<button type="button" data-select="${place.code}">${escapeHtml(place.name)}</button>`).join('');
  const sentence = state.dir === 'from'
    ? `Click an SA2, or search for one, to see where its children were living at ${meta.destination_age}.`
    : `Click an SA2, or search for one, to see where its ${meta.destination_age}-year-olds grew up.`;
  return `<h2>Choose a place</h2><p class="small">${sentence}</p>${examples ? `<div class="examples">${examples}</div>` : ''}`;
}

function renderGroupBars() {
  const measure = measureFor(state.dir, 'rate');
  const rows = GROUPS.map((group, index) => {
    const value = statistic(state.sa2, 'rate', state.dir, group.id);
    const gap = index > 0 && GROUPS[index - 1].split !== group.split ? '<div class="bar-gap"></div>' : '';
    return { group, value, gap };
  });
  const top = Math.max(0.05, ...rows.map((row) => row.value ?? 0));
  const html = rows.map(({ group, value, gap }) => {
    const width = value === null ? 0 : (100 * value) / top;
    const label = value === null ? '<span class="muted">–</span>' : formatShare(value);
    return `${gap}<button type="button" class="bar-row${group.id === state.group ? ' current' : ''}" data-group-pick="${group.id}" title="${escapeHtml(group.name)}">`
      + `<span>${group.label}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${width}%"></span></span><span class="bar-value">${label}</span></button>`;
  }).join('');
  return `<h3>${escapeHtml(measure.label)}, by group</h3><div class="bars">${html}</div>`;
}

function renderSelection() {
  const place = lookupByCode.get(state.sa2);
  const row = summaryRow(state.sa2);
  const group = GROUP_BY_ID[state.group];
  const header = `<div class="place-head"><div><h2>${escapeHtml(place.name)}</h2><p class="muted">${escapeHtml(place.sa3)} · ${escapeHtml(place.state)}</p></div>`
    + '<button type="button" class="clear" data-clear aria-label="Clear selection">×</button></div>';
  const context = state.dir === 'from'
    ? `Children who lived here at ${meta.origin_age}, and where they lived at ${meta.destination_age}. <strong>${escapeHtml(group.name)}</strong>.`
    : `People living here at ${meta.destination_age}, and where they lived at ${meta.origin_age}. <strong>${escapeHtml(group.name)}</strong>.`;

  if (!row) {
    return `${header}<p class="context-line">${context}</p><p class="small muted">No children in the data for this SA2 and group.</p>`;
  }

  const [n, rate, meanKm, medianKm] = row;
  const rateLabel = state.dir === 'from' ? `Still living in this SA2 at ${meta.destination_age}` : `Grew up in another SA2`;
  const interval = approximateInterval(rate, n);
  const stats = '<div class="stats">'
    + statBlock(rateLabel, rate === null ? '–' : formatShare(rate),
      rate === null ? `Suppressed: fewer than ${meta.min_base_count} children` : `± ${(interval * 100).toFixed(1)} pp, approx. 95% interval`, true)
    + statBlock('Median distance moved', medianKm === null ? '–' : formatKm(medianKm), 'movers only')
    + statBlock('Mean distance moved', meanKm === null ? '–' : formatKm(meanKm), 'everyone, stayers at 0 km')
    + '</div>';

  const listTitle = state.dir === 'from' ? `Top destinations at ${meta.destination_age}` : `Top places they grew up`;
  const shareOf = state.dir === 'from' ? 'of children from here' : `of ${meta.destination_age}-year-olds here`;
  let list;
  if (currentLinks.length) {
    list = '<ol class="links">' + currentLinks.map((link, index) => {
      const other = lookupByCode.get(link[0]);
      return `<li><button type="button" data-select="${other.code}" title="Select ${escapeHtml(other.name)}">`
        + `<span class="rank" style="background:${LINK_COLOURS[index]}">${index + 1}</span>`
        + `<span class="link-name">${escapeHtml(other.name)}<small>${escapeHtml(other.sa3)} · ${escapeHtml(other.state)}</small></span>`
        + `<span class="link-share">${formatShare(link[2])}</span><span class="link-km">${formatKm(link[3])}</span></button></li>`;
    }).join('') + '</ol>'
      + `<p class="small muted">Shares are ${shareOf}.${currentLinks.length < meta.top_n_links ? ` Places with fewer than ${meta.min_link_count} children are not shown, so the list stops at ${currentLinks.length}.` : ''}</p>`;
  } else {
    list = `<p class="small muted">No single place had ${meta.min_link_count} or more children, so none is shown.</p>`;
  }

  const flipText = state.dir === 'from'
    ? `Where did ${meta.destination_age}-year-olds in ${escapeHtml(place.name)} grow up? →`
    : `Where did children from ${escapeHtml(place.name)} go? →`;

  return `${header}<p class="context-line">${context}</p>${stats}<h3>${listTitle}</h3>${list}`
    + `<button type="button" class="flip" data-flip>${flipText}</button>${renderGroupBars()}`;
}

function renderDetails() {
  document.getElementById('details').innerHTML = state.sa2 ? renderSelection() : renderIntro();
}

function renderControls() {
  document.querySelectorAll('[data-dir]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.dir === state.dir)));
  document.querySelectorAll('[data-group]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.group === state.group)));
  const select = document.getElementById('measure-control');
  select.innerHTML = MEASURES[state.dir].map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
  select.value = state.measure;
}

// -- state changes ----
function writeHash() {
  const parts = [state.dir, state.group, state.measure];
  if (state.sa2) parts.push(state.sa2);
  history.replaceState(null, '', `#${parts.join('/')}`);
}

function readHash() {
  const [dir, group, measure, sa2] = location.hash.replace(/^#/, '').split('/');
  if (dir in MEASURES) state.dir = dir;
  if (group in GROUP_BY_ID) state.group = group;
  if (MEASURES[state.dir].some((m) => m.id === measure)) state.measure = measure;
  state.sa2 = sa2 && lookupByCode.has(sa2) ? sa2 : null;
}

async function update({ fit = false } = {}) {
  if (state.sa2) {
    const links = await linksFor(state.dir, state.group);
    currentLinks = links[state.sa2] ?? [];
  } else {
    currentLinks = [];
  }
  linkRankByCode = new Map(currentLinks.map((link, index) => [link[0], index + 1]));
  computeBreaks();
  restyleMap();
  drawLinks();
  renderLegend();
  renderControls();
  renderDetails();
  writeHash();
  if (fit && state.sa2) fitSelection();
}

function select(code, options = {}) {
  state.sa2 = code;
  update({ fit: true, ...options });
}

// -- about ----
function renderAbout() {
  const dummy = meta.is_dummy_data
    ? '<dt>These are dummy data</dt><dd>Simulated from a gravity model to test the site. They describe no real place or person.</dd>'
    : '';
  document.getElementById('about-body').innerHTML = `<dl>${dummy}
    <dt>Who is counted</dt><dd>Australians born ${meta.birth_year_min}–${meta.birth_year_max}, pooled, observed at ${meta.origin_age} and again at ${meta.destination_age}.</dd>
    <dt>Places</dt><dd>${numberFormat.format(meta.n_sa2)} Statistical Areas Level 2, ASGS 2016 edition, used at both ages.</dd>
    <dt>Groups</dt><dd>Parental-income quartile and sex are separate splits; they are never combined.</dd>
    <dt>Rates</dt><dd>“Still in their SA2” is the share of an SA2's children living in the same SA2 at ${meta.destination_age}. “Grew up elsewhere” is the share of an SA2's ${meta.destination_age}-year-olds who lived in a different SA2 at ${meta.origin_age}.</dd>
    <dt>Distance</dt><dd>Straight-line km between SA2 reference points (a point inside each SA2). The mean counts stayers at 0 km; the median is over movers only.</dd>
    <dt>Privacy</dt><dd>A rate needs at least ${meta.min_base_count} children; a destination or origin is listed only if at least ${meta.min_link_count} children made that move. Counts are rounded to the nearest ${meta.count_rounding_base}.</dd>
    <dt>Download</dt><dd><a href="data/sa2_summary.csv" download>SA2 summary</a> · <a href="data/sa2_top_links.csv" download>Top links</a> · <a href="data/sa2_reference_points.csv" download>SA2 reference points</a></dd>
    <dt>Credits</dt><dd>Boundaries: ABS, ASGS 2016 (CC BY 4.0). Design follows <a href="https://migrationpatterns.org/" rel="noopener">migrationpatterns.org</a> (Sprung-Keyser, Hendren and Porter).</dd>
    <dt>Built</dt><dd>${escapeHtml(meta.built)}</dd></dl>`;
}

// -- start ----
function wireControls() {
  document.getElementById('direction-control').addEventListener('click', (event) => {
    const button = event.target.closest('[data-dir]');
    if (!button || button.dataset.dir === state.dir) return;
    state.dir = button.dataset.dir;
    update();
  });
  document.getElementById('group-control').addEventListener('click', (event) => {
    const button = event.target.closest('[data-group]');
    if (!button) return;
    state.group = button.dataset.group;
    update();
  });
  document.getElementById('measure-control').addEventListener('change', (event) => {
    state.measure = event.target.value;
    update();
  });
  document.getElementById('details').addEventListener('click', (event) => {
    const target = event.target.closest('[data-select], [data-clear], [data-flip], [data-group-pick]');
    if (!target) return;
    if (target.dataset.select) select(target.dataset.select);
    else if ('clear' in target.dataset) { state.sa2 = null; update(); }
    else if ('flip' in target.dataset) { state.dir = state.dir === 'from' ? 'to' : 'from'; update({ fit: true }); }
    else if (target.dataset.groupPick) { state.group = target.dataset.groupPick; update(); }
  });

  const search = document.getElementById('search');
  const codeByLabel = new Map();
  const options = [...lookupByCode.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((place) => {
      const label = `${place.name} (${place.state})`;
      codeByLabel.set(label.toLowerCase(), place.code);
      return `<option value="${escapeHtml(label)}"></option>`;
    });
  document.getElementById('sa2-names').innerHTML = options.join('');
  const pickFromSearch = () => {
    const text = search.value.trim().toLowerCase();
    if (!text) return;
    let code = codeByLabel.get(text);
    if (!code) {
      const match = [...codeByLabel.entries()].find(([label]) => label.startsWith(text))
        ?? [...codeByLabel.entries()].find(([label]) => label.includes(text));
      code = match?.[1];
    }
    if (code) { select(code); search.blur(); }
  };
  search.addEventListener('change', pickFromSearch);
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter') pickFromSearch(); });

  window.addEventListener('hashchange', () => { readHash(); update({ fit: true }); });
}

function buildMap(boundaries, stateOutlines) {
  map = L.map('map', { preferCanvas: true, zoomSnap: 0.25, minZoom: 3, maxZoom: 14 });
  map.fitBounds(AUSTRALIA_BOUNDS);
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('Boundaries &copy; ABS, ASGS 2016 (CC BY 4.0) · <a href="https://leafletjs.com">Leaflet</a>');
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 650;
  map.getPane('labels').style.pointerEvents = 'none';

  sa2Layer = L.geoJSON(boundaries, {
    style: (feature) => styleFor(feature.properties.sa2_code),
    onEachFeature: (feature, layer) => {
      layerByCode.set(feature.properties.sa2_code, layer);
      layer.bindTooltip(tooltipFor, { sticky: true, direction: 'top', offset: [0, -6] });
      layer.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        select(feature.properties.sa2_code);
      });
    },
  }).addTo(map);
  // State lines and city names sit in their own SVG pane above the
  // SA2 canvas, so restyling SA2s never paints over them.
  L.geoJSON(stateOutlines, {
    pane: 'labels', interactive: false,
    style: { fill: false, color: '#3b4252', weight: 1.1, opacity: 0.7 },
  }).addTo(map);
  CITY_LABELS.forEach(([name, lat, lon]) => {
    L.marker([lat, lon], {
      pane: 'labels', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'city-label', html: `<span>${name}</span>`, iconSize: null }),
    }).addTo(map);
  });
  linkOverlay = L.layerGroup().addTo(map);
  map.on('click', () => { if (state.sa2) { state.sa2 = null; update(); } });

  legendControl = L.control({ position: 'bottomright' });
  legendControl.onAdd = () => {
    const container = L.DomUtil.create('div', 'legend');
    L.DomEvent.disableClickPropagation(container);
    return container;
  };
  legendControl.addTo(map);
}

async function start() {
  const status = document.getElementById('map-status');
  try {
    const [metaData, lookup, summaryData, boundaries, stateOutlines] = await Promise.all([
      fetchJson('data/meta.json'), fetchJson('data/sa2_lookup.json'),
      fetchJson('data/summary.json'), fetchJson('data/sa2_2016_boundaries.json'),
      fetchJson('data/state_outlines.json'),
    ]);
    meta = metaData;
    summary = summaryData;
    lookupByCode = new Map(lookup.map((place) => [place.code, place]));
    document.getElementById('dummy-banner').hidden = !meta.is_dummy_data;
    document.getElementById('lede').textContent = `Where children who lived in each SA2 at ${meta.origin_age} were living at ${meta.destination_age}, and where each SA2's ${meta.destination_age}-year-olds grew up. Australians born ${meta.birth_year_min}–${meta.birth_year_max}.`;
    // State and shading breaks first: the layer is styled as it is
    // built.
    readHash();
    computeBreaks();
    buildMap(boundaries, stateOutlines);
    wireControls();
    renderAbout();
    await update({ fit: Boolean(state.sa2) });
    status.hidden = true;
    // The container can change size while data load (fonts, the
    // banner), so re-measure and fit once everything is in place.
    map.invalidateSize({ animate: false });
    if (!state.sa2) map.fitBounds(AUSTRALIA_BOUNDS, { animate: false });

    // Leaflet re-measures only on window resize. When the container
    // changes size on its own (the phone layout settling, a page
    // opened in a background tab), re-measure, and keep Australia
    // framed until the visitor first touches the map.
    let visitorHasMoved = false;
    const mapElement = document.getElementById('map');
    ['pointerdown', 'wheel', 'keydown'].forEach((type) => mapElement.addEventListener(type, () => { visitorHasMoved = true; }, { once: true, passive: true }));
    new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      if (!visitorHasMoved && !state.sa2) map.fitBounds(AUSTRALIA_BOUNDS, { animate: false });
    }).observe(mapElement);
  } catch (error) {
    status.textContent = location.protocol === 'file:'
      ? 'Open this page through a web server (it loads data files), not as a local file.'
      : `Could not load the data: ${error.message}`;
    console.error(error);
  }
}

start();
