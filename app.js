'use strict';

// Road map page: reads global.json (format 2, sprint field since version 109), written by another assistant, and renders it.
// Static page, no framework. All data is inserted with textContent (never innerHTML).

const REFRESH_MS = 30000;
const RETRY_MS = 3000;
const FILES = ['global'];

// Optional ?data=<folder> lets a test copy of the data be served (never C's real files).
const dataParam = new URLSearchParams(location.search).get('data');
const DATA_DIR = /^[\w-]+$/.test(dataParam || '') ? dataParam : 'data';

const STATUS_CLASS = {
  'Terminé': 'done',
  'En cours': 'doing',
  'À faire': 'todo',
  'En pause': 'pause',
  'Bloqué': 'blocked',
  'Plus tard': 'later',
  'À renseigner': 'tbd',
};

const state = {
  data: {},          // last valid version of each file
  signature: {},     // JSON text of the last valid version, to skip needless re-renders
  failingSince: {},  // file name -> Date of the first failure in the current streak
  openSteps: new Set(),
  openProjects: new Set(),
  sprintOffset: 0,   // breadcrumb: how many sprints the window is shifted towards the past
  chartSprint: null, // sprint shown in the chart (null = current sprint)
  retryTimer: null,
};

// ---------- helpers ----------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function dot(status) {
  return el('span', { class: 'dot ' + (STATUS_CLASS[status] || 'tbd'), 'aria-hidden': 'true' });
}

function statusCell(status) {
  return el('span', { class: 'status-cell' }, dot(status), status);
}

function pad(n) { return String(n).padStart(2, '0'); }

function clock(date) { return pad(date.getHours()) + ':' + pad(date.getMinutes()); }

function formatMinutes(min) {
  const total = Math.round(min);
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
}

// Duration as shown in the "Temps" columns: [HH:MM]
// A task without estimate_min shows [--:--] instead of NaN.
const bracketTime = (min) => (Number.isFinite(min) ? `[${formatMinutes(min)}]` : '[--:--]');

function formatNumber(value, digits) {
  return value.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) || 0), 0);

