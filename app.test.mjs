// Unit tests for the computed sprint curve. Run: node --test
// app.js is a browser script: it is loaded in a vm context with minimal stubs, and its top-level
// function declarations are read back from that context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const warnings = [];
const context = {
  console: { warn: (msg) => warnings.push(msg), log() {} },
  location: { search: '' },
  URLSearchParams,
  Intl,
  document: { addEventListener() {}, getElementById: () => ({}) },
  fetch: () => new Promise(() => {}),
  setInterval() {},
  setTimeout() {},
};
vm.createContext(context);
vm.runInContext(readFileSync(new URL('./app.js', import.meta.url), 'utf8'), context);
const { parseSprintDates, sprintProgress } = context;
// Objects built inside the vm context have that context's prototypes: compare plain JSON copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

const RULES = 'Sprint 1 : du 2026-10-22 au 2026-11-10. Sprint 2 : ouvert le 2026-11-11. Decision de Yoni.';

test('sprint dates are read from sprint_rules', () => {
  assert.deepEqual(plain(parseSprintDates(RULES)), {
    1: { start: '2026-10-22', end: '2026-11-10' },
    2: { start: '2026-11-11', end: null },
  });
  assert.deepEqual(plain(parseSprintDates(undefined)), {});
});

const sub = (n, status, extra = {}) => ({ n, status, estimate_min: 60, ...extra });
const steps = [
  { id: 'a', status: 'En cours', sprint: 2, subtasks: [
    sub('1.1', 'Terminé', { done_date: '2026-11-11', estimate_min: 30 }),
    sub('1.2', 'Terminé', { done_date: '2026-11-13' }),
    sub('1.3', 'À faire'),
    sub('1.4', 'Plus tard'),                                   // out of scope
    sub('1.5', 'Terminé', { sprint: 1, done_date: '2026-11-01' }), // other sprint
  ] },
  { id: 'b', status: 'Terminé', sprint: 2, done_date: '2026-11-12', subtasks: [
    sub('2.1', 'Terminé'),                                      // counted at its step's done_date
  ] },
  { id: 'c', status: 'En cours', sprint: 2, subtasks: [
    sub('3.1', 'Terminé'),                                      // no date anywhere: left out, warned
  ] },
  { id: 'd', status: 'Plus tard', sprint: 2, subtasks: [sub('4.1', 'À faire')] }, // step set aside
];

test('one point per day, plateaus included, current scope on every day', () => {
  warnings.length = 0;
  const points = sprintProgress(steps, 2, '2026-11-11', '2026-11-14');
  assert.deepEqual(plain(points.map((p) => p.date)), ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
  assert.deepEqual(plain(points.map((p) => p.base)), [5, 5, 5, 5]);
  assert.deepEqual(plain(points.map((p) => p.done)), [1, 2, 3, 3]);
  assert.equal(points[0].y, 20);
  assert.equal(points[3].y, 60);
  // Time: 30 + 60 + 60 done out of 30 + 60 + 60 + 60 + 60 = 270.
  assert.equal(points[3].pctTime.toFixed(1), '55.6');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /3\.1/);
});

