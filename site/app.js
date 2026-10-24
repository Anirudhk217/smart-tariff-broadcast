import {
  REGIONS, DEFAULT_APPLIANCES, SLOT_MS, buildSlots, bestWindow, worstWindow, cheapRuns, describe, slotsFor,
  ukTime, ukDay, windowLabel, pence, pounds,
} from './plan.js';

const STORE_KEY = 'smart-tariff-broadcast:v1';
const OCTOPUS = 'https://api.octopus.energy/v1';
const CARBON = 'https://api.carbonintensity.org.uk';

// ---------- state ----------

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s) return { region: null, mode: 'price', appliances: DEFAULT_APPLIANCES, ...s };
  } catch { /* storage blocked */ }
  return { region: null, mode: 'price', appliances: DEFAULT_APPLIANCES };
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

const state = load();
let snapshot = null; // data/latest.json
let current = null; // { rates, carbon, live, fetchedAt }
let slots = [];

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function band(p) {
  if (p == null) return { label: 'No price yet', color: 'var(--muted)' };
  if (p <= 0) return { label: 'Plunge: paid to use', color: 'var(--plunge)' };
  if (p < 12) return { label: 'Cheap', color: 'var(--cheap)' };
  if (p < 25) return { label: 'Normal', color: 'var(--normal)' };
  return { label: 'Peak', color: 'var(--peak)' };
}

// ---------- data ----------