// Compares sub-task numbers such as "87.2" and "87.10" numerically, part by part.
function compareNumbers(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const DAY_MS = 86400000;
const dayOf = (isoDate) => Date.parse(isoDate + 'T00:00:00Z') / DAY_MS;
const isoOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// ---------- loading ----------

async function loadFile(name) {
  const response = await fetch(`${DATA_DIR}/${name}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const parsed = JSON.parse(await response.text());
  if (!parsed || !Array.isArray(parsed.steps) || !Array.isArray(parsed.projects)) {
    throw new Error('unexpected structure');
  }
  return parsed;
}

async function refresh() {
  const results = await Promise.allSettled(FILES.map(loadFile));
  let changed = false;
  results.forEach((result, index) => {
    const name = FILES[index];
    if (result.status === 'fulfilled') {
      delete state.failingSince[name];
      const text = JSON.stringify(result.value);
      if (text !== state.signature[name]) {
        state.signature[name] = text;
        state.data[name] = result.value;
        changed = true;
      }
    } else if (!state.failingSince[name]) {
      state.failingSince[name] = new Date();
    }
  });
  showBanner();
  // A file caught mid-write by its author is usually fine a moment later: retry soon, not in 30 s.
  if (Object.keys(state.failingSince).length && !state.retryTimer) {
    state.retryTimer = setTimeout(() => { state.retryTimer = null; refresh(); }, RETRY_MS);
  }
  if (changed && state.data.global) render();
}

function showBanner() {
  const banner = document.getElementById('banner');
  const messages = Object.entries(state.failingSince)
    .map(([name, since]) => `fichier ${name}.json illisible depuis ${clock(since)}`);
  banner.hidden = messages.length === 0;
  banner.textContent = messages.join(' · ');
}

// ---------- model and computations ----------

// A step's load is the sum of its sub-tasks' estimate_min (the step's own estimate_min should match).
function buildModel(global) {
  const steps = global.steps.map((step) => {
    const subtasks = step.subtasks ?? [];
    const load = subtasks.length ? sum(subtasks, (s) => s.estimate_min) : (step.estimate_min || 0);
    if (subtasks.length && step.estimate_min !== load) {
      console.warn(`step ${step.id}: estimate_min ${step.estimate_min} differs from sub-task sum ${load}`);
    }
    return { ...step, subtasks, load };
  });
  for (const step of steps) {
    for (const sub of step.subtasks) {
      if (sub.status === 'Terminé' && !sub.done_date) console.warn(`sub-task ${sub.n} is Terminé without done_date`);
    }
  }
  const projects = [...global.projects].sort((a, b) => a.order - b.order);
  const milestones = Array.isArray(global.milestones) ? global.milestones : [];
  const info = global.info ?? {};
  // Current sprint = info.sprint ("Sprint 2"), else the highest sprint number any step carries.
  const declared = Number(/(\d+)/.exec(info.sprint ?? '')?.[1]);
  const sprint = declared || Math.max(0, ...steps.flatMap((s) => [s.sprint ?? 0, ...s.subtasks.map((sub) => sub.sprint ?? 0)]));
  return { info, projects, steps, milestones, sprint, sprintDates: readSprintDates(info) };
}

// Sprint dates: the info.sprints field ([{n, start, end}]) when present, else the plain text of info.sprint_rules.
function readSprintDates(info) {
  return Array.isArray(info.sprints) && info.sprints.length
    ? sprintDatesFromList(info.sprints)
    : parseSprintDates(info.sprint_rules);
}

// A sprint with an impossible date, an end before its start or more than a year long is ignored,
// so a typo never makes the daily loop run for centuries.
const MAX_SPRINT_DAYS = 366;
function addSprintDates(dates, n, start, end) {
  const valid = (iso) => typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)
    && Number.isFinite(dayOf(iso)) && isoOf(dayOf(iso)) === iso;
  const ok = Number.isInteger(n) && n > 0 && valid(start) && (end == null || (valid(end) && end >= start))
    && dayOf(end ?? parisToday()) - dayOf(start) <= MAX_SPRINT_DAYS;
  if (ok) dates[n] = { start, end: end ?? null };
  else console.warn(`sprint ${n}: dates ${start}${end ? ' to ' + end : ''} ignored (invalid or longer than ${MAX_SPRINT_DAYS} days)`);
}

// info.sprints: [{"n": 1, "start": "2026-10-22", "end": "2026-11-10"}, {"n": 2, "start": "2026-11-11", "end": null}]
function sprintDatesFromList(list) {
  const dates = {};
  for (const entry of list) addSprintDates(dates, entry?.n, entry?.start, entry?.end);
  return dates;
}

// Fallback, info.sprint_rules in plain text:
// "Sprint 1 : du 2026-10-22 au 2026-11-10. Sprint 2 : ouvert le 2026-11-11." -> { 1: {start, end}, 2: {start} }
function parseSprintDates(text) {
  const dates = {};
  for (const match of String(text ?? '').matchAll(/Sprint (\d+)\s*:\s*(?:du|ouvert le) (\d{4}-\d{2}-\d{2})(?: au (\d{4}-\d{2}-\d{2}))?/g)) {
    addSprintDates(dates, Number(match[1]), match[2], match[3]);
  }
  return dates;
}

// A sub-task belongs to the sprint it carries (a finished one: the sprint it was done in), else its step's.
const subSprint = (sub, step) => sub.sprint ?? step.sprint;
// Sprints a step touches: its "sprints" list, else its own single sprint.
const stepSprints = (step) => step.sprints ?? (step.sprint == null ? [] : [step.sprint]);

// Sprint scope: its sub-tasks, minus those (or those of a step) set to "Plus tard".
const sprintScope = (steps, n) => steps.flatMap((step) => step.subtasks
  .filter((sub) => n > 0 && subSprint(sub, step) === n && sub.status !== 'Plus tard' && step.status !== 'Plus tard')
  .map((sub) => ({ sub, step })));

// Today's date in Paris, as YYYY-MM-DD (the en-CA locale formats dates that way).
const parisToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());

// Daily progress of a sprint, computed from the sub-tasks (no stored history): one point per day from
// `start` to `end`, with the current scope applied to every day. A finished sub-task counts from its
// done_date, else its step's done_date; without either it is left out and reported in the console.
function sprintProgress(steps, n, start, end) {
  const scope = sprintScope(steps, n);
  const finished = [];
  for (const { sub, step } of scope) {
    if (sub.status !== 'Terminé') continue;
    const date = sub.done_date ?? step.done_date;
    if (date) finished.push({ date, min: sub.estimate_min || 0 });
    else console.warn(`sub-task ${sub.n} is Terminé without done_date, nor on its step: left out of the curve`);
  }
  const totalMin = sum(scope, (r) => r.sub.estimate_min);
  const points = [];
  for (let day = dayOf(start); day <= dayOf(end); day++) {
    const date = isoOf(day);
    const done = finished.filter((f) => f.date <= date);
    const doneMin = sum(done, (f) => f.min);
    points.push({
      x: day, date, done: done.length, base: scope.length,
      y: scope.length ? (done.length / scope.length) * 100 : 0,
      pctTime: totalMin ? (doneMin / totalMin) * 100 : 0,
    });
  }
  return points;
}

function computeStats(steps) {
  const count = (status) => steps.filter((s) => s.status === status).length;
  const counted = steps.filter((s) => s.status !== 'Plus tard');
  const stepsDone = counted.filter((s) => s.status === 'Terminé').length;
  const subs = counted.flatMap((s) => s.subtasks);
  const subsDone = subs.filter((s) => s.status === 'Terminé');
  const totalMin = sum(subs, (s) => s.estimate_min);
  const doneMin = sum(subsDone, (s) => s.estimate_min);
  const ratio = (a, b) => (b ? (a / b) * 100 : 0);
  return {
    total: steps.length,
    finished: count('Terminé'),
    doing: count('En cours'),
    todo: count('À faire'),
    later: count('Plus tard'),
    blocked: count('Bloqué'),
    pauseOrTbd: count('En pause') + count('À renseigner'),
    stepsBase: counted.length,
    stepsDone,
    pctSteps: ratio(stepsDone, counted.length),
    subsBase: subs.length,
    subsDone: subsDone.length,
    pctSubs: ratio(subsDone.length, subs.length),
    totalMin,
    doneMin,
    pctTime: ratio(doneMin, totalMin),
  };
}

// Least-squares line through (day, pct) points.
function regress(points) {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

// ---------- rendering ----------

function renderHeader(stats, info) {
  const legend = el('div', { class: 'legend' },
    ...Object.entries(STATUS_CLASS).map(([status]) => el('span', {}, dot(status), status)));
  return el('section', { class: 'card' },
    el('h1', {}, el('img', { src: 'favicon.svg', alt: '', width: '40', height: '40' }), 'Road map des projets Octopush'),
    el('p', { class: 'subtitle' }, `Version ${info.version ?? '?'}, mise à jour le ${info.date ?? '?'}`),
    el('p', { class: 'summary' },
      `${stats.finished} étapes terminées sur ${stats.total}, ${stats.doing} en cours, ${stats.todo} à faire, ` +
      `${stats.later} plus tard, ${stats.blocked} bloquée${stats.blocked > 1 ? 's' : ''}, ${stats.pauseOrTbd} à renseigner ou en pause`),
    legend);
}

function metric(title, big, detail, pct) {
  return el('div', { class: 'metric' },
    el('div', {}, title),
    el('div', { class: 'big' }, big),
    el('div', { class: 'bar' }, el('i', { style: `width:${Math.min(100, pct).toFixed(1)}%` })),
    el('div', { class: 'detail' }, detail));
}

// One fixed colour per sprint number (palette in style.css, cycling after 6): the same colour on the
// breadcrumb, the "Fait" list and the sprint card. No sprint = neutral grey "hors sprint".
const SPRINT_COLORS = 6;
function sprintBadge(n, text) {
  if (n == null) return el('span', { class: 'badge off-sprint' }, 'hors sprint');
  return el('span', { class: `badge sprint sprint-${((n - 1) % SPRINT_COLORS) + 1}` }, text ?? `Sprint ${n}`);
}

// Main card: progress of the current sprint, i.e. its sub-tasks (finished ones keep the sprint they were done in).
function renderGlobal(steps, sprint) {
  const subs = sprintScope(steps, sprint).map((r) => r.sub);
  const done = subs.filter((sub) => sub.status === 'Terminé');
  const totalMin = sum(subs, (sub) => sub.estimate_min);
  const doneMin = sum(done, (sub) => sub.estimate_min);
  const ratio = (a, b) => (b ? (a / b) * 100 : 0);
  const hours = (min) => formatMinutes(min).replace(':', ' h ') + ' min';
  const pctSubs = ratio(done.length, subs.length);
  const pctTime = ratio(doneMin, totalMin);
  return el('section', { class: 'card' },
    el('h2', { class: 'with-icon' }, el('img', { src: 'icon-progress.svg', alt: '', width: '28', height: '28' }),
      sprint ? `Sprint ${sprint}` : 'Avancement'),
    el('div', { class: 'metrics' },
      metric('En sous-tâches terminées', `${formatNumber(pctSubs, 1)} %`, `${done.length} sur ${subs.length}`, pctSubs),
      metric('En temps estimé', `${formatNumber(pctTime, 1)} %`,
        `${hours(doneMin)} faites sur ${hours(totalMin)}, reste ${hours(totalMin - doneMin)}`, pctTime)));
}

// Sprint breadcrumb: the current sprint and the 3 before it, each with its sub-task percentage.
// The left arrow slides the window 2 sprints into the past, the right arrow brings it back.
// Clicking a sprint selects it for the chart.
const WINDOW = 4;
const SLIDE = 2;
function renderBreadcrumb(steps, current) {
  const subsOf = (n) => sprintScope(steps, n).map((r) => r.sub);
  const sprints = [...new Set(steps.flatMap((s) => s.subtasks.map((sub) => subSprint(sub, s))).filter((n) => n != null))]
    .sort((a, b) => a - b);
  if (!sprints.length) return null;
  state.sprintOffset = Math.min(state.sprintOffset, Math.max(0, sprints.length - WINDOW));
  const end = sprints.length - state.sprintOffset;
  const start = Math.max(0, end - WINDOW);
  const selected = state.chartSprint ?? current;
  const arrow = (label, text, delta) => el('button', {
    class: 'crumb-arrow', type: 'button', 'data-shift': String(delta), title: label, 'aria-label': label,
  }, text);
  const items = sprints.slice(start, end).flatMap((n, index) => {
    const subs = subsOf(n);
    const pct = subs.length ? `${formatNumber((subs.filter((sub) => sub.status === 'Terminé').length / subs.length) * 100, 0)} %` : null;
    return [
      index ? el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›') : null,
      el('button', {
        class: 'crumb' + (n === selected ? ' selected' : ''), type: 'button', 'data-sprint': String(n),
        'aria-pressed': String(n === selected),
      }, sprintBadge(n, `S${n}`), pct ? el('span', { class: 'crumb-pct' }, pct) : null),
    ];
  });
  return el('nav', { class: 'card breadcrumb', 'aria-label': 'Sprints' },
    start > 0 ? arrow('Sprints plus anciens', '‹', SLIDE) : null,
    ...items,
    state.sprintOffset > 0 ? arrow('Sprints plus récents', '›', -SLIDE) : null);
}

// The curve is computed from the sub-tasks at each load: from the sprint's start to its end, or to today.
function renderChart(steps, sprint, sprintDates) {
  const card = el('section', { class: 'card chart' }, el('h2', {}, `Progression jour par jour, sprint ${sprint}`));
  const dates = sprintDates[sprint];
  const today = parisToday();
  if (!dates || dates.start > today) {
    card.append(el('p', { class: 'loading' }, dates ? 'Ce sprint n’a pas encore commencé.' : 'Date de début du sprint inconnue.'));
    return card;
  }
  const end = dates.end && dates.end < today ? dates.end : today;
  const points = sprintProgress(steps, sprint, dates.start, end);
  if (points.length === 0) {
    card.append(el('p', { class: 'loading' }, 'Dates du sprint invalides.'));
    return card;
  }

  const fit = regress(points);
  const last = points[points.length - 1];
  let projectedDay = null;
  if (fit && fit.slope > 0) {
    const day = (100 - fit.intercept) / fit.slope;
    if (day >= last.x && day - last.x < 3650) projectedDay = Math.ceil(day);
  }

  const W = 800, H = 300, L = 40, R = 16, T = 12, B = 28;
  const x0 = points[0].x;
  const x1 = Math.max(last.x, projectedDay ?? last.x, x0 + 1);
  const sx = (day) => L + ((day - x0) / (x1 - x0)) * (W - L - R);
  const sy = (pct) => T + (1 - pct / 100) * (H - T - B);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Courbe du pourcentage de sous-tâches terminées par jour');
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text != null) node.textContent = text;
    svg.append(node);
    return node;
  };

  // Y axis anchored at zero, one scale.
  for (const pct of [0, 25, 50, 75, 100]) {
    add('line', { class: 'grid', x1: L, x2: W - R, y1: sy(pct), y2: sy(pct) });
    add('text', { class: 'axis-label', x: L - 6, y: sy(pct) + 4, 'text-anchor': 'end' }, `${pct} %`);
  }
  add('text', { class: 'axis-label', x: L, y: H - 8, 'text-anchor': 'start' }, isoOf(x0));
  add('text', { class: 'axis-label', x: W - R, y: H - 8, 'text-anchor': 'end' }, isoOf(x1));

  if (projectedDay !== null) {
    add('line', { class: 'proj', x1: sx(last.x), y1: sy(last.y), x2: sx(projectedDay), y2: sy(100) });
  }
  add('polyline', { class: 'line', points: points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ') });

  const tooltip = document.getElementById('tooltip');
  for (const p of points) {
    const circle = add('circle', { class: 'pt', cx: sx(p.x), cy: sy(p.y), r: 5 });
    const text = `${p.date} : ${formatNumber(p.y, 1)} % (${p.done} sur ${p.base}), ${formatNumber(p.pctTime, 1)} % en temps`;
    circle.addEventListener('mousemove', (event) => {
      tooltip.hidden = false;
      tooltip.textContent = text;
      tooltip.style.left = event.clientX + 12 + 'px';
      tooltip.style.top = event.clientY + 12 + 'px';
    });
    circle.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }
  card.append(svg);

  let forecast;
  if (projectedDay !== null) {
    forecast = `Au rythme actuel (${formatNumber(fit.slope, 2)} point par jour), 100 % serait atteint le ${isoOf(projectedDay)}`;
  } else {
    forecast = 'projection impossible pour l’instant';
  }
  card.append(el('p', { class: 'forecast' }, forecast));
  return card;
}

// Parent step shown in small text under a sub-task label.
const parentLabel = (step) => `étape ${step.num} · ${step.step}`;

// "Liste du ...": the latest list present in the file (greatest today_date), finished sub-tasks
// included, in `today` order. It never disappears when the date changes: only the file's author
// starts a new list. The `today` number is shown as is, never renumbered.
function renderToday(steps) {
  // A task is a sub-task, or a whole step that carries today / today_date itself (a step without
  // sub-task): that step then stands in for its own sub-task and shows no parent line.
  const dated = steps.flatMap((step) => [
    ...step.subtasks.filter((s) => s.today != null && s.today_date).map((sub) => ({ sub, step })),
    ...(step.today != null && step.today_date ? [{
      sub: {
        today: step.today, today_date: step.today_date, status: step.status,
        estimate_min: step.load, label: step.step, n: step.num, owner: step.owner,
      },
      step,
      isStep: true,
    }] : []),
  ]);
  const listDate = dated.reduce((max, r) => (r.sub.today_date > max ? r.sub.today_date : max), '');
  const rows = dated
    .filter((r) => r.sub.today_date === listDate)
    .sort((a, b) => a.sub.today - b.sub.today);
  const totalMin = sum(rows, (r) => r.sub.estimate_min);
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ...['N°', 'Statut', 'Temps', 'Tâche', 'Qui'].map((t) => el('th', {}, t)))),
    el('tbody', {}, ...rows.map(({ sub, step, isStep }) => el('tr', { class: sub.status === 'Terminé' ? 'finished' : '' },
      el('td', { class: 'num' }, sub.today),
      el('td', { class: 'status' }, statusCell(sub.status)),
      el('td', { class: 'time' }, bracketTime(sub.estimate_min)),
      el('td', {}, el('span', { class: 'sub-n' }, `#${sub.n}`), ' ', sub.label,
        isStep ? null : el('div', { class: 'parent' }, parentLabel(step))),
      el('td', {}, sub.owner)))));
  return el('section', { class: 'card' },
    el('h2', {}, listDate ? `Liste du ${listDate}` : 'Liste du jour'),
    rows.length ? table : el('p', { class: 'loading' }, 'Aucune liste du jour pour l’instant.'),
    el('p', { class: 'total' }, `Temps total : ${formatMinutes(totalMin)}`));
}

