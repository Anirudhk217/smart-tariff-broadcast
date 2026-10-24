import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSlots, bestWindow, worstWindow, cheapRuns, slotsFor, describe, ukTime, ukDay, windowLabel, pence, pounds, REGIONS,
} from '../site/plan.js';

const data = JSON.parse(readFileSync(new URL('../site/data/latest.json', import.meta.url)));
const { rates, carbon } = data.regions.C;
const NOW = Date.parse('2026-10-24T11:52:00Z');
const slots = buildSlots(rates, carbon, NOW);

test('slots start at the current half hour and run to the end of the carbon forecast', () => {
  assert.equal(new Date(slots[0].start).toISOString(), '2026-10-24T11:30:00.000Z');
  assert.equal(slots[0].price, -0.47);
  assert.equal(slots[0].carbon, 97);
  assert.equal(new Date(slots.at(-1).start).toISOString(), '2026-10-26T11:30:00.000Z');
  // Prices stop at 22:00Z; later slots have carbon only.
  const after = slots.find((s) => s.start === Date.parse('2026-10-24T22:00:00Z'));
  assert.equal(after.price, null);
  assert.equal(after.carbon, 54);
});

test('slotsFor rounds up to whole half hours', () => {
  assert.equal(slotsFor(2), 4);
  assert.equal(slotsFor(1.5), 3);
  assert.equal(slotsFor(1.2), 3);
  assert.equal(slotsFor(0.1), 1);
});

test('cheapest 2-hour window is the midday plunge', () => {
  const w = bestWindow(slots, 4, 'price');
  assert.equal(new Date(w.start).toISOString(), '2026-10-24T11:30:00.000Z');
  assert.ok(Math.abs(w.avgPrice - (-0.47 + 0.92 + 0.46 + 0.77) / 4) < 1e-9);
});

test('greenest 2-hour window uses the 48h carbon forecast', () => {
  const w = bestWindow(slots, 4, 'carbon');
  assert.equal(new Date(w.start).toISOString(), '2026-10-25T09:00:00.000Z');
  assert.equal(w.avgCarbon, 36.5);
  assert.equal(w.avgPrice, null); // prices not published that far ahead
});

test('balance mode only uses slots with both price and carbon', () => {
  const w = bestWindow(slots, 4, 'balance');
  assert.ok(w.avgPrice != null && w.avgCarbon != null);
  assert.ok(w.start >= slots[0].start && w.end <= Date.parse('2026-10-24T22:00:00Z'));
});

test('no window when the run is longer than the data', () => {
  assert.equal(bestWindow(slots, 30, 'price'), null);
});

test('worst window finds the 4pm to 6pm peak', () => {
  const w = worstWindow(slots, 4);
  assert.equal(new Date(w.start).toISOString(), '2026-10-24T16:00:00.000Z');
  assert.ok(w.avgPrice > 25);
});

test('cheapRuns finds plunge (negative) pricing', () => {
  const runs = cheapRuns(slots, 0);
  assert.equal(runs.length, 1);
  assert.equal(new Date(runs[0].start).toISOString(), '2026-10-24T11:30:00.000Z');
  assert.equal(runs[0].min, -0.47);
});

test('describe returns null past the end of the data', () => {
  assert.equal(describe(slots, slots.length - 1, 4), null);
});

test('UK times follow the clock change on 25 Oct 2026', () => {
  assert.equal(ukTime(Date.parse('2026-10-24T12:00:00Z')), '13:00'); // BST
  assert.equal(ukTime(Date.parse('2026-10-25T12:00:00Z')), '12:00'); // GMT
  assert.equal(ukDay(Date.parse('2026-10-24T22:30:00Z'), NOW), 'today'); // 23:30 BST
  assert.equal(ukDay(Date.parse('2026-10-25T09:00:00Z'), NOW), 'tomorrow');
  assert.equal(windowLabel(bestWindow(slots, 4, 'carbon'), NOW), '09:00 to 11:00 tomorrow');
});

test('money formatting', () => {
  assert.equal(pence(-0.47), '-0.5p');
  assert.equal(pence(27.96), '28p');
  assert.equal(pounds(-12), '-12p');
  assert.equal(pounds(0.3), 'under 1p');
  assert.equal(pounds(250), '£2.50');
});

test('every region maps to a distinct carbon region', () => {
  const ids = Object.values(REGIONS).map((r) => r.carbonId);
  assert.equal(new Set(ids).size, 14);
});