async function getJson(url, ms = 7000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSnapshot() {
  try { snapshot = await getJson('data/latest.json', 10000); } catch { snapshot = null; }
}

// Fresh numbers straight from the APIs; falls back to the hourly snapshot if blocked or offline.
async function loadLive(region) {
  const from = new Date(Math.floor(Date.now() / SLOT_MS) * SLOT_MS).toISOString().slice(0, 16) + 'Z';
  const code = snapshot?.product?.code || 'AGILE-24-10-01';
  const [r, c] = await Promise.all([
    getJson(`${OCTOPUS}/products/${code}/electricity-tariffs/E-1R-${code}-${region}/standard-unit-rates/?period_from=${from}&page_size=300`),
    getJson(`${CARBON}/regional/intensity/${from}/fw48h/regionid/${REGIONS[region].carbonId}`),
  ]);
  const cr = Array.isArray(c.data) ? c.data[0] : c.data;
  return {
    rates: r.results.map((x) => [x.valid_from, x.valid_to, Math.round(x.value_inc_vat * 100) / 100]),
    carbon: (cr?.data || []).map((d) => [d.from, d.intensity.forecast]),
  };
}

async function refresh() {
  if (!state.region) return;
  const snap = snapshot?.regions?.[state.region];
  if (snap) {
    current = { rates: snap.rates, carbon: snap.carbon, live: false, fetchedAt: snapshot.fetched_at, sample: snapshot.sample };
    render();
  }
  try {
    const live = await loadLive(state.region);
    if (live.rates.length || live.carbon.length) {
      current = { ...live, live: true, fetchedAt: new Date().toISOString() };
      render();
    }
  } catch {
    if (!snap) {
      current = null;
      render();
    }
  }
}

async function postcodeToRegion(postcode) {
  const pc = postcode.replace(/\s+/g, '').toUpperCase();
  const data = await getJson(`${OCTOPUS}/industry/grid-supply-points/?postcode=${encodeURIComponent(pc)}`);
  const id = data.results?.[0]?.group_id?.replace('_', '');
  return REGIONS[id] ? id : null;
}

// ---------- rendering ----------

function render() {
  $('region-btn').textContent = state.region ? REGIONS[state.region].name : 'Choose region';
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
  const now = Date.now();
  slots = current ? buildSlots(current.rates, current.carbon, now) : [];
  renderNow(now);
  renderBulletin(now);
  renderChart(now);
  renderAppliances(now);
  renderStatus();
}

function renderStatus() {
  const s = $('data-status');
  if (!state.region) { s.textContent = 'Choose your region to see prices.'; return; }
  if (!current) { s.textContent = "Couldn't load prices. Check your connection and try again."; return; }
  const when = new Date(current.fetchedAt).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  s.textContent = current.live ? `Live data, fetched ${when}.` : current.sample ? `Sample data from ${when}. Live data loads once the site is deployed.` : `Updated ${when}. Refreshes every hour.`;
}

function renderNow(now) {
  const s = slots[0];
  const b = band(s?.price);
  $('now-price').textContent = s?.price != null ? pence(s.price) : '–';
  $('now-carbon').textContent = s?.carbon != null ? String(s.carbon) : '–';
  $('now-band').textContent = s ? b.label : '';
  document.querySelector('.now').style.setProperty('--band', b.color);
  $('now-range').textContent = s ? `· ${ukTime(s.start)} to ${ukTime(s.start + SLOT_MS)}` : '';
  // When does the price band change next?
  let next = '';
  if (s?.price != null) {
    const change = slots.find((x) => x.price != null && band(x.price).label !== b.label);
    if (change) next = `${band(change.price).label} from ${ukTime(change.start)} ${ukDay(change.start, now)} (${pence(change.price)}).`;
  }
  const lastPrice = [...slots].reverse().find((x) => x.price != null);
  if (lastPrice) next += ` Prices published until ${ukTime(lastPrice.start + SLOT_MS)} ${ukDay(lastPrice.start, now)}.`;
  $('now-next').textContent = next.trim();
}

function bulletinLines(now) {
  const lines = [];
  const plunge = cheapRuns(slots, 0)[0];
  if (plunge) lines.push({ c: 'var(--plunge)', html: `Plunge pricing <b>${ukTime(plunge.start)} to ${ukTime(plunge.end)}</b> ${ukDay(plunge.start, now)}, as low as <b>${pence(plunge.min)}</b>. You're paid to use power.` });
  const cheap = bestWindow(slots, 4, 'price');
  if (cheap) lines.push({ c: 'var(--cheap)', html: `Cheapest 2 hours: <b>${windowLabel(cheap, now)}</b> at <b>${pence(cheap.avgPrice)}</b>/kWh.` });
  const peak = worstWindow(slots, 6);
  if (peak) lines.push({ c: 'var(--peak)', html: `Avoid <b>${windowLabel(peak, now)}</b>, averaging <b>${pence(peak.avgPrice)}</b>/kWh.` });
  const green = bestWindow(slots, 4, 'carbon');
  if (green) lines.push({ c: 'var(--carbon)', html: `Greenest 2 hours: <b>${windowLabel(green, now)}</b> at <b>${Math.round(green.avgCarbon)}</b> gCO₂/kWh.` });
  return lines;
}

function renderBulletin(now) {
  const ul = $('bulletin');
  ul.replaceChildren();
  const lines = bulletinLines(now);
  if (!lines.length) ul.append(el('li', {}, state.region ? 'No forecast available right now.' : 'Choose your region above to get today\'s broadcast.'));
  for (const l of lines) {
    const li = el('li', { style: `--c:${l.c}` });
    li.innerHTML = l.html; // built only from numbers and times computed here
    ul.append(li);
  }
}

function renderChart(now) {
  const svg = $('chart');
  const NS = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  if (!slots.length) return;
  const W = 680, H = 220, L = 34, R = 34, T = 12, B = 26;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const n = slots.length;
  const bw = (W - L - R) / n;
  const prices = slots.map((s) => s.price).filter((v) => v != null);
  const pMax = Math.max(30, ...prices);
  const pMin = Math.min(0, ...prices);
  const cMax = Math.max(100, ...slots.map((s) => s.carbon ?? 0));
  const y = (p) => T + (H - T - B) * (pMax - p) / (pMax - pMin);
  const yc = (g) => T + (H - T - B) * (1 - g / cMax);
  const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.append(e); return e; };

  // Gridlines on the price axis.
  const step = pMax > 60 ? 20 : 10;
  for (let p = Math.ceil(pMin / step) * step; p <= pMax; p += step) {
    add('line', { x1: L, x2: W - R, y1: y(p), y2: y(p), stroke: 'var(--line)', 'stroke-width': p === 0 ? 1.5 : 1 });
    add('text', { x: L - 6, y: y(p) + 3, 'text-anchor': 'end' }, `${p}p`);
  }
  for (const g of [0, Math.round(cMax / 2), Math.round(cMax)]) add('text', { x: W - R + 6, y: yc(g) + 3 }, String(g));

  // Highlight the recommended window for the current mode.
  const w = bestWindow(slots, 4, state.mode);
  if (w) add('rect', { x: L + w.index * bw, y: T, width: 4 * bw, height: H - T - B, fill: 'var(--sunk)' });

  slots.forEach((s, i) => {
    if (s.price == null) return;
    const top = Math.min(y(s.price), y(0));
    add('rect', { x: L + i * bw + 0.5, y: top, width: Math.max(1, bw - 1), height: Math.max(1, Math.abs(y(s.price) - y(0))), fill: band(s.price).color, rx: 1 });
  });
  const pts = slots.map((s, i) => (s.carbon == null ? null : `${(L + i * bw + bw / 2).toFixed(1)},${yc(s.carbon).toFixed(1)}`)).filter(Boolean);
  if (pts.length > 1) add('polyline', { points: pts.join(' '), fill: 'none', stroke: 'var(--carbon)', 'stroke-width': 2, 'stroke-linejoin': 'round' });

  // Time labels every 6 hours, on UK clock times.
  slots.forEach((s, i) => {
    const t = ukTime(s.start);
    if (i === 0 || t.endsWith(':00') && ['00', '06', '12', '18'].includes(t.slice(0, 2))) {
      if (i > 0 && i < 4) return; // keep clear of the first label
      const label = i === 0 ? 'Now' : t === '00:00' ? new Date(s.start).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/London' }) : t;
      add('line', { x1: L + i * bw, x2: L + i * bw, y1: H - B, y2: H - B + 4, stroke: 'var(--muted)' });
      add('text', { x: L + i * bw, y: H - 8, 'text-anchor': i === 0 ? 'start' : 'middle' }, label);
    }
  });
  const lastPrice = [...slots].reverse().find((x) => x.price != null);
  $('chart-note').textContent = lastPrice && lastPrice.start < slots.at(-1).start
    ? `Bars are prices; tomorrow's arrive around 4pm. The line is the carbon forecast. Shaded: best 2 hours (${state.mode === 'price' ? 'cheapest' : state.mode === 'carbon' ? 'greenest' : 'cheap and green'}).`
    : 'Bars are prices, the line is the carbon forecast. Shaded: the best 2 hours for your setting.';
}