function stepRows(step) {
  const rows = [];
  const hasSubtasks = step.subtasks.length > 0;
  let numCell;
  let remaining = step.remaining;
  if (hasSubtasks) {
    const done = step.subtasks.filter((s) => s.status === 'Terminé').length;
    const open = state.openSteps.has(step.id);
    numCell = el('button', {
      class: 'toggle', type: 'button', 'data-id': step.id, 'aria-expanded': String(open),
      title: 'Afficher ou masquer les sous-tâches',
    }, step.num);
    remaining = `[${done}/${step.subtasks.length}] ${step.remaining}`;
  } else {
    numCell = document.createTextNode(step.num);
  }
  rows.push(el('tr', { class: step.status === 'Terminé' ? 'finished' : '' },
    el('td', { class: 'num' }, numCell),
    el('td', { class: 'status' }, statusCell(step.status)),
    el('td', { class: 'time' }, bracketTime(step.load)),
    el('td', {}, step.step),
    el('td', {}, remaining),
    el('td', {}, step.owner)));
  if (hasSubtasks) {
    const sub = el('tr', { class: 'subtasks', 'data-sub': step.id },
      el('td', { colspan: '6' },
        el('ul', {}, ...step.subtasks.map((s) => el('li', { class: s.status === 'Terminé' ? 'finished' : '' },
          el('span', { class: 'sub-status' }, statusCell(s.status)),
          el('span', { class: 'sub-time' }, bracketTime(s.estimate_min)),
          el('span', {}, `${s.n} · ${s.label}`))))));
    sub.hidden = !state.openSteps.has(step.id);
    rows.push(sub);
  }
  return rows;
}

