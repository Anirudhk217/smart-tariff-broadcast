// Time-slot logic for Smart-Tariff Broadcast.
// Pure functions shared by the browser app and the Node tests.

export const SLOT_MS = 30 * 60 * 1000;

// Octopus/DNO region letters, mapped to the Carbon Intensity API's region ids.
export const REGIONS = {
  A: { name: 'East England', carbonId: 10 },
  B: { name: 'East Midlands', carbonId: 9 },
  C: { name: 'London', carbonId: 13 },
  D: { name: 'Merseyside and North Wales', carbonId: 6 },
  E: { name: 'West Midlands', carbonId: 8 },
  F: { name: 'North East England', carbonId: 4 },
  G: { name: 'North West England', carbonId: 3 },
  H: { name: 'Southern England', carbonId: 12 },
  J: { name: 'South East England', carbonId: 14 },
  K: { name: 'South Wales', carbonId: 7 },
  L: { name: 'South West England', carbonId: 11 },
  M: { name: 'Yorkshire', carbonId: 5 },
  N: { name: 'South Scotland', carbonId: 2 },
  P: { name: 'North Scotland', carbonId: 1 },
};

export const DEFAULT_APPLIANCES = [
  { id: 'dishwasher', name: 'Dishwasher', hours: 2, kwh: 1.2 },
  { id: 'washer', name: 'Washing machine', hours: 1.5, kwh: 1 },
  { id: 'dryer', name: 'Tumble dryer', hours: 1.5, kwh: 2.5 },
  { id: 'ev', name: 'EV charge (7 kW)', hours: 4, kwh: 28 },
];

export function floorToSlot(ms) {
  return Math.floor(ms / SLOT_MS) * SLOT_MS;
}

// rates: [[fromISO, toISO, pencePerKwh]], carbon: [[fromISO, gCO2PerKwh]].
// Returns consecutive half-hour slots from the current one onwards, each with
// whichever of price and carbon is known for it (null otherwise).
export function buildSlots(rates, carbon, nowMs) {
  const price = new Map();
  for (const [from, to, p] of rates || []) {
    // Rates normally cover one half hour, but be safe if one spans several.
    for (let t = Date.parse(from); t < Date.parse(to); t += SLOT_MS) price.set(t, p);
  }
  const co2 = new Map();
  for (const [from, g] of carbon || []) co2.set(Date.parse(from), g);
  const start = floorToSlot(nowMs);
  const last = Math.max(start, ...price.keys(), ...co2.keys());
  const slots = [];
  for (let t = start; t <= last; t += SLOT_MS) {
    slots.push({ start: t, price: price.has(t) ? price.get(t) : null, carbon: co2.has(t) ? co2.get(t) : null });
  }
  return slots;
}

function avg(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Best contiguous window of `count` slots.
// mode: 'price' (lowest average price), 'carbon' (lowest average gCO2), or
// 'balance' (both scaled 0-1 over the slots that have them, then averaged).
// Only windows where every slot has the data the mode needs are considered.
export function bestWindow(slots, count, mode = 'price') {
  const need = (s) => (mode === 'price' ? s.price != null : mode === 'carbon' ? s.carbon != null : s.price != null && s.carbon != null);
  let score;
  if (mode === 'balance') {
    const ps = slots.filter(need).map((s) => s.price);
    const cs = slots.filter(need).map((s) => s.carbon);
    const [pMin, pMax, cMin, cMax] = [Math.min(...ps), Math.max(...ps), Math.min(...cs), Math.max(...cs)];
    const norm = (v, lo, hi) => (hi === lo ? 0 : (v - lo) / (hi - lo));
    score = (s) => (norm(s.price, pMin, pMax) + norm(s.carbon, cMin, cMax)) / 2;
  } else {
    score = (s) => s[mode];
  }
  let best = null;
  for (let i = 0; i + count <= slots.length; i++) {
    const win = slots.slice(i, i + count);
    if (!win.every(need)) continue;
    const s = avg(win.map(score));
    if (!best || s < best.score - 1e-9) best = { index: i, score: s };
  }
  if (!best) return null;
  return describe(slots, best.index, count);
}

// Averages for a window starting at `index`, or null if the slots run out.
export function describe(slots, index, count) {
  const win = slots.slice(index, index + count);
  if (win.length < count) return null;
  const prices = win.map((s) => s.price).filter((v) => v != null);
  const carbons = win.map((s) => s.carbon).filter((v) => v != null);
  return {
    index,
    start: win[0].start,
    end: win[count - 1].start + SLOT_MS,
    avgPrice: prices.length === count ? avg(prices) : null,
    avgCarbon: carbons.length === count ? avg(carbons) : null,
  };
}

// Slots needed to run for `hours`, rounded up to the next half hour.
export function slotsFor(hours) {
  return Math.max(1, Math.ceil((hours * 60) / 30 - 1e-9));
}

// Contiguous runs of slots whose price is at or below `threshold` pence (e.g. 0 for plunge pricing).
export function cheapRuns(slots, threshold) {
  const runs = [];
  let cur = null;
  for (const s of slots) {
    if (s.price != null && s.price <= threshold) {
      if (!cur) { cur = { start: s.start, end: s.start + SLOT_MS, min: s.price }; runs.push(cur); }
      else { cur.end = s.start + SLOT_MS; cur.min = Math.min(cur.min, s.price); }
    } else cur = null;
  }
  return runs;
}

// The most expensive contiguous `count` slots, to warn people off (e.g. the 4-7pm peak).
export function worstWindow(slots, count) {
  let worst = null;
  for (let i = 0; i + count <= slots.length; i++) {
    const win = slots.slice(i, i + count);
    if (!win.every((s) => s.price != null)) continue;
    const a = avg(win.map((s) => s.price));
    if (!worst || a > worst.avg) worst = { index: i, avg: a };
  }
  return worst ? describe(slots, worst.index, count) : null;
}

// Times shown in UK local time, so the clock change is handled for the reader.
export function ukTime(ms, opts = {}) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London', ...opts });
}

export function ukDay(ms, nowMs) {
  const key = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  if (key(ms) === key(nowMs)) return 'today';
  if (key(ms) === key(nowMs + 86400000)) return 'tomorrow';
  return new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' });
}

// "12:00 to 14:00 today"
export function windowLabel(w, nowMs) {
  return `${ukTime(w.start)} to ${ukTime(w.end)} ${ukDay(w.start, nowMs)}`;
}

export function pence(p) {
  return `${p.toFixed(p !== 0 && Math.abs(p) < 10 ? 1 : 0)}p`;
}

// A cost in pence as people say it: "under 1p", "45p", "£1.20".
export function pounds(penceTotal) {
  const sign = penceTotal < 0 ? '-' : '';
  const abs = Math.abs(penceTotal);
  if (abs < 0.5) return 'under 1p';
  if (abs < 99.5) return `${sign}${Math.round(abs)}p`;
  return `${sign}£${(abs / 100).toFixed(2)}`;
}