function renderAppliances(now) {
  const list = $('appliances');
  list.replaceChildren();
  for (const a of state.appliances) {
    const n = slotsFor(a.hours);
    const w = slots.length ? bestWindow(slots, n, state.mode) : null;
    const nowW = slots.length ? describe(slots, 0, n) : null;
    let detail = 'No forecast covers this long a run yet.';
    let saving = null;
    if (w) {
      const parts = [];
      if (w.avgPrice != null) parts.push(`${pence(w.avgPrice)}/kWh, costs ${pounds(w.avgPrice * a.kwh)}`);
      if (w.avgCarbon != null) parts.push(`${Math.round(w.avgCarbon)} gCO₂/kWh`);
      detail = `${a.hours} h · ${a.kwh} kWh · ${parts.join(' · ')}`;
      if (w.avgPrice != null && nowW?.avgPrice != null && (nowW.avgPrice - w.avgPrice) * a.kwh >= 0.5) {
        saving = `Saves ${pounds((nowW.avgPrice - w.avgPrice) * a.kwh)} vs starting now`;
      } else if (state.mode !== 'price' && w.avgCarbon != null && nowW?.avgCarbon != null && nowW.avgCarbon > w.avgCarbon) {
        saving = `${Math.round((1 - w.avgCarbon / nowW.avgCarbon) * 100)}% less CO₂ than now`;
      }
    }
    list.append(el('div', { class: 'appl' },
      el('span', { class: 't' }, a.name),
      el('span', { class: 'when' }, w ? shortWhen(w.start, now) : '–'),
      el('span', { class: 's' }, detail),
      saving ? el('span', { class: 's save' }, saving) : null,
      el('div', { class: 'actions' },
        w ? el('button', { class: 'btn ghost small', onclick: () => downloadIcs(a, w) }, 'Add to calendar') : null,
        el('button', { class: 'btn ghost small', onclick: () => removeAppliance(a.id) }, 'Remove')),
    ));
  }
  if (!state.appliances.length) list.append(el('p', { class: 'muted' }, 'Add the appliances you want to time.'));
}