// Milestones: one row each, in file order. An empty "steps" list means "every step no other
// milestone lists". The percentage is finished sub-tasks over all sub-tasks of those steps.
function renderMilestones(milestones, steps) {
  if (!milestones.length) return null;
  const listed = new Set(milestones.flatMap((m) => m.steps ?? []));
  // Resolve each milestone first: one whose steps are all Terminé is closed whatever its status field
  // says, dated by the latest done_date of those steps. A milestone without steps is never auto-closed.
  const resolved = milestones.map((m) => {
    const wanted = m.steps ?? [];
    const group = wanted.length
      ? steps.filter((s) => wanted.includes(s.num))
      : steps.filter((s) => !listed.has(s.num));
    const allDone = wanted.length > 0 && group.length > 0 && group.every((s) => s.status === 'Terminé');
    const doneDate = group.reduce((max, s) => ((s.done_date ?? '') > max ? s.done_date : max), '');
    return {
      m: allDone ? { ...m, status: 'Terminé', date: doneDate || m.date } : m,
      group,
    };
  });
  // Open milestones first, finished ones after (stable sort keeps the file order inside each group).
  const isDone = (m) => m.status === 'Terminé';
  const ordered = [...resolved].sort((a, b) => Number(isDone(a.m)) - Number(isDone(b.m)));
  const rows = ordered.map(({ m, group }) => {
    const subs = group.flatMap((s) => s.subtasks);
    const done = subs.filter((s) => s.status === 'Terminé').length;
    const pct = subs.length ? (done / subs.length) * 100 : 0;
    return el('tr', { class: isDone(m) ? 'milestone-done' : '' },
      el('td', {}, m.name),
      el('td', {}, statusCell(m.status)),
      el('td', { class: 'time' }, isDone(m) && m.date ? `terminé le ${m.date}` : (m.date || '')),
      el('td', { class: 'time' }, subs.length ? `${formatNumber(pct, 0)} %` : '—'),
      el('td', { class: 'time' }, `${done} / ${subs.length}`));
  });
  return el('section', { class: 'card milestones' },
    el('h2', {}, 'Milestones'),
    el('table', {},
      el('thead', {}, el('tr', {}, ...['Milestone', 'Statut', 'Date', 'Avancement', 'Tâches'].map((t) => el('th', {}, t)))),
      el('tbody', {}, ...rows)));
}

