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
const { parseSprintDates, readSprintDates, sprintProgress } = context;
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

test('impossible, reversed or century-long sprint dates are ignored', () => {
  warnings.length = 0;
  const text = 'Sprint 1 : du 2026-00-15 au 2026-11-10. Sprint 2 : du 2026-11-10 au 2026-11-01. '
    + 'Sprint 3 : ouvert le 0026-11-11. Sprint 4 : du 2026-02-30 au 2026-03-10. Sprint 5 : ouvert le 2026-11-11.';
  assert.deepEqual(Object.keys(plain(parseSprintDates(text))), ['5']);
  assert.equal(warnings.length, 4);
});

test('info.sprints is read first, sprint_rules is the fallback', () => {
  const sprints = [{ n: 1, start: '2026-10-22', end: '2026-11-10' }, { n: 2, start: '2026-11-12', end: null }];
  assert.deepEqual(plain(readSprintDates({ sprints, sprint_rules: RULES })), {
    1: { start: '2026-10-22', end: '2026-11-10' },
    2: { start: '2026-11-12', end: null },
  });
  assert.deepEqual(plain(readSprintDates({ sprints: [], sprint_rules: RULES }))[2], { start: '2026-11-11', end: null });
  assert.deepEqual(plain(readSprintDates({ sprint_rules: RULES }))[2], { start: '2026-11-11', end: null });
});

test('info.sprints entries with bad dates or numbers are ignored', () => {
  warnings.length = 0;
  const sprints = [
    { n: 1, start: '2026-02-30', end: '2026-03-10' },  // impossible date
    { n: 2, start: '2026-11-10', end: '2026-11-01' },  // reversed
    { n: 3, start: '0026-11-11', end: null },          // centuries long
    { n: '4', start: '2026-11-11', end: null },        // number as text
    { n: 5, start: 20261111, end: null },              // date as number
    null,
    { n: 6, start: '2026-11-11' },                     // no end: open sprint, kept
    // Objects that throw when turned into text: the warning must not crash the render.
    JSON.parse('{"n": {"toString": 1}, "start": {"toString": 1}, "end": [{"toString": 1}]}'),
  ];
  assert.deepEqual(plain(readSprintDates({ sprints })), { 6: { start: '2026-11-11', end: null } });
  assert.equal(warnings.length, 7);
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


test('steps sort by status (En cours first, Terminé last), then by number', () => {
  const list = [
    { num: 9, status: 'Terminé' }, { num: 3, status: 'À faire' }, { num: 7, status: 'Plus tard' },
    { num: 2, status: 'Bloqué' }, { num: 8, status: 'En cours' }, { num: 1, status: 'À faire' },
    { num: 4, status: 'Inconnu' }, { num: 5, status: 'À renseigner' }, { num: 6, status: 'En pause' },
  ];
  assert.deepEqual(plain(list.sort(context.compareSteps).map((s) => s.num)), [8, 1, 3, 2, 6, 5, 7, 9, 4]);
});

test('estimate warning: silent for untimed JIRA steps, kept when a sub-task has a time or the sums differ', () => {
  warnings.length = 0;
  const step = (id, estimate_min, ...times) => ({
    id, num: 1, status: 'À faire', project_id: 'p', estimate_min,
    subtasks: times.map((t, i) => ({ n: `${id}.${i}`, status: 'À faire', estimate_min: t })),
  });
  context.buildModel({ info: {}, projects: [], steps: [
    step('jira', null, null, null),  // no time anywhere: silent
    step('null-timed', null, 30, null), // step without estimate, sub-task with one: warned
    step('differs', 60, 30, 45),     // sums differ: warned
    step('ok', 75, 30, 45),          // match: silent
  ] });
  assert.deepEqual(plain(warnings.map((w) => w.split(':')[0])), ['step null-timed', 'step differs']);
});

test('milestones show their id before their name', () => {
  assert.equal(context.milestoneLabel({ id: 'M3', name: 'TLS 1.0 tranché' }), 'M3 · TLS 1.0 tranché');
  assert.equal(context.milestoneLabel({ name: 'Sans id' }), 'Sans id');
  assert.equal(context.milestoneLabel({ id: 'M7' }), 'M7');
});

test('finished projects are split from open ones, in file order', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'empty' }];
  const s = (project_id, status) => ({ project_id, status, num: 1, load: 0 });
  const { open, closed } = context.splitProjects(projects,
    [s('p1', 'Terminé'), s('p2', 'Terminé'), s('p2', 'En cours'), s('p3', 'Terminé')]);
  assert.deepEqual(plain(open.map((o) => o.project.id)), ['p2', 'empty']);
  assert.deepEqual(plain(closed.map((o) => o.project.id)), ['p1', 'p3']);
  assert.equal(context.closedToggleLabel(false), 'Afficher les projets terminés');
  assert.equal(context.closedToggleLabel(true), 'Masquer les projets terminés');
});

test('today list summary: counts by status, then remaining hours of unfinished tasks', () => {
  const t = (status, estimate_min) => ({ status, estimate_min });
  assert.equal(context.todaySummary([
    t('Terminé', 60), t('Terminé', 30), t('Terminé', 15), t('En cours', 90), t('À faire', 60), t('À faire', null),
    t('En cours', 75),
  ]), '3 terminées · 2 en cours · 2 à faire · 3 h 45 restantes');
  assert.equal(context.todaySummary([t('Bloqué', 20), t('Terminé', 10), t('À faire', 600)]),
    '1 terminée · 0 en cours · 1 à faire · 1 bloquée · 10 h 20 restantes');
  assert.equal(context.todaySummary([]), '');
});
