// Where young Australians move: SA2 migration map.
//
// Reads the files stage 04 writes to data/ and draws them. Every
// number shown comes from the release tables; the page computes only
// map shading breaks, the approximate 95% interval on rates, which
// scope (same SA4, same state, other state) each link falls in, and
// each scope's "other places" remainder.
//
// Two map modes. With nothing selected, each SA2 is shaded by its own
// statistic. With an SA2 selected, every SA2 is reshaded by that
// SA2's links: the share of its children who went there ("from") or
// of its 26-year-olds who came from there ("to").
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
const SUMMARY_POSITION = {
  n: 0, rate: 1, mean: 2, median: 3,
  same_sa2: 4, same_sa4: 5, same_state: 6, other_state: 7,
};

// The moving scopes, nested: each excludes the one before it.
const MOVING_SCOPES = ['same_sa4', 'same_state', 'other_state'];

const STATE_ABBREVIATIONS = {
  'New South Wales': 'NSW', Victoria: 'Vic.', Queensland: 'Qld', 'South Australia': 'SA',
  'Western Australia': 'WA', Tasmania: 'Tas.', 'Northern Territory': 'NT',
  'Australian Capital Territory': 'ACT', 'Other Territories': 'Other Terr.',
};

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

// Sequential blues (ColorBrewer Blues, 7 classes) for both modes: an
// SA2's own statistic, and a selected SA2's links. One hue reads
// under the common colour-vision deficiencies; the legend title says
// which mode is showing. (Oranges for the links were tried on
// 2026-11-25 and dropped at the user's request.)
const PALETTE = ['#eff3ff', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#084594'];
const NO_DATA_COLOUR = '#d9dce1';
const FLOW_PALETTE = PALETTE;
// Fixed, doubling breaks for link shares, so one SA2's map can be
// compared with another's; quantiles would rescale every click.
const FLOW_BREAKS = [0.005, 0.01, 0.02, 0.04, 0.08, 0.16];
// The suppressed grey, not a near-white: the lightest blue is
// #eff3ff and must stay distinct from "no published link".
const NO_LINK_COLOUR = NO_DATA_COLOUR;
const SELECTED_OUTLINE = '#1b2230';

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
let meta, lookupByCode, summary, map, sa2Layer, legendControl;
const layerByCode = new Map();
const linkCache = new Map();
// Every published link of the selected SA2, largest first, and the
// same indexed by the other SA2's code.
let currentLinks = [];
let linkByCode = new Map();
let breaks = { thresholds: [], min: undefined, max: undefined };
// SA4s per state: where one SA4 is the whole state (the ACT), the
// "elsewhere in the state" scope cannot hold anyone and is not shown.
const sa4CountByState = new Map();
// Breakdown lists the visitor has folded away, kept across selections.
const foldedScopes = new Set();

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

function flowColourFor(share) {
  if (share === null || share === undefined) return NO_LINK_COLOUR;
  let index = 0;
  while (index < FLOW_BREAKS.length && share >= FLOW_BREAKS[index]) index += 1;
  return FLOW_PALETTE[index];
}

function styleFor(code) {
  const base = { fillOpacity: 0.82, color: '#ffffff', weight: 0.35, opacity: 0.9 };
  if (!state.sa2) return { ...base, fillColor: colourFor(statistic(code)) };
  // The selected SA2 is shaded by its own share (stayers, or
  // 26-year-olds who also grew up there) and outlined.
  if (code === state.sa2) {
    return { fillColor: flowColourFor(statistic(code, 'same_sa2')), fillOpacity: 0.95, color: SELECTED_OUTLINE, weight: 3, opacity: 1 };
  }
  const link = linkByCode.get(code);
  return { ...base, fillColor: flowColourFor(link ? link[2] : null), fillOpacity: link ? 0.92 : 0.85 };
}

function restyleMap() {
  sa2Layer.eachLayer((layer) => layer.setStyle(styleFor(layer.feature.properties.sa2_code)));
  // The selected SA2 is drawn last, so neighbours do not paint over
  // its outline.
  if (state.sa2) layerByCode.get(state.sa2)?.bringToFront();
}

// The ACT's one SA4 shares the territory's name; say it once.
function regionLine(place) {
  return place.sa4 === place.state ? escapeHtml(place.state) : `${escapeHtml(place.sa4)} · ${escapeHtml(place.state)}`;
}

function placeLine(place) {
  return `<strong>${escapeHtml(place.name)}</strong><br><span class="muted">${regionLine(place)}</span>`;
}

function tooltipFor(layer) {
  const code = layer.feature.properties.sa2_code;
  const place = lookupByCode.get(code);
  if (state.sa2) return `${placeLine(place)}<br>${selectionTooltipLine(code)}`;
  const measure = measureFor();
  const row = summaryRow(code);
  const value = statistic(code);
  let valueLine;
  if (!row) valueLine = '<span class="muted">No children in the data</span>';
  else if (value === null) valueLine = `<span class="muted">Suppressed: fewer than ${meta.min_base_count} children</span>`;
  else valueLine = `${escapeHtml(measure.label)}: <strong>${formatValue(measure.kind, value)}</strong>`;
  return `${placeLine(place)}<br>${valueLine}`;
}

// What the hovered SA2 is to the selected one.
function selectionTooltipLine(code) {
  const selectedName = escapeHtml(lookupByCode.get(state.sa2).name);
  const from = state.dir === 'from';
  if (code === state.sa2) {
    const share = statistic(code, 'same_sa2');
    if (share === null) return '<span class="muted">Selected</span>';
    return `Selected · <strong>${formatShare(share)}</strong> ${from ? `still here at ${meta.destination_age}` : `also grew up here`}`;
  }
  const link = linkByCode.get(code);
  if (!link) {
    return `<span class="muted">${from ? `Fewer than ${meta.min_link_count} children from ${selectedName} live here at ${meta.destination_age}, or none`
      : `Fewer than ${meta.min_link_count} of ${selectedName}'s ${meta.destination_age}-year-olds grew up here, or none`}</span>`;
  }
  return from
    ? `<strong>${formatShare(link[2])}</strong> of children from ${selectedName} live here at ${meta.destination_age} · ${formatKm(link[3])} away`
    : `<strong>${formatShare(link[2])}</strong> of ${selectedName}'s ${meta.destination_age}-year-olds grew up here · ${formatKm(link[3])} away`;
}

// -- legend ----
function renderLegend() {
  const group = `<span class="muted">${escapeHtml(GROUP_BY_ID[state.group].name)}</span>`;
  if (state.sa2) {
    renderSelectionLegend(group);
    return;
  }
  const measure = measureFor();
  const rows = PALETTE.map((colour, index) => {
    const low = index === 0 ? breaks.min : breaks.thresholds[index - 1];
    const high = index === PALETTE.length - 1 ? breaks.max : breaks.thresholds[index];
    if (low === undefined || high === undefined) return '';
    return `<div class="legend-row"><span class="swatch" style="background:${colour}"></span>${formatValue(measure.kind, low)} – ${formatValue(measure.kind, high)}</div>`;
  }).join('');
  legendControl.getContainer().innerHTML = `<div class="legend-title">${escapeHtml(fill(measure.legend))}<br>${group}</div>${rows}`
    + `<div class="legend-row"><span class="swatch" style="background:${NO_DATA_COLOUR}"></span>Suppressed or none</div>`;
}

function renderSelectionLegend(group) {
  const name = escapeHtml(lookupByCode.get(state.sa2).name);
  const title = state.dir === 'from'
    ? `Where children from ${name} lived at ${meta.destination_age}`
    : `Where ${name}'s ${meta.destination_age}-year-olds grew up`;
  const formatBreak = (value) => `${+(value * 100).toFixed(1)}%`;
  const rows = FLOW_PALETTE.map((colour, index) => {
    const label = index === 0 ? `under ${formatBreak(FLOW_BREAKS[0])}`
      : index === FLOW_PALETTE.length - 1 ? `${formatBreak(FLOW_BREAKS[index - 1])} or more`
        : `${formatBreak(FLOW_BREAKS[index - 1])} – ${formatBreak(FLOW_BREAKS[index])}`;
    return `<div class="legend-row"><span class="swatch" style="background:${colour}"></span>${label}</div>`;
  }).reverse().join('');
  legendControl.getContainer().innerHTML = `<div class="legend-title">${title}<br>${group}</div>${rows}`
    + `<div class="legend-row"><span class="swatch" style="background:${NO_LINK_COLOUR}"></span>Fewer than ${meta.min_link_count}, or none</div>`
    + `<div class="legend-row"><span class="swatch swatch-selected"></span>${name}</div>`;
}

// Frame the selection and its largest links (only the largest few:
// the full list can span the country). Move when they are off
// screen, or when they fill under a tenth of the view's width and
// height -- at national scale a city SA2 and its neighbours are
// specks, and their shading cannot be seen.
function fitSelection({ animate = true } = {}) {
  // A map with no size yet (a background tab, a layout still
  // settling) cannot be fitted: Leaflet throws on the NaN bounds and
  // the rest of start-up never runs. The resize observer fits it
  // once it has a size.
  const size = map.getSize();
  if (!size.x || !size.y) return;
  const here = lookupByCode.get(state.sa2);
  const latLngs = [[here.lat, here.lon], ...currentLinks.slice(0, meta.top_n_links).map((link) => {
    const other = lookupByCode.get(link[0]);
    return [other.lat, other.lon];
  })];
  const bounds = L.latLngBounds(latLngs).extend(layerByCode.get(state.sa2).getBounds());
  const view = map.getBounds();
  const tooSmall = bounds.getNorth() - bounds.getSouth() < (view.getNorth() - view.getSouth()) / 10
    && bounds.getEast() - bounds.getWest() < (view.getEast() - view.getWest()) / 10;
  if (view.contains(bounds) && !tooSmall) return;
  if (animate) map.flyToBounds(bounds.pad(0.25), { maxZoom: 11, duration: 0.6 });
  else map.fitBounds(bounds.pad(0.25), { maxZoom: 11, animate: false });
}

// -- panel ----
function approximateInterval(rate, n) {
  if (rate === null || !n) return null;
  return 1.96 * Math.sqrt((rate * (1 - rate)) / n);
}

function statBlock(label, value, note) {
  return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;
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

// -- breakdown by scope ----
// Which scope another SA2 is in, seen from the selected one. Mirrors
// stage 03's scope column: same SA4, else same state, else other.
function scopeOf(here, other) {
  if (other.sa4_code === here.sa4_code) return 'same_sa4';
  if (other.state === here.state) return 'same_state';
  return 'other_state';
}

function scopeTitle(scope, here) {
  if (scope === 'same_sa4') return `Elsewhere in ${escapeHtml(here.sa4)} <span class="tag">SA4</span>`;
  if (scope === 'same_state') return `Elsewhere in ${escapeHtml(here.state)}`;
  return 'Other states and territories';
}

// A bar on one scale for every row of the breakdown: full width is
// 100% of the SA2's children, as in the Opportunity Insights design.
function shareBar(share) {
  const width = Math.max(0, Math.min(100, share * 100));
  return `<span class="share-bar"><span style="width:${width}%"></span></span>`;
}

// A list row's bar, on the same scale as the scope bars above it:
// those span the row less the 66 px share column and gap.
function areaBar(share, extraClass = '') {
  return `<span class="area-bar ${extraClass}" style="width:calc((100% - 66px) * ${Math.max(0, Math.min(1, share))})"></span>`;
}

function scopeList(scope, scopeShare, here) {
  const links = currentLinks.filter((link) => scopeOf(here, lookupByCode.get(link[0])) === scope);
  const shown = links.slice(0, meta.top_n_links);
  const rows = shown.map((link) => {
    const other = lookupByCode.get(link[0]);
    const where = scope === 'other_state' ? `, ${STATE_ABBREVIATIONS[other.state] ?? escapeHtml(other.state)}` : '';
    return `<li><button type="button" data-select="${other.code}" title="Select ${escapeHtml(other.name)}">${areaBar(link[2])}`
      + `<span class="area-text">${escapeHtml(other.name)}${where} <span class="area-note">(${formatKm(link[3])} away · ${formatShare(link[2])})</span></span></button></li>`;
  });
  // The rest of the scope: places beyond the top few, and places
  // with too few children to publish. Rounded shares can leave a
  // hair either way, so anything under 0.05 pp is not shown.
  const remainder = scopeShare - shown.reduce((total, link) => total + link[2], 0);
  if (remainder >= 0.0005) {
    const label = links.length > shown.length ? 'Other places' : `Places with fewer than ${meta.min_link_count} children each`;
    rows.push(`<li class="area-other">${areaBar(remainder, 'muted-bar')}<span class="area-text">${label} <span class="area-note">(${formatShare(remainder)})</span></span></li>`);
  }
  if (!rows.length) return '';
  const open = foldedScopes.has(scope) ? '' : ' open';
  return `<details class="area-list" data-scope="${scope}"${open}><summary><span class="when-open">hide top areas</span><span class="when-closed">show top areas</span></summary><ol>${rows.join('')}</ol></details>`;
}

function renderBreakdown(row, here) {
  const n = row[SUMMARY_POSITION.n];
  const homeShare = row[SUMMARY_POSITION.same_sa2];
  const interval = approximateInterval(homeShare, n);
  const homeNote = state.dir === 'from' ? `still living here at ${meta.destination_age}` : 'also grew up here';
  const home = `<section class="scope home"><h4>${escapeHtml(here.name)} <span class="tag">home</span></h4>`
    + `<div class="scope-row">${shareBar(homeShare)}<strong>${formatShare(homeShare)}</strong></div>`
    + `<p class="scope-note">${homeNote} · ± ${(interval * 100).toFixed(1)} pp, approx. 95% interval</p></section>`;
  const moving = MOVING_SCOPES
    .filter((scope) => scope !== 'same_state' || sa4CountByState.get(here.state) > 1)
    .map((scope) => {
      const share = row[SUMMARY_POSITION[scope]];
      return `<section class="scope"><h4>${scopeTitle(scope, here)}</h4>`
        + `<div class="scope-row">${shareBar(share)}<strong>${formatShare(share)}</strong></div>${scopeList(scope, share, here)}</section>`;
    }).join('');
  return `<div class="breakdown">${home}${moving}</div>`;
}

function renderSelection() {
  const place = lookupByCode.get(state.sa2);
  const row = summaryRow(state.sa2);
  const group = GROUP_BY_ID[state.group];
  const header = `<div class="place-head"><div><h2>${escapeHtml(place.name)}</h2><p class="muted">${regionLine(place)}</p></div>`
    + '<button type="button" class="clear" data-clear aria-label="Clear selection">×</button></div>';
  const context = state.dir === 'from'
    ? `Where children who lived here at ${meta.origin_age} were living at ${meta.destination_age}. <strong>${escapeHtml(group.name)}</strong>.`
    : `Where people living here at ${meta.destination_age} lived at ${meta.origin_age}. <strong>${escapeHtml(group.name)}</strong>.`;
  const flipText = state.dir === 'from'
    ? `Where did ${meta.destination_age}-year-olds in ${escapeHtml(place.name)} grow up? →`
    : `Where did children from ${escapeHtml(place.name)} go? →`;
  const flip = `<button type="button" class="flip" data-flip>${flipText}</button>`;

  if (!row) {
    return `${header}<p class="context-line">${context}</p><p class="small muted">No children in the data for this SA2 and group.</p>${flip}`;
  }
  if (row[SUMMARY_POSITION.same_sa2] === null) {
    return `${header}<p class="context-line">${context}</p><p class="small muted">Suppressed: fewer than ${meta.min_base_count} children in this SA2 and group.</p>${flip}${renderGroupBars()}`;
  }

  const [, , meanKm, medianKm] = row;
  const distances = '<div class="stats">'
    + statBlock('Median distance moved', medianKm === null ? '–' : formatKm(medianKm), 'movers only')
    + statBlock('Mean distance moved', meanKm === null ? '–' : formatKm(meanKm), 'everyone, stayers at 0 km')
    + '</div>';

  return `${header}<p class="context-line">${context}</p>${renderBreakdown(row, place)}${distances}`
    + `${flip}${renderGroupBars()}`;
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
  linkByCode = new Map(currentLinks.map((link) => [link[0], link]));
  computeBreaks();
  restyleMap();
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
    <dt>Breakdown</dt><dd>Everyone from (or in) an SA2 falls in exactly one of four parts: the same SA2; another SA2 in the same SA4; another SA4 in the same state or territory; another state or territory. The top ${meta.top_n_links} places are named in each part, and the rest of the part is shown as one line.</dd>
    <dt>Distance</dt><dd>Straight-line km between SA2 reference points (a point inside each SA2). The mean counts stayers at 0 km; the median is over movers only.</dd>
    <dt>Privacy</dt><dd>A rate needs at least ${meta.min_base_count} children; a place is shaded or named only if at least ${meta.min_link_count} children made that move. Counts are rounded to the nearest ${meta.count_rounding_base}.</dd>
    <dt>Download</dt><dd><a href="data/sa2_summary.csv" download>SA2 summary</a> · <a href="data/sa2_links.csv" download>SA2 links</a> · <a href="data/sa2_reference_points.csv" download>SA2 reference points</a></dd>
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
  // Remember which breakdown lists were folded, so the next SA2
  // opens the same way. "toggle" does not bubble, hence capture.
  document.getElementById('details').addEventListener('toggle', (event) => {
    const scope = event.target.dataset?.scope;
    if (!scope) return;
    if (event.target.open) foldedScopes.delete(scope); else foldedScopes.add(scope);
  }, true);

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
    const sa4sByState = new Map();
    lookup.forEach((place) => {
      if (!sa4sByState.has(place.state)) sa4sByState.set(place.state, new Set());
      sa4sByState.get(place.state).add(place.sa4_code);
    });
    sa4sByState.forEach((sa4s, stateName) => sa4CountByState.set(stateName, sa4s.size));
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
    // A linked SA2 is framed again here, without animation: a flight
    // started before the re-measure is cut short by it.
    map.invalidateSize({ animate: false });
    if (state.sa2) fitSelection({ animate: false });
    else map.fitBounds(AUSTRALIA_BOUNDS, { animate: false });

    // Leaflet re-measures only on window resize. When the container
    // changes size on its own (the phone layout settling, a page
    // opened in a background tab), re-measure, and keep Australia --
    // or a linked SA2 -- framed until the visitor first touches the
    // map.
    let visitorHasMoved = false;
    const mapElement = document.getElementById('map');
    ['pointerdown', 'wheel', 'keydown'].forEach((type) => mapElement.addEventListener(type, () => { visitorHasMoved = true; }, { once: true, passive: true }));
    new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      if (visitorHasMoved) return;
      if (state.sa2) fitSelection({ animate: false });
      else map.fitBounds(AUSTRALIA_BOUNDS, { animate: false });
    }).observe(mapElement);
  } catch (error) {
    status.textContent = location.protocol === 'file:'
      ? 'Open this page through a web server (it loads data files), not as a local file.'
      : `Could not load the data: ${error.message}`;
    console.error(error);
  }
}

start();