// A project whose steps are all finished: closing date = latest done_date, effort = sum of estimates.
function closedInfo(group) {
  if (!group.length || !group.every((s) => s.status === 'Terminé')) return null;
  const date = group.reduce((max, s) => ((s.done_date ?? '') > max ? s.done_date : max), '');
  return { date, hours: Math.round(sum(group, (s) => s.load) / 60) };
}

// "Sprints 1, 2": union of the sprints of the project's steps, plain muted text (no badge).
function sprintsLabel(group) {
  const sprints = [...new Set(group.flatMap(stepSprints))].sort((a, b) => a - b);
  if (!sprints.length) return null;
  return el('span', { class: 'sprints' }, `${sprints.length > 1 ? 'Sprints' : 'Sprint'} ${sprints.join(', ')}`);
}

function closedBadge(closed) {
  if (!closed) return null;
  return el('span', { class: 'badge closed' },
    `terminé${closed.date ? ` le ${closed.date}` : ''} en ~${closed.hours} h estimées`);
}

function renderProjects(projects, steps) {
  // Two independent columns (projects alternate between them), so an open accordion never
  // pushes down its neighbour. The CSS "order" keeps the reading order on a single column.
  const columns = [el('div', { class: 'col' }), el('div', { class: 'col' })];
  const grid = el('div', { class: 'projects' }, ...columns);
  const groupOf = (project) => steps.filter((s) => s.project_id === project.id).sort((a, b) => a.step_order - b.step_order);
  // Finished projects go last; the stable sort keeps the file order inside each group.
  const ordered = projects.map((project) => ({ project, group: groupOf(project) }))
    .sort((a, b) => Number(!!closedInfo(a.group)) - Number(!!closedInfo(b.group)));
  ordered.forEach(({ project, group }, index) => {
    const closed = closedInfo(group);
    const done = group.filter((s) => s.status === 'Terminé').length;
    const pct = group.length ? (done / group.length) * 100 : 0;
    // Accordion: the summary (title, count, progress bar) stays visible when collapsed.
    const accordion = el('details', { class: 'card project', 'data-project': project.id },
      el('summary', {},
        el('div', { class: 'project-head' }, el('h2', {}, project.name, sprintsLabel(group), closedBadge(closed)),
          el('span', {}, `${done} / ${group.length} terminées`)),
        el('div', { class: 'bar' }, el('i', { style: `width:${pct.toFixed(1)}%` }))),
      el('table', {},
        el('thead', {}, el('tr', {}, ...['N°', 'Statut', 'Temps', 'Étape', 'Reste à faire', 'Qui'].map((t) => el('th', {}, t)))),
        el('tbody', {}, ...group.flatMap(stepRows))));
    accordion.open = state.openProjects.has(project.id);
    accordion.style.order = index;
    columns[index % 2].append(accordion);
  });
  return grid;
}

