'use strict';

// Road map page: reads four JSON files written by another assistant and renders them.
// Static page, no framework. All data is inserted with textContent (never innerHTML).

const REFRESH_MS = 30000;
const FILES = ['roadmap', 'today', 'history', 'info'];

// Optional ?data=<folder> lets a test copy of the data be served (never C's real files).
const dataParam = new URLSearchParams(location.search).get('data');
const DATA_DIR = /^[\w-]+$/.test(dataParam || '') ? dataParam : 'data';

const STATUS_CLASS = {
  'Terminé': 'done',
  'En cours': 'doing',
  'À faire': 'todo',
  'En pause': 'pause',
  'Plus tard': 'later',
  'À renseigner': 'tbd',
};

const state = {
  data: {},          // last valid version of each file
  signature: {},     // JSON text of the last valid version, to skip needless re-renders
  failingSince: {},  // file name -> Date of the first failure in the current streak
  openSteps: new Set(),
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

function formatNumber(value, digits) {
  return value.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

const DAY_MS = 86400000;
const dayOf = (isoDate) => Date.parse(isoDate + 'T00:00:00Z') / DAY_MS;
const isoOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// ---------- loading ----------

async function loadFile(name) {
  const response = await fetch(`${DATA_DIR}/${name}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const parsed = JSON.parse(await response.text());
  if (!Array.isArray(parsed)) throw new Error('not a list');
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
  // Render as soon as the main file is valid; a missing secondary file shows as an empty section.
  if (changed && state.data.roadmap) render();
}

function showBanner() {
  const banner = document.getElementById('banner');
  const messages = Object.entries(state.failingSince)
    .map(([name, since]) => `fichier ${name}.json illisible depuis ${clock(since)}`);
  banner.hidden = messages.length === 0;
  banner.textContent = messages.join(' · ');
}

// ---------- computations ----------

function computeStats(steps) {
  const count = (status) => steps.filter((s) => s.status === status).length;
  const counted = steps.filter((s) => s.status !== 'Plus tard');
  const done = counted.filter((s) => s.status === 'Terminé').length;
  const totalMin = counted.reduce((sum, s) => sum + (s.estimate_min || 0), 0);
  const doneMin = counted.reduce((sum, s) => sum + (s.estimate_min || 0) * (s.progress || 0), 0);
  return {
    total: steps.length,
    finished: count('Terminé'),
    doing: count('En cours'),
    todo: count('À faire'),
    later: count('Plus tard'),
    pauseOrTbd: count('En pause') + count('À renseigner'),
    base: counted.length,
    done,
    pctSteps: counted.length ? (done / counted.length) * 100 : 0,
    totalMin,
    doneMin,
    pctTime: totalMin ? (doneMin / totalMin) * 100 : 0,
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
  const latest = info[info.length - 1] || {};
  const legend = el('div', { class: 'legend' },
    ...Object.entries(STATUS_CLASS).map(([status]) => el('span', {}, dot(status), status)));
  return el('section', { class: 'card' },
    el('h1', {}, 'Road map des projets'),
    el('p', { class: 'subtitle' }, `Version ${latest.version ?? '?'}, mise à jour le ${latest.date ?? '?'}`),
    el('p', { class: 'summary' },
      `${stats.finished} étapes terminées sur ${stats.total}, ${stats.doing} en cours, ${stats.todo} à faire, ` +
      `${stats.later} plus tard, ${stats.pauseOrTbd} à renseigner ou en pause`),
    legend);
}

function metric(title, big, detail, pct) {
  return el('div', { class: 'metric' },
    el('div', {}, title),
    el('div', { class: 'big' }, big),
    el('div', { class: 'bar' }, el('i', { style: `width:${Math.min(100, pct).toFixed(1)}%` })),
    el('div', { class: 'detail' }, detail));
}

function renderGlobal(stats) {
  const hours = (min) => formatMinutes(min).replace(':', ' h ') + ' min';
  return el('section', { class: 'card' },
    el('h2', {}, 'Avancement global (hors « Plus tard »)'),
    el('div', { class: 'metrics' },
      metric('En étapes terminées', `${formatNumber(stats.pctSteps, 1)} %`,
        `${stats.done} sur ${stats.base}`, stats.pctSteps),
      metric('En temps estimé', `${formatNumber(stats.pctTime, 1)} %`,
        `${hours(stats.doneMin)} faites sur ${hours(stats.totalMin)}, reste ${hours(stats.totalMin - stats.doneMin)}`,
        stats.pctTime)));
}

function renderChart(history) {
  const card = el('section', { class: 'card chart' }, el('h2', {}, 'Progression jour par jour'));
  const points = history
    .map((h) => ({ x: dayOf(h.date), y: h.pct, h }))
    .sort((a, b) => a.x - b.x);
  if (points.length === 0) return card;

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
  svg.setAttribute('aria-label', 'Courbe du pourcentage d’étapes terminées par jour');
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
    const text = `${p.h.date} : ${formatNumber(p.y, 1)} % (${p.h.done} sur ${p.h.base})`;
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
    forecast = 'Projection à 100 % indisponible : la tendance n’est pas à la hausse.';
  }
  card.append(el('p', { class: 'forecast' }, forecast));
  return card;
}

function renderToday(today) {
  const rows = [...today].sort((a, b) => a.rank - b.rank);
  const totalMin = rows.reduce((sum, r) => sum + (r.estimate_min || 0), 0);
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ...['N°', 'Statut', 'Temps', 'Tâche', 'Qui'].map((t) => el('th', {}, t)))),
    el('tbody', {}, ...rows.map((r) => el('tr', { class: r.status === 'Terminé' ? 'finished' : '' },
      el('td', { class: 'num' }, r.rank),
      el('td', { class: 'status' }, statusCell(r.status)),
      el('td', { class: 'time' }, r.temps),
      el('td', {}, r.task),
      el('td', {}, r.owner)))));
  return el('section', { class: 'card' },
    el('h2', {}, 'Liste du jour'),
    table,
    el('p', { class: 'total' }, `Temps total : ${formatMinutes(totalMin)}`));
}

function subtaskCounts(step) {
  const list = step.subtasks || [];
  const total = step.subtasks_total ?? list.length;
  const done = step.subtasks_done ?? list.filter((s) => s.status === 'Terminé').length;
  return { done, total };
}

function stepRows(step) {
  const rows = [];
  const hasSubtasks = Array.isArray(step.subtasks) && step.subtasks.length > 0;
  let numCell;
  let remaining = step.remaining;
  if (hasSubtasks) {
    const { done, total } = subtaskCounts(step);
    const open = state.openSteps.has(step.id);
    numCell = el('button', {
      class: 'toggle', type: 'button', 'data-id': step.id, 'aria-expanded': String(open),
      title: 'Afficher ou masquer les sous-tâches',
    }, step.num);
    remaining = `[${done}/${total}] ${step.remaining}`;
  } else {
    numCell = document.createTextNode(step.num);
  }
  rows.push(el('tr', { class: step.status === 'Terminé' ? 'finished' : '' },
    el('td', { class: 'num' }, numCell),
    el('td', { class: 'status' }, statusCell(step.status)),
    el('td', { class: 'time' }, step.temps),
    el('td', {}, step.step),
    el('td', {}, remaining),
    el('td', {}, step.owner)));
  if (hasSubtasks) {
    const sub = el('tr', { class: 'subtasks', 'data-sub': step.id },
      el('td', { colspan: '6' },
        el('ul', {}, ...step.subtasks.map((s) => el('li', { class: s.status === 'Terminé' ? 'finished' : '' },
          dot(s.status), `${s.n} · ${s.label}`)))));
    sub.hidden = !state.openSteps.has(step.id);
    rows.push(sub);
  }
  return rows;
}

function renderProjects(steps) {
  const groups = new Map();
  for (const step of steps) {
    if (!groups.has(step.project_id)) groups.set(step.project_id, []);
    groups.get(step.project_id).push(step);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0].project_order - b[0].project_order);
  const grid = el('div', { class: 'projects' });
  for (const group of ordered) {
    group.sort((a, b) => a.step_order - b.step_order);
    const done = group.filter((s) => s.status === 'Terminé').length;
    const pct = (done / group.length) * 100;
    grid.append(el('section', { class: 'card' },
      el('div', { class: 'project-head' }, el('h2', {}, group[0].project), el('span', {}, `${done} / ${group.length} terminées`)),
      el('div', { class: 'bar' }, el('i', { style: `width:${pct.toFixed(1)}%` })),
      el('table', {},
        el('thead', {}, el('tr', {}, ...['N°', 'Statut', 'Temps', 'Étape', 'Reste à faire', 'Qui'].map((t) => el('th', {}, t)))),
        el('tbody', {}, ...group.flatMap(stepRows)))));
  }
  return grid;
}

function render() {
  const { roadmap } = state.data;
  const today = state.data.today ?? [];
  const history = state.data.history ?? [];
  const info = state.data.info ?? [];
  const stats = computeStats(roadmap);
  const app = document.getElementById('app');
  app.replaceChildren(
    renderHeader(stats, info),
    renderGlobal(stats),
    renderChart(history),
    renderToday(today),
    renderProjects(roadmap));
}

// Sub-task toggles: delegated, and the open set survives the periodic re-render.
document.addEventListener('click', (event) => {
  const button = event.target.closest('button.toggle');
  if (!button) return;
  const id = button.dataset.id;
  const open = !state.openSteps.has(id);
  if (open) state.openSteps.add(id); else state.openSteps.delete(id);
  button.setAttribute('aria-expanded', String(open));
  const row = [...document.querySelectorAll('tr[data-sub]')].find((r) => r.dataset.sub === id);
  if (row) row.hidden = !open;
});

refresh();
setInterval(refresh, REFRESH_MS);
