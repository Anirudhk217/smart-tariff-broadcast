// Downloads Octopus Agile half-hourly prices and the Carbon Intensity 48-hour
// forecast for every GB region, and writes site/data/latest.json for the app.
// Runs in GitHub Actions every hour. No keys needed.

import { writeFile, mkdir } from 'node:fs/promises';
import { REGIONS } from '../site/plan.js';

const OCTOPUS = 'https://api.octopus.energy/v1';
const CARBON = 'https://api.carbonintensity.org.uk';

async function getJson(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) return await res.json();
      if (attempt === 4) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    } catch (err) {
      if (attempt === 4) throw err;
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

// The current Agile import product, e.g. AGILE-24-10-01. Octopus replaces it every so often.
async function agileProduct() {
  let url = `${OCTOPUS}/products/?brand=OCTOPUS_ENERGY&is_variable=true&page_size=100`;
  const found = [];
  while (url) {
    const page = await getJson(url);
    for (const p of page.results) {
      if (p.code.startsWith('AGILE-') && !p.code.includes('OUTGOING') && p.direction === 'IMPORT') found.push(p);
    }
    url = page.next;
  }
  if (!found.length) throw new Error('No Agile import product found');
  found.sort((a, b) => String(b.available_from).localeCompare(String(a.available_from)));
  return { code: found[0].code, name: found[0].display_name };
}

async function agileRates(code, region, fromIso) {
  const tariff = `E-1R-${code}-${region}`;
  const data = await getJson(`${OCTOPUS}/products/${code}/electricity-tariffs/${tariff}/standard-unit-rates/?period_from=${fromIso}&page_size=300`);
  return data.results
    .map((r) => [r.valid_from, r.valid_to, Math.round(r.value_inc_vat * 100) / 100])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

async function carbonForecast(regionId, fromIso) {
  const data = await getJson(`${CARBON}/regional/intensity/${fromIso}/fw48h/regionid/${regionId}`);
  // The API returns { data: { regionid, shortname, data: [...] } }, sometimes wrapped in an array.
  const region = Array.isArray(data.data) ? data.data[0] : data.data;
  return (region?.data || []).map((d) => [d.from, d.intensity.forecast]);
}

const now = new Date();
const from = new Date(Math.floor(now.getTime() / 1800000) * 1800000 - 3600000); // an hour back, on the half hour
const fromIso = from.toISOString().slice(0, 16) + 'Z';

const product = await agileProduct();
const regions = {};
for (const [letter, info] of Object.entries(REGIONS)) {
  const [rates, carbon] = await Promise.all([
    agileRates(product.code, letter, fromIso).catch((e) => { console.warn(`Prices for ${letter}: ${e.message}`); return []; }),
    carbonForecast(info.carbonId, fromIso).catch((e) => { console.warn(`Carbon for ${letter}: ${e.message}`); return []; }),
  ]);
  regions[letter] = { name: info.name, carbon_region: info.carbonId, rates, carbon };
}

const withPrices = Object.values(regions).filter((r) => r.rates.length).length;
if (withPrices === 0) throw new Error('No prices fetched for any region; keeping the last deploy.');

await mkdir(new URL('../site/data/', import.meta.url), { recursive: true });
await writeFile(new URL('../site/data/latest.json', import.meta.url), JSON.stringify({
  fetched_at: now.toISOString(),
  product,
  source: 'Octopus Energy public tariff API and the National Grid ESO Carbon Intensity API (CC BY 4.0)',
  regions,
}));
console.log(`Wrote ${product.code} prices for ${withPrices}/14 regions, carbon for ${Object.values(regions).filter((r) => r.carbon.length).length}/14.`);