// "Fait" section: every finished sub-task, newest first. A missing done_date is shown as
// "non datée" at the end of the list, without any error banner.
// A finished sub-task without a date shows its step's closing date; its sprint sits next to it.
function doneDateCell(sub, step) {
  const date = sub.done_date ?? step.done_date;
  const text = date ? ((sub.done_date_est || step.done_date_est) ? '≈ ' : '') + date : 'non datée';
  const sprint = subSprint(sub, step);
  return [text, sprintBadge(sprint, sprint != null ? `S${sprint}` : null)];
}

function renderDone(steps) {
  const finished = steps.flatMap((step) => step.subtasks.filter((s) => s.status === 'Terminé').map((sub) => ({ sub, step })));
  const byNumberDesc = (a, b) => compareNumbers(b.sub.n, a.sub.n);
  const dateOf = (r) => r.sub.done_date ?? r.step.done_date;
  const dated = finished.filter((r) => dateOf(r))
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || byNumberDesc(a, b));
  const undated = finished.filter((r) => !dateOf(r)).sort(byNumberDesc);
  const rows = [...dated, ...undated].map(({ sub, step }) => el('tr', {},
    el('td', { class: 'time' }, ...doneDateCell(sub, step)),
    el('td', { class: 'num' }, sub.n),
    el('td', {}, sub.label, el('div', { class: 'parent' }, parentLabel(step)))));
  const details = el('details', { class: 'card project', 'data-project': 'done-section' },
    el('summary', {},
      el('div', { class: 'project-head' }, el('h2', {}, `Fait (${finished.length} sous-tâches)`))),
    el('table', {},
      el('thead', {}, el('tr', {}, ...['Date', 'N°', 'Intitulé'].map((t) => el('th', {}, t)))),
      el('tbody', {}, ...rows)));
  details.open = state.openProjects.has('done-section');
  return details;
}