// "13:00" today, otherwise "Sun 09:00".
function shortWhen(ms, now) {
  if (ukDay(ms, now) === 'today') return ukTime(ms);
  return `${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/London' })} ${ukTime(ms)}`;
}

// ---------- actions ----------

function setRegion(letter) {
  state.region = letter;
  save();
  $('region-select').value = letter;
  $('region-panel').hidden = true;
  $('region-btn').setAttribute('aria-expanded', 'false');
  refresh();
}

function removeAppliance(id) {
  state.appliances = state.appliances.filter((a) => a.id !== id);
  save();
  render();
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function downloadIcs(a, w) {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Smart-Tariff Broadcast//EN', 'BEGIN:VEVENT',
    `UID:${w.start}-${a.id}@smart-tariff-broadcast`, `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(w.start)}`, `DTEND:${icsDate(w.end)}`,
    `SUMMARY:Run the ${a.name.toLowerCase()}`,
    `DESCRIPTION:Best window from Smart-Tariff Broadcast${w.avgPrice != null ? ` (${pence(w.avgPrice)}/kWh)` : ''}.`,
    'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', `DESCRIPTION:Run the ${a.name.toLowerCase()}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const link = el('a', { href: url, download: `${a.id}-${icsDate(w.start)}.ics` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function share() {
  const now = Date.now();
  const tmp = document.createElement('div');
  const text = [`Smart-Tariff Broadcast · ${REGIONS[state.region]?.name || 'GB'}`,
    ...bulletinLines(now).map((l) => { tmp.innerHTML = l.html; return `• ${tmp.textContent}`; }),
    location.href.split('#')[0]].join('\n');
  const status = $('share-status');
  try {
    if (navigator.share) { await navigator.share({ text }); status.textContent = ''; return; }
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copied to your clipboard.';
  } catch {
    status.textContent = "Couldn't share. Long-press the broadcast to copy it.";
  }
}

// ---------- wire up ----------

const select = $('region-select');
select.append(el('option', { value: '' }, 'Pick your region'));
for (const [k, r] of Object.entries(REGIONS)) select.append(el('option', { value: k }, r.name));
select.addEventListener('change', () => select.value && setRegion(select.value));

$('region-btn').addEventListener('click', () => {
  const p = $('region-panel');
  p.hidden = !p.hidden;
  $('region-btn').setAttribute('aria-expanded', String(!p.hidden));
});

$('postcode-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('postcode-status');
  const pc = $('postcode').value.trim();
  if (!pc) return;
  status.textContent = 'Looking up your region…';
  try {
    const region = await postcodeToRegion(pc);
    if (!region) { status.textContent = "That postcode isn't in Great Britain's regions. Pick from the list instead."; return; }
    status.textContent = `You're in ${REGIONS[region].name}.`;
    setRegion(region);
  } catch {
    status.textContent = "Couldn't look up that postcode. Pick your region from the list instead.";
  }
});

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  save();
  render();
}));

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('a-name').value.trim();
  const hours = Number($('a-hours').value);
  const kwh = Number($('a-kwh').value);
  if (!name || !(hours > 0) || !(kwh > 0)) return;
  state.appliances.push({ id: `${Date.now().toString(36)}`, name, hours, kwh });
  save();
  e.target.reset();
  render();
});

$('share-btn').addEventListener('click', share);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async () => {
  if (!state.region) {
    $('region-panel').hidden = false;
    $('region-btn').setAttribute('aria-expanded', 'true');
  } else {
    select.value = state.region;
  }
  render();
  await loadSnapshot();
  await refresh();
  // Move "now" forward and pick up new prices while the page stays open.
  setInterval(() => (Date.now() % SLOT_MS < 5 * 60 * 1000 ? refresh() : render()), 5 * 60 * 1000);
})();