function render() {
  const model = buildModel(state.data.global);
  const stats = computeStats(model.steps);
  const app = document.getElementById('app');
  app.replaceChildren(...[
    renderBreadcrumb(model.steps, model.sprint),
    el('div', { class: 'top-row' }, renderHeader(stats, model.info), renderGlobal(model.steps, model.sprint)),
    renderChart(model.steps, state.chartSprint ?? model.sprint, model.sprintDates),
    renderToday(model.steps),
    renderProjects(model.projects, model.steps),
    renderMilestones(model.milestones, model.steps),
    renderDone(model.steps)].filter(Boolean));
}

// Sub-task toggles: delegated, and the open set survives the periodic re-render.
document.addEventListener('click', (event) => {
  const crumb = event.target.closest('button.crumb, button.crumb-arrow');
  if (crumb) {
    if (crumb.dataset.sprint) state.chartSprint = Number(crumb.dataset.sprint);
    else state.sprintOffset = Math.max(0, state.sprintOffset + Number(crumb.dataset.shift));
    render();
    return;
  }
  const button = event.target.closest('button.toggle');
  if (!button) return;
  const id = button.dataset.id;
  const open = !state.openSteps.has(id);
  if (open) state.openSteps.add(id); else state.openSteps.delete(id);
  button.setAttribute('aria-expanded', String(open));
  const row = [...document.querySelectorAll('tr[data-sub]')].find((r) => r.dataset.sub === id);
  if (row) row.hidden = !open;
});

// The 'toggle' event does not bubble, so listen in the capture phase to remember open accordions.
document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.dataset.project) return;
  if (details.open) state.openProjects.add(details.dataset.project);
  else state.openProjects.delete(details.dataset.project);
}, true);

refresh();
setInterval(refresh, REFRESH_MS);
