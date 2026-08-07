/* Life Dashboard front-end. Fetches /api/data and renders everything. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => { const [, m, d] = iso.split('-'); return `${+m}/${+d}`; };
const attr = (obj) => Object.entries(obj).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');

// ---------- tooltip ----------
const tip = $('tooltip');
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tt]');
  if (!el) { tip.style.display = 'none'; return; }
  tip.innerHTML = el.getAttribute('data-tt');
  tip.style.display = 'block';
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
});

function tt(title, rows) {
  return esc(`<div class="tt-title">${title}</div>` + rows.map((r) => `<div class="tt-row">${r}</div>`).join(''));
}

// ---------- boot ----------
let STATUS = null;
async function boot() {
  STATUS = await (await fetch('/api/status')).json();
  if (STATUS.loginRequired) {
    $('login').style.display = 'flex';
    document.querySelector('.topbar').style.display = 'none';
    document.querySelector('.wrap').style.display = 'none';
    return;
  }
  renderAuthArea();
  setupDataPage();
  setupReportPage();
  setupGoalsPage();
  setupSocialPage();
  setupDrawer();
  hydrateWidgetState();
  renderWidgetMenu();
  applyWidgets();
  applyWidgetOrder();
  initDragAndDrop();
  const res = await fetch('/api/data');
  const data = await res.json();
  if (data.error) { $('errors').textContent = 'Failed to build dashboard: ' + data.error; return; }

  window.APP_DATA = data; // parsed sources, reused for tag suggestions etc.
  NEEDS_SETUP = !!data.needsSetup;
  const loggedDays = Math.max(data.habits.days.length, data.journal.length);
  NEEDS_DATA = loggedDays === 0;
  THIN_DATA = loggedDays > 0 && loggedDays < 3;

  // Always land on the widget dashboard; banners handle any setup nudges
  showView('dashboard');

  if (NEEDS_DATA) {
    emptyCoach('coach', 'Daily Coach', NEEDS_SETUP
      ? 'Connect your Sheet and Doc, and today\'s plan shows up here.'
      : 'Nothing logged yet — the coach starts once there\'s a day to read.');
    emptyCoach('weekly-coach', 'Weekly Coach', NEEDS_SETUP
      ? 'Connect your data to get weekly goals.'
      : 'No logged days yet, so there\'s nothing to set goals against.');
  } else {
    loadCoach(false);
    loadWeeklyCoach(false);
  }
  render(data);
}

// Light-red bar shown on every page while a source link is missing — the app
// still runs on whatever is connected, but both links are strongly encouraged.
function renderMissingBanner(missing, needsConfirm) {
  const el = $('missing-banner');
  el.classList.remove('confirm');
  if (!missing.length && needsConfirm) {
    // Links work, parse just never got a thumbs-up — gentle amber nudge
    el.classList.add('confirm');
    el.innerHTML = `👀 <b>Quick check:</b> I'm reading your Sheet + Doc — take 20 seconds to confirm it parsed right.
      <button onclick="showView('data');runPreview()">Check my data</button>
      <button title="Dismiss" onclick="fetch('/api/confirm-data',{method:'POST'});this.parentNode.style.display='none'">✕</button>`;
    el.style.display = '';
    return;
  }
  // Both missing -> the green welcome banner owns that case; red bar is only
  // for the "one link short" state.
  if (missing.length !== 1) { el.style.display = 'none'; return; }
  const msgs = {
    sheet: `<b>No habit-tracker Sheet linked.</b> Habits, streaks, and half of what the coach knows are missing — journal-only for now.`,
    doc: `<b>No journal Doc linked.</b> Day scores, people, activities and bedtimes are missing — habits-only for now.`,
  };
  el.innerHTML = `⚠️ ${msgs[missing[0]]}
    <button onclick="showView('data')">Link it in 🔗 Data</button>`;
  el.style.display = '';
}

// State that empty-state rendering keys off
let NEEDS_SETUP = false;
let NEEDS_DATA = false;
let THIN_DATA = false;

function emptyCoach(id, title, msg) {
  $(id).innerHTML = `<h2>${esc(title)}</h2>
    <div class="empty-state"><span class="es-emoji">🌱</span>${esc(msg)}</div>`;
}

// Every widget routes through this so a fresh account never shows a broken chart
function emptyState(el, msg, emoji) {
  const node = typeof el === 'string' ? $(el) : el;
  if (node) node.innerHTML = `<div class="empty-state"><span class="es-emoji">${emoji || '—'}</span>${esc(msg)}</div>`;
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

// ---------- widget drawer ----------
const WIDGETS = [
  ['coach', 'Daily Coach'],
  ['weekly-coach', 'Weekly Coach'],
  ['kpis', 'KPI tiles'],
  ['rhythm', 'Day scores & completion'],
  ['today', 'Latest day'],
  ['heatmap', 'Habit heatmap'],
  ['habit-bars', 'Habit completion'],
  ['impact', 'What makes a good day'],
  ['people', 'People'],
  ['places', 'Places'],
  ['sleep', 'Sleep'],
  ['plant', '🌱 Sessions'],
  ['wins', 'Wins'],
  ['focus', 'Focus next'],
  ['weekdays', 'Weekday rhythm'],
  ['activities', 'Activity leaderboard'],
];

let COACH = null;

function widgetPrefs() {
  try { return JSON.parse(localStorage.getItem('widgets')) || {}; } catch { return {}; }
}
function widgetMode() { return localStorage.getItem('widgetMode') || 'suggested'; }
function setWidgetMode(m) {
  localStorage.setItem('widgetMode', m);
  renderWidgetMenu();
  applyWidgets();
  syncWidgetState();
}

// Always part of the suggested set, whatever the coach says
const FORCED_SUGGESTED = ['coach', 'weekly-coach', 'kpis', 'rhythm', 'today'];

function suggestedOverrides() {
  try { return JSON.parse(localStorage.getItem('suggestedOverrides')) || {}; } catch { return {}; }
}

// What the coach (plus the forced core) proposes, before user overrides
function suggestionSet() {
  if (COACH && Array.isArray(COACH.widgets) && COACH.widgets.length) {
    return new Set([...FORCED_SUGGESTED, ...COACH.widgets]);
  }
  return null; // coach not loaded yet -> show everything
}

// null = show everything
function visibleWidgets() {
  if (widgetMode() === 'suggested') {
    const base = suggestionSet();
    if (!base) return null;
    const overrides = suggestedOverrides();
    for (const [id, on] of Object.entries(overrides)) {
      if (on) base.add(id); else base.delete(id);
    }
    return base;
  }
  const prefs = widgetPrefs();
  return new Set(WIDGETS.map(([id]) => id).filter((id) => prefs[id] !== false));
}

function applyWidgets() {
  const vis = visibleWidgets();
  document.querySelectorAll('[data-widget]').forEach((el) => {
    const id = el.getAttribute('data-widget');
    el.style.display = !vis || vis.has(id) ? '' : 'none';
  });
}

function renderWidgetMenu() {
  const mode = widgetMode();
  $('mode-suggested').classList.toggle('active', mode === 'suggested');
  $('mode-custom').classList.toggle('active', mode === 'custom');
  $('mode-suggested').onclick = () => setWidgetMode('suggested');
  $('mode-custom').onclick = () => setWidgetMode('custom');
  $('mode-note').textContent = mode === 'suggested'
    ? 'The Daily Coach proposes a set each day (✨) — you can still toggle anything on top.'
    : 'Pick exactly what shows on your dashboard.';

  const menu = $('widget-menu');
  const prefs = widgetPrefs();
  const sugg = suggestionSet();
  const vis = visibleWidgets();
  menu.innerHTML = WIDGETS.map(([id, label]) => {
    const checked = mode === 'suggested' ? (!vis || vis.has(id)) : prefs[id] !== false;
    const badge = mode === 'suggested' && sugg && sugg.has(id) ? '<span class="sugg-badge">✨ today</span>' : '';
    return `<label><input type="checkbox" data-w="${id}" ${checked ? 'checked' : ''}> ${esc(label)}${badge}</label>`;
  }).join('');
  menu.querySelectorAll('input').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.getAttribute('data-w');
      if (widgetMode() === 'suggested') {
        const o = suggestedOverrides();
        const base = suggestionSet();
        // store an override only where it differs from the suggestion
        if (base && base.has(id) === cb.checked) delete o[id];
        else o[id] = cb.checked;
        localStorage.setItem('suggestedOverrides', JSON.stringify(o));
      } else {
        const p = widgetPrefs();
        p[id] = cb.checked;
        localStorage.setItem('widgets', JSON.stringify(p));
      }
      applyWidgets();
      syncWidgetState();
    };
  });
}

// ---------- drag & drop reordering ----------
// Widgets keep their width (span classes); dragging the ⠿ handle moves them
// anywhere in the grid. Order persists per browser.

// ---------- widget state persistence (Mongo, cross-device) ----------
// The server copy is hydrated on boot and updated (debounced) on every
// change; the coach reads it to bias tomorrow's suggested widgets.

function hydrateWidgetState() {
  const ws = STATUS && STATUS.widgetState;
  if (!ws) return;
  if (ws.mode) localStorage.setItem('widgetMode', ws.mode);
  if (Array.isArray(ws.order)) localStorage.setItem('widgetOrder', JSON.stringify(ws.order));
  if (ws.prefs) localStorage.setItem('widgets', JSON.stringify(ws.prefs));
  if (ws.suggestedOverrides) localStorage.setItem('suggestedOverrides', JSON.stringify(ws.suggestedOverrides));
}

let syncTimer = null;
function syncWidgetState() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    let order = null;
    try { order = JSON.parse(localStorage.getItem('widgetOrder')); } catch {}
    const vis = visibleWidgets();
    fetch('/api/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: widgetMode(),
        order,
        prefs: widgetPrefs(),
        suggestedOverrides: suggestedOverrides(),
        lastVisible: vis ? [...vis] : WIDGETS.map(([id]) => id),
      }),
    }).catch(() => {});
  }, 600);
}

// Hide a widget from the ✕ button — same store the drawer uses, so it can
// always be brought back from ⚙︎ Widgets.
function hideWidget(id) {
  if (widgetMode() === 'suggested') {
    const o = suggestedOverrides();
    o[id] = false;
    localStorage.setItem('suggestedOverrides', JSON.stringify(o));
  } else {
    const p = widgetPrefs();
    p[id] = false;
    localStorage.setItem('widgets', JSON.stringify(p));
  }
  renderWidgetMenu();
  applyWidgets();
  syncWidgetState();
}

function applyWidgetOrder() {
  let order;
  try { order = JSON.parse(localStorage.getItem('widgetOrder')); } catch { order = null; }
  if (!Array.isArray(order)) return;
  const grid = document.querySelector('.grid');
  const cards = new Map([...grid.querySelectorAll(':scope > [data-widget]')]
    .map((el) => [el.getAttribute('data-widget'), el]));
  for (const id of order) {
    const el = cards.get(id);
    if (el) grid.appendChild(el);
  }
}

function saveWidgetOrder() {
  const ids = [...document.querySelectorAll('.grid > [data-widget]')]
    .map((el) => el.getAttribute('data-widget'));
  localStorage.setItem('widgetOrder', JSON.stringify(ids));
  syncWidgetState();
}

// Re-runnable: renderers that wipe a widget's innerHTML (like the KPI block)
// lose their buttons, so this re-attaches anything missing.
function ensureWidgetControls() {
  const grid = document.querySelector('.grid');
  grid.querySelectorAll(':scope > [data-widget]').forEach((card) => {
    if (card.querySelector(':scope > .drag-handle')) return;
    const id = card.getAttribute('data-widget');
    const closer = document.createElement('button');
    closer.className = 'widget-x';
    closer.title = 'Hide this widget (bring it back in ⚙︎ Widgets)';
    closer.textContent = '✕';
    closer.onclick = () => hideWidget(id);
    card.appendChild(closer);
    const handle = document.createElement('button');
    handle.className = 'drag-handle';
    handle.title = 'Drag to move';
    handle.textContent = '⠿';
    card.appendChild(handle);
    if (card.dataset.dndBound) return;
    card.dataset.dndBound = '1';
    // Whole card is draggable; drags starting on interactive elements are
    // cancelled so checks, ✗s, buttons, and inputs still work normally.
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      const interactive = e.target.closest && e.target.closest('button, a, input, select, textarea, .todo');
      if (interactive && !e.target.closest('.drag-handle')) { e.preventDefault(); return; }
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', id); } catch {}
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      saveWidgetOrder();
    });
  });
}

let dndInit = false;
function initDragAndDrop() {
  ensureWidgetControls();
  if (dndInit) return;
  dndInit = true;
  const grid = document.querySelector('.grid');
  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = grid.querySelector(':scope > .dragging');
    if (!dragging) return;
    const target = e.target.closest('.grid > [data-widget]');
    if (!target || target === dragging) return;
    const r = target.getBoundingClientRect();
    const relY = (e.clientY - r.top) / r.height;
    // top third = before, bottom third = after, middle = decide by x (for side-by-side cards)
    const before = relY < 0.35 ? true : relY > 0.65 ? false : e.clientX < r.left + r.width / 2;
    grid.insertBefore(dragging, before ? target : target.nextSibling);
  });
  grid.addEventListener('drop', (e) => e.preventDefault());
}

function setupDrawer() {
  const open = (v) => {
    $('drawer').classList.toggle('open', v);
    $('drawer-backdrop').classList.toggle('open', v);
  };
  $('settings-btn').onclick = () => open(true);
  $('drawer-close').onclick = () => open(false);
  $('drawer-backdrop').onclick = () => open(false);
}

// ---------- coach ----------
async function loadCoach(refresh) {
  const el = $('coach');
  el.innerHTML = `<h2>Daily Coach</h2><div class="coach-loading">${refresh ? 'Rethinking today' : 'Thinking about your day'}<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
  try {
    const res = await fetch('/api/coach' + (refresh ? '?refresh=1' : ''));
    const c = await res.json();
    if (c.error || !Array.isArray(c.todos)) {
      el.innerHTML = `<h2>Daily Coach</h2><p class="note">Coach unavailable: ${esc(c.error || 'unexpected response — try refreshing the page')}</p>`;
      return;
    }
    COACH = c;
    renderCoach();
    renderWidgetMenu();
    applyWidgets();
  } catch (e) {
    el.innerHTML = `<h2>Daily Coach</h2><p class="note">Coach unavailable: ${esc(e.message)}</p>`;
  }
}

function renderCoach(justCheckedIdx = -1) {
  const c = COACH;
  const done = (c.checked || []).filter(Boolean).length;
  let html = `<h2>Daily Coach</h2>`;
  html += `<p class="coach-headline">${esc(c.headline)}</p>`;
  if (c.insight) html += `<p class="coach-insight">💡 ${esc(c.insight)}</p>`;
  html += `<div class="coach-todos">` + c.todos.map((t, i) => {
    if (FAILING.has(i)) {
      return `<div class="todo failing"><span class="box"></span><span class="txt">Swapping it out<span class="dots"><i>.</i><i>.</i><i>.</i></span></span></div>`;
    }
    return `<div class="todo ${c.checked[i] ? 'done' : ''} ${i === justCheckedIdx ? 'just-checked' : ''}" data-i="${i}" data-tt="${tt('Why', [t.why])}">
      <span class="box">${c.checked[i] ? '✓' : ''}</span><span class="txt">${esc(t.text)}</span>
      ${c.checked[i] ? '' : `<button class="fail-x" data-i="${i}" title="Already failed — swap for a new one">✕</button>`}
    </div>`;
  }).join('') + `</div>`;
  if (c.follow_through && c.follow_through.length) {
    html += `<div class="coach-ft"><h3>You actually did it</h3>` +
      c.follow_through.map((f) => `<div class="ft-item">🎉 ${esc(f.text)}</div>`).join('') + `</div>`;
  }
  const real = (arr, key) => (arr || []).filter((x) =>
    x && x[key] && !/^\s*(n\/?a\b|none\b|nothing\b|-\s*$)/i.test(x[key]));
  const col = (title, items, fmt) => items && items.length
    ? `<div class="coach-col"><h3>${title}</h3>${items.map(fmt).join('')}</div>` : '';
  const cols =
    col('Keep doing', real(c.keep_doing, 'title'), (i) => `<div class="coach-item"><b>${esc(i.title)}</b><span>${esc(i.why)}</span></div>`) +
    col('Ease up on', real(c.ease_up, 'title'), (i) => `<div class="coach-item"><b>${esc(i.title)}</b><span>${esc(i.why)}</span></div>`) +
    col('Try this', real(c.activity_ideas, 'title'), (i) => `<div class="coach-item"><b>${esc(i.title)}</b><span>${esc(i.why)}</span></div>`);
  if (cols) html += `<div class="coach-cols">${cols}</div>`;
  if (c.watch_out) html += `<div class="coach-watch">⚠️ ${esc(c.watch_out)}</div>`;
  const ad = c.adherence && c.adherence.daily;
  const adNote = ad && ad.issued >= 3
    ? `<span class="adherence-note">${ad.completionRate}% of asks done over ${ad.windowDays} days${ad.discarded ? ` · ${ad.discarded} swapped` : ''}${ad.streak >= 2 ? ` · ${ad.streak}-day streak` : ''}</span>`
    : '';
  html += `<div class="coach-meta">
    <span class="progress">${done}/${c.todos.length} done</span>${adNote}
    <span>Generated ${new Date(c.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
    <span class="spacer"></span>
    <button onclick="loadCoach(true)">↻ Refresh</button>
  </div>`;
  $('coach').innerHTML = html;
  $('coach').querySelectorAll('.todo[data-i]').forEach((row) => {
    row.onclick = () => toggleTodo(Number(row.getAttribute('data-i')));
  });
  $('coach').querySelectorAll('.fail-x').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      failTodo(Number(btn.getAttribute('data-i')));
    };
  });
}

// ---------- weekly coach ----------
let WEEKLY = null;

async function loadWeeklyCoach(refresh) {
  const el = $('weekly-coach');
  el.innerHTML = `<h2>Weekly Coach</h2><div class="coach-loading">${refresh ? 'Rethinking the week' : 'Zooming out on your week'}<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
  try {
    const res = await fetch('/api/coach/weekly' + (refresh ? '?refresh=1' : ''));
    const w = await res.json();
    if (w.error || !Array.isArray(w.goals)) {
      el.innerHTML = `<h2>Weekly Coach</h2><p class="note">Weekly coach unavailable: ${esc(w.error || 'unexpected response')}</p>`;
      return;
    }
    WEEKLY = w;
    renderWeeklyCoach();
  } catch (e) {
    el.innerHTML = `<h2>Weekly Coach</h2><p class="note">Weekly coach unavailable: ${esc(e.message)}</p>`;
  }
}

function renderWeeklyCoach(justCheckedIdx = -1) {
  const w = WEEKLY;
  const done = (w.checked || []).filter(Boolean).length;
  let html = `<h2>Weekly Coach · ${esc(w.week)}</h2>`;
  html += `<p class="coach-headline">${esc(w.headline)}</p>`;
  if (w.last_week && w.last_week.length) {
    html += w.last_week.map((b) => `<p class="coach-insight">• ${esc(b.text)}</p>`).join('');
  }
  html += `<div class="coach-todos" style="margin-top:10px">` + w.goals.map((g, i) => {
    if (WEEKLY_FAILING.has(i)) {
      return `<div class="todo failing"><span class="box"></span><span class="txt">Swapping it out<span class="dots"><i>.</i><i>.</i><i>.</i></span></span></div>`;
    }
    return `<div class="todo ${w.checked[i] ? 'done' : ''} ${i === justCheckedIdx ? 'just-checked' : ''}" data-i="${i}" data-tt="${tt('Why', [g.why])}">
      <span class="box">${w.checked[i] ? '✓' : ''}</span><span class="txt">${esc(g.text)}</span>
      ${w.checked[i] ? '' : `<button class="fail-x" data-i="${i}" title="Not happening this week — swap it">✕</button>`}
    </div>`;
  }).join('') + `</div>`;
  if (w.experiment) {
    html += `<div class="coach-ft"><h3>This week's experiment</h3><div class="ft-item">🧪 ${esc(w.experiment)}</div></div>`;
  }
  const wad = w.adherence && w.adherence.weekly;
  const wNote = wad && wad.issued >= 3
    ? `<span class="adherence-note">${wad.completionRate}% hit over ${wad.windowWeeks} weeks${wad.discarded ? ` · ${wad.discarded} abandoned` : ''}</span>`
    : '';
  html += `<div class="coach-meta">
    <span class="progress">${done}/${w.goals.length} weekly goals</span>${wNote}
    <span>Generated ${new Date(w.generatedAt).toLocaleDateString(undefined, { weekday: 'short' })} ${new Date(w.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
    <span class="spacer"></span>
    <button onclick="loadWeeklyCoach(true)">↻ Refresh</button>
  </div>`;
  $('weekly-coach').innerHTML = html;
  $('weekly-coach').querySelectorAll('.todo[data-i]').forEach((row) => {
    row.onclick = () => toggleWeeklyGoal(Number(row.getAttribute('data-i')));
  });
  $('weekly-coach').querySelectorAll('.fail-x').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      failWeeklyGoal(Number(btn.getAttribute('data-i')));
    };
  });
}

const WEEKLY_FAILING = new Set();
async function failWeeklyGoal(i) {
  if (WEEKLY_FAILING.has(i)) return;
  WEEKLY_FAILING.add(i);
  renderWeeklyCoach();
  try {
    const res = await fetch('/api/coach/weekly/fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: WEEKLY.week, index: i }),
    });
    const w = await res.json();
    if (w.error) throw new Error(w.error);
    WEEKLY.goals = w.goals;
    WEEKLY.checked = w.checked;
    WEEKLY_FAILING.delete(i);
    renderWeeklyCoach(i); // pop-in on the replacement
  } catch (e) {
    WEEKLY_FAILING.delete(i);
    renderWeeklyCoach();
    $('errors').textContent = "Couldn't swap the weekly goal: " + e.message;
    setTimeout(() => { $('errors').textContent = ''; }, 6000);
  }
}

async function toggleWeeklyGoal(i) {
  const w = WEEKLY;
  const next = !w.checked[i];
  w.checked[i] = next;
  renderWeeklyCoach(next ? i : -1);
  try {
    await fetch('/api/coach/weekly/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: w.week, index: i, checked: next }),
    });
  } catch {}
}

const FAILING = new Set();
async function failTodo(i) {
  if (FAILING.has(i)) return;
  FAILING.add(i);
  renderCoach();
  try {
    const res = await fetch('/api/coach/fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: COACH.date, index: i }),
    });
    const c = await res.json();
    if (c.error) throw new Error(c.error);
    COACH.todos = c.todos;
    COACH.checked = c.checked;
    FAILING.delete(i);
    renderCoach(i); // pop-in on the replacement
  } catch (e) {
    FAILING.delete(i);
    renderCoach();
    $('errors').textContent = "Couldn't swap the to-do: " + e.message;
    setTimeout(() => { $('errors').textContent = ''; }, 6000);
  }
}

async function toggleTodo(i) {
  const c = COACH;
  const next = !c.checked[i];
  c.checked[i] = next;
  renderCoach(next ? i : -1);
  try {
    await fetch('/api/coach/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: c.date, index: i, checked: next }),
    });
  } catch {}
}

function renderAuthArea() {
  const el = $('auth-area');
  if (!STATUS.googleConfigured) { el.innerHTML = ''; return; }
  el.innerHTML = STATUS.loggedIn
    ? `<span class="badge">${esc(STATUS.email || 'signed in')}</span>`
    : `<button class="primary" onclick="location.href='/auth/google'">Sign in with Google</button>`;
  if (STATUS.loggedIn) $('signout-btn').style.display = '';
}

// ---------- life report ----------

let REPORT = null;

let REPORT_BOUNDS = null;

function setupReportPage() {
  $('report-btn').onclick = () => showView('report');
  $('report-generate').onclick = () => loadReport(true);
  $('report-reset').onclick = () => { applyBoundsToInputs(); loadReport(true); };
}

// Default range = every day you've logged, through today
function applyBoundsToInputs() {
  if (!REPORT_BOUNDS) return;
  if (REPORT_BOUNDS.dataStart) {
    $('report-start').value = REPORT_BOUNDS.dataStart;
    $('report-start').min = REPORT_BOUNDS.dataStart;
  }
  const end = REPORT_BOUNDS.today || REPORT_BOUNDS.dataEnd;
  if (end) {
    $('report-end').value = end;
    $('report-end').max = end;
  }
}

// ---------- goals ----------

let GOALS_LOADED = false;

function setupGoalsPage() {
  $('goals-btn').onclick = () => showView('goals');
  $('goal-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('goal-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.disabled = true;
    try {
      const r = await (await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })).json();
      if (r.error) throw new Error(r.error);
      GOALS_LOADED = false;
      await loadGoals(true);
    } catch (err) {
      $('goals-list').insertAdjacentHTML('afterbegin', `<p class="errors">${esc(err.message)}</p>`);
    } finally {
      input.disabled = false;
      input.focus();
    }
  };
}

async function removeGoalById(id, text) {
  if (!confirm(`Delete this goal?\n\n"${text}"`)) return;
  await fetch('/api/goals/' + encodeURIComponent(id), { method: 'DELETE' });
  GOALS_LOADED = false;
  loadGoals(true);
}

async function loadGoals(force) {
  if (GOALS_LOADED && !force) return;
  const el = $('goals-list');
  if (!GOALS_LOADED) {
    el.innerHTML = `<div class="coach-loading">Measuring your goals against the data<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
  }
  try {
    const d = await (await fetch('/api/goals')).json();
    if (d.error) throw new Error(d.error);
    GOALS_LOADED = true;
    renderGoals(d.goals || [], d.assessment || { goals: [] });
  } catch (e) {
    el.innerHTML = `<p class="note">Couldn't load goals: ${esc(e.message)}</p>`;
  }
}

const GOAL_STATUS_LABEL = {
  on_track: 'On track', close: 'Getting there',
  slipping: 'Slipping', no_signal: 'Nothing measures this yet',
};

function renderGoals(goals, assessment) {
  const el = $('goals-list');
  if (!goals.length) {
    el.innerHTML = `<div class="empty-state"><span class="es-emoji">🎯</span>
      No goals yet. Add one above — say it however you'd say it out loud
      ("lift 4x a week", "be in bed before 1am", "see people more than screens").</div>`;
    return;
  }
  const byId = new Map((assessment.goals || []).map((g) => [g.id, g]));
  const stale = !assessment.goals || assessment.goals.length < goals.length;

  el.innerHTML = `<div class="goal-cards">` + goals.map((g) => {
    const a = byId.get(g.id);
    let body;
    if (!a) {
      body = `<p class="note">${NEEDS_DATA
        ? 'Connect your Sheet and Doc to track progress on this.'
        : 'Measuring this against your data…'}</p>`;
    } else {
      const pct = Math.max(0, Math.min(100, Number(a.metric.percent) || 0));
      body = `
        <span class="goal-status ${esc(a.status)}">${esc(GOAL_STATUS_LABEL[a.status] || a.status)}</span>
        <p class="coach-insight" style="margin-bottom:6px">${esc(a.headline)}</p>
        ${a.metric && a.metric.label ? `<div class="goal-metric">
          <div class="gm-top"><span>${esc(a.metric.label)}</span>
            <span><b>${esc(a.metric.value || '—')}</b>${a.metric.target ? ` / ${esc(a.metric.target)}` : ''}</span></div>
          <div class="goal-bar"><span style="width:${pct}%"></span></div>
        </div>` : ''}
        ${(a.evidence || []).length ? `<ul class="goal-evidence">${a.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        ${a.next_step ? `<div class="goal-next"><b>Next:</b> ${esc(a.next_step)}</div>` : ''}`;
    }
    const safeText = esc(g.text).replace(/'/g, '&#39;');
    const safe = (s) => esc(String(s)).replace(/'/g, '&#39;');
    const links = g.links || [];
    const sug = ((a && a.suggested_links) || [])
      .filter((s) => s && s.phrase && !links.includes(String(s.phrase).toLowerCase()))
      .slice(0, 3);
    let tags = `<div class="goal-tags">`;
    if (links.length) tags += `<span class="gtag-label">counting:</span>`;
    tags += links.map((p) =>
      `<span class="gtag" title="Tagged as counting toward this goal">${esc(p)}<button title="Stop counting this" onclick="unlinkGoalTag('${esc(g.id)}','${safe(p)}')">×</button></span>`).join('');
    tags += sug.map((s) =>
      `<button class="gtag suggest" title="${esc(s.why || '')} — click to count it" onclick="linkGoalTag('${esc(g.id)}','${safe(s.phrase)}')">+ ${esc(s.phrase)}</button>`).join('');
    tags += `<button class="gtag add" title="Tag an activity or habit as counting toward this goal" onclick="showTagInput(this,'${esc(g.id)}')">+ tag</button></div>`;
    return `<div class="goal-card">
      <button class="goal-x" title="Delete this goal" onclick="removeGoalById('${esc(g.id)}', '${safeText}')">🗑 Delete</button>
      <p class="goal-text">${esc(g.text)}</p>
      ${body}
      ${tags}
    </div>`;
  }).join('') + `</div>`;

  const when = assessment.assessedAt ? fmtTime(assessment.assessedAt) : null;
  el.insertAdjacentHTML('beforeend', `<div class="coach-foot" style="margin-top:16px">
    <span class="note">${stale ? 'New goal added — refresh to measure it.' : when ? 'Assessed ' + esc(when) : ''}</span>
    <button onclick="reassessGoals(this)">↻ Re-assess</button>
  </div>`);
}

// ---- tagging activities/habits as counting toward a goal ----

async function linkGoalTag(id, phrase) {
  phrase = String(phrase || '').trim();
  if (!phrase) return;
  await fetch(`/api/goals/${encodeURIComponent(id)}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase }),
  });
  GOALS_LOADED = false;
  loadGoals(true); // assessment was invalidated server-side, so this re-measures
}

async function unlinkGoalTag(id, phrase) {
  await fetch(`/api/goals/${encodeURIComponent(id)}/unlink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase }),
  });
  GOALS_LOADED = false;
  loadGoals(true);
}

// Inline input with every known activity title + habit name as suggestions
function showTagInput(btn, id) {
  const options = tagSuggestionOptions();
  btn.outerHTML = `<span class="gtag-input">
    <input list="tag-dl" id="tag-in-${id}" placeholder="activity or habit…"
      onkeydown="if(event.key==='Enter'){event.preventDefault();linkGoalTag('${id}',this.value)}">
    <datalist id="tag-dl">${options}</datalist>
    <button title="Save tag" onclick="linkGoalTag('${id}',document.getElementById('tag-in-${id}').value)">✓</button>
  </span>`;
  const input = document.getElementById('tag-in-' + id);
  if (input) input.focus();
}

function tagSuggestionOptions() {
  const seen = new Set();
  const d = window.APP_DATA;
  if (d) {
    for (const name of d.habits.habitNames || []) seen.add(name.toLowerCase());
    for (const day of d.journal || []) {
      for (const a of day.activities || []) {
        const t = String(a.title || '').trim().toLowerCase();
        if (t && !/^(sleep|slept|woke)/.test(t)) seen.add(t);
      }
    }
  }
  return [...seen].slice(0, 80).map((t) => `<option value="${esc(t)}"></option>`).join('');
}

async function reassessGoals(btn) {
  btn.disabled = true;
  btn.textContent = 'Assessing…';
  try {
    const d = await (await fetch('/api/goals?assess=1')).json();
    if (d.error) throw new Error(d.error);
    renderGoals(d.goals || [], d.assessment || { goals: [] });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '↻ Re-assess';
    $('goals-list').insertAdjacentHTML('afterbegin', `<p class="errors">${esc(e.message)}</p>`);
  }
}

// ---------- social ----------

let SOCIAL = null;   // last /api/social response
let WIZ = null;      // walkthrough state

function setupSocialPage() {
  $('social-btn').onclick = () => showView('social');
}

async function loadSocial() {
  const el = $('social-body');
  el.innerHTML = `<div class="coach-loading">Loading<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
  try {
    SOCIAL = await (await fetch('/api/social')).json();
    if (SOCIAL.error) throw new Error(SOCIAL.error);
  } catch (e) {
    el.innerHTML = `<p class="note">Social is unavailable: ${esc(e.message)}</p>`;
    return;
  }
  const s = SOCIAL.settings;
  $('social-privacy-btn').style.display = s.walkthroughDone ? '' : 'none';
  if (!s.walkthroughDone) startSocialWizard(false);
  else if (!s.enabled) renderSocialOff();
  else renderSocialFeed();
}

function openSocialSettings() { startSocialWizard(true); }

function renderSocialOff() {
  $('social-body').innerHTML = `<div class="empty-state" style="padding:40px 16px">
    <span class="es-emoji">🔒</span>
    Sharing is <b>off</b> — nothing about you is visible to anyone.
    <div style="margin-top:14px"><button class="primary" onclick="openSocialSettings()">Turn sharing back on</button></div>
  </div>`;
}

// ----- the walkthrough -----
// Every share is opt-in; the wizard never enables anything the user didn't
// explicitly tick, and nothing is saved until the final step.

function startSocialWizard(isEdit) {
  const s = JSON.parse(JSON.stringify(SOCIAL.settings));
  if (!s.displayName) s.displayName = (STATUS.email || 'me').split('@')[0];
  WIZ = { step: 0, isEdit, s };
  renderWizard();
}

const WIZ_STEPS = ['The deal', 'Your name', 'What to share', 'Who sees it', 'Review'];

function renderWizard() {
  const { step, s, isEdit } = WIZ;
  const dots = WIZ_STEPS.map((label, i) =>
    `<span class="wiz-dot ${i === step ? 'on' : i < step ? 'done' : ''}" title="${esc(label)}"></span>`).join('');
  let body = '';

  if (step === 0) {
    body = `
      <h3>Share only what you choose — with only who you choose</h3>
      <ul class="wiz-list">
        <li>🔒 <b>Everything starts private.</b> Nothing about you is visible until you finish this walkthrough, and every item is off until you turn it on.</li>
        <li>📸 Friends see <b>summaries you approve</b> (like "lifted 4x this week") — never your journal text, raw logs, or Google documents.</li>
        <li>👥 <b>You pick the audience</b>: everyone on the app, or only specific people.</li>
        <li>🏆 Shared numbers power friendly leaderboards and a bulletin board for your circle.</li>
        <li>↩️ Change or turn it all off any time from the 🔒 Privacy button.</li>
      </ul>`;
  } else if (step === 1) {
    body = `
      <h3>What should friends call you?</h3>
      <div class="field" style="max-width:320px"><label>Display name</label>
        <input id="wiz-name" maxlength="40" value="${esc(s.displayName)}"></div>
      <p class="note">Shown instead of your email everywhere on the social page.</p>`;
  } else if (step === 2) {
    const opt = (key, label, desc, extra = '') => `
      <label class="wiz-opt ${extra.includes('sensitive') ? 'sensitive' : ''}">
        <input type="checkbox" data-share="${key}" ${s.share[key] ? 'checked' : ''}>
        <span><b>${label}</b>${extra.includes('sensitive') ? ' <span class="sens-tag">sensitive</span>' : ''}<small>${desc}</small></span>
      </label>`;
    const habitNames = (window.APP_DATA && APP_DATA.habits.habitNames) || [];
    body = `
      <h3>What are you comfortable sharing?</h3>
      <p class="note">All off by default. Tick only what you want your circle to see.</p>
      <div class="wiz-opts">
        ${opt('habitCompletion', 'Overall habit completion %', 'One number: how much of your checklist you hit (7-day average).')}
        <label class="wiz-opt">
          <input type="checkbox" data-share="habits" ${s.share.habits.enabled ? 'checked' : ''}>
          <span><b>Specific habits</b><small>Completion % and streak for the habits you pick — habit names are visible.</small></span>
        </label>
        <div id="wiz-habit-picker" style="display:${s.share.habits.enabled ? '' : 'none'}" class="wiz-habits">
          ${habitNames.map((n) => `<label class="gtag" style="cursor:pointer"><input type="checkbox" data-habit="${esc(n)}" ${s.share.habits.names.includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('') || '<span class="note">No habit columns found yet.</span>'}
        </div>
        ${opt('dayScores', 'Average day score', 'Your 7-day average day rating (0–10). Not the individual days.')}
        ${opt('bedtimes', 'Bedtimes', 'Average bedtime and % of nights before midnight.')}
        ${opt('adherence', 'Coach follow-through', 'How often you complete your daily coach checklist.')}
        ${opt('activities', 'Top activities', 'Your 3 best-rated recent activities — titles are visible, so skim them first.')}
        ${opt('goals', 'Goals & progress', 'Your goal texts with status and progress %. Skip if any goal is private.')}
        ${opt('sessions', '🌱 Sessions per week', 'Weekly session count.', 'sensitive')}
      </div>`;
  } else if (step === 3) {
    const dir = SOCIAL.directory || [];
    body = `
      <h3>Who can see it?</h3>
      <label class="wiz-opt"><input type="radio" name="aud" value="everyone" ${s.audience.mode === 'everyone' ? 'checked' : ''}>
        <span><b>Everyone on the app</b><small>Anyone with an account here (it's just your circle of friends).</small></span></label>
      <label class="wiz-opt"><input type="radio" name="aud" value="selected" ${s.audience.mode === 'selected' ? 'checked' : ''}>
        <span><b>Only people I pick</b><small>Nobody else — including future signups — sees anything.</small></span></label>
      <div id="wiz-audience" style="display:${s.audience.mode === 'selected' ? '' : 'none'}">
        ${dir.length ? `<p class="note" style="margin-top:10px">On the app already:</p>` +
          dir.map((d) => `<label class="gtag" style="cursor:pointer"><input type="checkbox" data-aud-email="${esc(d.email)}" ${s.audience.emails.includes(d.email) ? 'checked' : ''}> ${esc(d.displayName)} <small>(${esc(d.email)})</small></label>`).join(' ')
          : `<p class="note" style="margin-top:10px">Nobody else has joined social yet.</p>`}
        <div class="field" style="max-width:360px;margin-top:10px"><label>Add by email</label>
          <input id="wiz-extra-emails" placeholder="friend@gmail.com, other@gmail.com"
            value="${esc(s.audience.emails.filter((e) => !dir.some((d) => d.email === e)).join(', '))}"></div>
      </div>`;
  } else {
    const on = [];
    const sh = s.share;
    if (sh.habitCompletion) on.push('overall completion %');
    if (sh.habits.enabled && sh.habits.names.length) on.push(`${sh.habits.names.length} specific habit(s): ${sh.habits.names.join(', ')}`);
    if (sh.dayScores) on.push('avg day score');
    if (sh.bedtimes) on.push('bedtimes');
    if (sh.adherence) on.push('coach follow-through');
    if (sh.activities) on.push('top activities');
    if (sh.goals) on.push('goals & progress');
    if (sh.sessions) on.push('🌱 sessions/week');
    const aud = s.audience.mode === 'everyone'
      ? 'everyone on the app'
      : s.audience.emails.length ? `only: ${s.audience.emails.join(', ')}` : 'nobody yet (pick people or switch to everyone)';
    body = `
      <h3>Last look before anything is shared</h3>
      <div class="preview-col" style="margin:12px 0">
        <h3>You'll share</h3>
        ${on.length ? `<ul class="wiz-list">${on.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="note">Nothing — you can still see friends who share with you, and post on the bulletin.</p>'}
        <h3 style="margin-top:10px">With</h3>
        <p style="margin:4px 0">${esc(aud)}</p>
      </div>
      <p class="note">You can change any of this, or turn it all off, from 🔒 Privacy.</p>`;
  }

  const canBack = step > 0;
  const next = step === WIZ_STEPS.length - 1
    ? `<button class="primary" onclick="finishWizard()">${WIZ.isEdit ? 'Save settings' : '✓ Start sharing'}</button>`
    : `<button class="primary" onclick="wizNext(1)">${step === 0 ? 'Set it up →' : 'Next →'}</button>`;
  $('social-body').innerHTML = `
    <div class="wiz-card">
      <div class="wiz-dots">${dots}</div>
      ${body}
      <div class="preview-actions" style="margin-top:18px">
        ${canBack ? `<button onclick="wizNext(-1)">← Back</button>` : ''}
        ${next}
        ${step === 0 && !WIZ.isEdit ? `<button onclick="showView('dashboard')">Not now</button>` : ''}
        ${WIZ.isEdit && SOCIAL.settings.enabled ? `<button onclick="disableSharing()" style="color:var(--critical)">Turn off sharing</button>` : ''}
      </div>
    </div>`;
  bindWizard();
}

function bindWizard() {
  const { s } = WIZ;
  const name = $('wiz-name');
  if (name) name.oninput = () => { s.displayName = name.value; };
  document.querySelectorAll('[data-share]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.getAttribute('data-share') === 'habits') {
        s.share.habits.enabled = cb.checked;
        const picker = $('wiz-habit-picker');
        if (picker) picker.style.display = cb.checked ? '' : 'none';
      } else {
        s.share[cb.getAttribute('data-share')] = cb.checked;
      }
    };
  });
  document.querySelectorAll('[data-habit]').forEach((cb) => {
    cb.onchange = () => {
      const n = cb.getAttribute('data-habit');
      if (cb.checked) { if (!s.share.habits.names.includes(n)) s.share.habits.names.push(n); }
      else s.share.habits.names = s.share.habits.names.filter((x) => x !== n);
    };
  });
  document.querySelectorAll('input[name="aud"]').forEach((r) => {
    r.onchange = () => {
      s.audience.mode = r.value;
      const box = $('wiz-audience');
      if (box) box.style.display = r.value === 'selected' ? '' : 'none';
    };
  });
  document.querySelectorAll('[data-aud-email]').forEach((cb) => {
    cb.onchange = () => {
      const e = cb.getAttribute('data-aud-email');
      if (cb.checked) { if (!s.audience.emails.includes(e)) s.audience.emails.push(e); }
      else s.audience.emails = s.audience.emails.filter((x) => x !== e);
    };
  });
  const extra = $('wiz-extra-emails');
  if (extra) extra.onchange = () => {
    const dir = new Set((SOCIAL.directory || []).map((d) => d.email));
    const kept = s.audience.emails.filter((e) => dir.has(e));
    const typed = extra.value.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    s.audience.emails = [...new Set([...kept, ...typed])];
  };
}

function wizNext(delta) {
  WIZ.step = Math.max(0, Math.min(WIZ_STEPS.length - 1, WIZ.step + delta));
  renderWizard();
}

async function finishWizard() {
  const s = WIZ.s;
  s.enabled = true;
  s.walkthroughDone = true;
  const r = await (await fetch('/api/social/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })).json();
  if (r.error) { alert('Could not save: ' + r.error); return; }
  loadSocial();
}

async function disableSharing() {
  if (!confirm('Turn off sharing? Friends will immediately stop seeing anything about you.')) return;
  await fetch('/api/social/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...WIZ.s, enabled: false, walkthroughDone: true }),
  });
  loadSocial();
}

// ----- the feed -----

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderSocialFeed() {
  const feed = SOCIAL.feed || { members: [], boards: [], insights: [], posts: [] };
  const me = SOCIAL.email;
  const others = feed.members.filter((m) => m.email !== me);
  let html = '';

  const s = SOCIAL.settings;
  const audDesc = s.audience.mode === 'everyone' ? 'everyone on the app' : `${s.audience.emails.length} chosen ${s.audience.emails.length === 1 ? 'person' : 'people'}`;
  html += `<p class="note" style="margin-bottom:14px">You're sharing with <b>${esc(audDesc)}</b> · ${others.length} ${others.length === 1 ? 'person shares' : 'people share'} with you · <a href="#" onclick="openSocialSettings();return false">adjust</a></p>`;

  if (!others.length) {
    html += `<div class="empty-state"><span class="es-emoji">👋</span>
      It's just you so far. Leaderboards light up when friends share the same things —
      tell them to hit <b>👥 Social</b> after they sign in.</div>`;
  }

  if (feed.insights.length) {
    html += `<div class="card coach" style="margin-bottom:16px"><h2>Today's chatter</h2>
      <div class="social-insights">${feed.insights.map((l) => `<div class="si-line">${esc(l)}</div>`).join('')}</div></div>`;
  }

  if (feed.boards.length) {
    html += `<div class="social-boards">` + feed.boards.map((b) => `
      <div class="card sboard"><h2>${esc(b.emoji)} ${esc(b.title)}</h2>
        <table>${b.rows.map((r, i) => `
          <tr class="${r.email === me ? 'me-row' : ''}">
            <td class="num" style="width:26px">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
            <td>${esc(r.name)}${r.email === me ? ' <small>(you)</small>' : ''}</td>
            <td class="num"><b>${esc(r.display)}</b></td>
          </tr>`).join('')}</table>
      </div>`).join('') + `</div>`;
  }

  html += `<div class="card" style="margin-top:16px"><h2>📌 Bulletin</h2>
    <p class="sub">Visible to the people you share with — and you see posts from people who share with you.</p>
    <div class="bulletin-compose">
      <input id="bulletin-input" maxlength="500" placeholder="Say something to the circle…"
        onkeydown="if(event.key==='Enter')postBulletin()">
      <button class="primary" onclick="postBulletin()">Post</button>
    </div>
    <div class="bulletin-list">${feed.posts.length ? feed.posts.map((p) => `
      <div class="bpost">
        <div class="bpost-head"><b>${esc(p.displayName)}</b><span class="note">${esc(timeAgo(p.createdAt))}</span>
          ${p.mine ? `<button class="bpost-del" title="Delete" onclick="deleteBulletin('${esc(p.pid)}')">🗑</button>` : ''}</div>
        <div>${esc(p.text)}</div>
      </div>`).join('') : `<p class="note">Nothing posted yet. Break the ice.</p>`}
    </div>
  </div>`;

  $('social-body').innerHTML = html;
}

async function postBulletin() {
  const input = $('bulletin-input');
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  const r = await (await fetch('/api/social/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })).json();
  if (r.error) alert(r.error);
  loadSocial();
}

async function deleteBulletin(pid) {
  await fetch('/api/social/post/' + encodeURIComponent(pid), { method: 'DELETE' });
  loadSocial();
}

// ---------- header info overlay ----------
// ⓘ dims the page and hangs a small explainer bubble under every nav button.

const NAV_INFO = [
  ['home-btn', 'Home', 'Back to your widget dashboard from any page.'],
  ['goals-btn', 'Goals', 'State what you\'re working toward; progress is measured from your data.'],
  ['report-btn', 'Report', 'Generate an in-depth, shareable report on any date range.'],
  ['social-btn', 'Social', 'Share chosen stats with friends — leaderboards and a bulletin.'],
  ['data-btn', 'Data', 'Link your Sheet + Doc, edit them, and verify they parse right.'],
  ['settings-btn', 'Widgets', 'Show, hide, and rearrange the dashboard widgets.'],
  ['signout-btn', 'Sign out', 'Log out of this browser.'],
  ['info-btn', 'Info', 'This overlay. Click anywhere to close it.'],
];

function toggleInfoOverlay() {
  const existing = document.getElementById('info-overlay');
  if (existing) { existing.remove(); return; }
  const ov = document.createElement('div');
  ov.id = 'info-overlay';
  ov.onclick = () => ov.remove();
  let html = `<button class="info-close" title="Close" onclick="this.parentNode.remove()">✕ close</button>`;
  let i = 0;
  for (const [id, title, text] of NAV_INFO) {
    const btn = document.getElementById(id);
    if (!btn || btn.offsetParent === null) continue; // hidden (e.g. Sign out in demo)
    const r = btn.getBoundingClientRect();
    // Alternate two levels so neighboring bubbles never collide
    const drop = i % 2 === 0 ? 12 : 112;
    html += `<div class="info-tip ${i % 2 ? 'low' : ''}" style="left:${Math.round(r.left + r.width / 2)}px;top:${Math.round(r.bottom + drop)}px;animation-delay:${i * 0.06}s">
      <b>${esc(title)}</b>${esc(text)}</div>`;
    i++;
  }
  // What the whole app runs on — so new users know what to set up
  html += `<div class="info-data-box" onclick="event.stopPropagation()">
    <h3>📥 What feeds all of this</h3>
    <p>Two Google files you keep updating however you already do:</p>
    <ul>
      <li><b>Habit tracker — Google Sheet.</b> A <code>DATE</code> column plus one TRUE/FALSE column per habit, one row per day.</li>
      <li><b>Daily journal — Google Doc.</b> A date line for each day (<code>07/24/26 | 8 | Cambridge</code> = date, day score, city), then one line per activity: <code>3:00 | Softball w/ Cory | Field | 9</code>.</li>
    </ul>
    <p>Link both under <b>🔗 Data</b> — they're re-read every time you open the app, and the coach, report, goals and social views are all built from them.</p>
    <button class="primary" onclick="document.getElementById('info-overlay').remove();showView('data')">Open 🔗 Data</button>
  </div>`;
  ov.innerHTML = html;
  document.body.appendChild(ov);
  const esch = (e) => { if (e.key === 'Escape') { ov.remove(); window.removeEventListener('keydown', esch); } };
  window.addEventListener('keydown', esch);
  window.addEventListener('resize', () => ov.remove(), { once: true });
}

// ---------- view switching ----------
// The dashboard, goals, data and report are sibling pages in the same column;
// only one is mounted at a time so nothing floats over the widgets.

const VIEWS = ['dashboard', 'goals', 'data', 'report', 'social'];
let CURRENT_VIEW = 'dashboard';

function showView(name) {
  CURRENT_VIEW = name;
  for (const v of VIEWS) {
    const el = $('view-' + v);
    if (!el) continue;
    if (v === 'dashboard') el.style.display = name === 'dashboard' ? '' : 'none';
    else el.classList.toggle('open', v === name);
  }
  $('setup-banner').style.display =
    (name === 'dashboard' && NEEDS_SETUP) ? '' : 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'report' && !REPORT) loadReport(false);
  if (name === 'goals') loadGoals();
  if (name === 'data') renderDrivePanes();
  if (name === 'social') loadSocial();
}

async function loadReport(generate) {
  const el = $('report-body');
  const start = $('report-start').value;
  const end = $('report-end').value;
  const qs = new URLSearchParams();
  if (generate) {
    qs.set('generate', '1');
    if (start) qs.set('start', start);
    if (end) qs.set('end', end);
  }
  const span = start && end ? Math.round((new Date(end) - new Date(start)) / 864e5) + 1 : null;
  el.innerHTML = generate
    ? `<div class="report-working"><div class="coach-loading">Reading ${span ? span + ' days' : 'your logs'}<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
       <p class="note">Crunching the numbers, then writing it up. This takes a minute or two — leave the tab open.</p></div>`
    : `<div class="coach-loading">Loading<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
  try {
    const r = await (await fetch('/api/report' + (qs.toString() ? '?' + qs : ''))).json();
    if (r.bounds) {
      REPORT_BOUNDS = r.bounds;
      if (!$('report-start').value) applyBoundsToInputs();
    }
    if (r.error) {
      el.innerHTML = `<p class="note">${esc(r.error)}</p>
        ${/Connect your Sheet/.test(r.error) ? '' : '<button class="primary" onclick="loadReport(true)">Try again</button>'}`;
      return;
    }
    if (!r.title) {
      el.innerHTML = `<div class="report-empty"><p>No report yet — the range above covers everything you've logged.</p>
        <button class="primary" onclick="loadReport(true)">Generate my first report</button></div>`;
      return;
    }
    REPORT = r;
    if (r.periodStart) $('report-start').value = r.periodStart;
    if (r.periodEnd) $('report-end').value = r.periodEnd;
    renderReport(r);
  } catch (e) {
    el.innerHTML = `<p class="note">Report unavailable: ${esc(e.message)}</p>`;
  }
}

const CONF_LABEL = { strong: 'strong signal', moderate: 'moderate', tentative: 'tentative' };

function renderReport(r) {
  const period = `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`;
  let html = `<div class="report-head">
      <h1>${esc(r.title)}</h1>
      <p class="report-period">${esc(period)} · ${r.daysLogged} day${r.daysLogged === 1 ? '' : 's'} logged · generated ${new Date(r.generatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>
    </div>`;

  const takeaways = r.key_takeaways || (r.executive_summary ? [r.executive_summary] : []);
  if (takeaways.length) {
    html += `<ul class="report-takeaways">` +
      takeaways.map((t) => `<li>${esc(t)}</li>`).join('') + `</ul>`;
  }

  if (r.snapshot && r.snapshot.length) {
    html += `<div class="report-snapshot">` + r.snapshot.map((s) =>
      `<div class="snap"><div class="snap-label">${esc(s.label)}</div><div class="snap-value">${esc(s.value)}</div><div class="snap-note">${esc(s.note)}</div></div>`
    ).join('') + `</div>`;
  }

  if (r.goal_progress && r.goal_progress.length) {
    html += `<div class="report-since"><h3>Your goals over this period</h3>` +
      r.goal_progress.map((g) => `<p style="margin:0 0 8px">
        <span class="goal-status ${esc(g.verdict)}" style="margin:0 8px 0 0">${esc(GOAL_STATUS_LABEL[g.verdict] || g.verdict)}</span>
        <b>${esc(g.goal)}</b> — ${esc(g.detail)}</p>`).join('') + `</div>`;
  }

  if (r.since_last_report) {
    html += `<div class="report-since"><h3>Since your last report</h3><p>${esc(r.since_last_report)}</p></div>`;
  }

  html += (r.sections || []).map((s, i) => `
    <section class="report-section">
      <h2><span class="sec-num">${i + 1}</span>${esc(s.heading)}</h2>
      <p class="sec-summary">${esc(s.summary)}</p>
      ${(s.findings || []).map((f) => `
        <div class="finding">
          <div class="finding-claim">${esc(f.claim)}</div>
          <div class="finding-evidence">${esc(f.evidence)}</div>
          <span class="conf conf-${esc(f.confidence)}">${esc(CONF_LABEL[f.confidence] || f.confidence)}</span>
        </div>`).join('')}
    </section>`).join('');

  if (r.experiments && r.experiments.length) {
    html += `<section class="report-section"><h2><span class="sec-num">🧪</span>Try this fortnight</h2>` +
      r.experiments.map((e) => `
        <div class="finding">
          <div class="finding-claim">${esc(e.text)}</div>
          <div class="finding-evidence">${esc(e.rationale)}</div>
          <div class="finding-measure">Measure: ${esc(e.how_to_measure)}</div>
        </div>`).join('') + `</section>`;
  }

  if (r.open_questions && r.open_questions.length) {
    html += `<section class="report-section"><h2><span class="sec-num">?</span>Open questions</h2>
      <ul class="report-questions">${r.open_questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></section>`;
  }

  if (r.history && r.history.length > 1) {
    html += `<p class="note no-print" style="margin-top:20px">${r.history.length} reports saved · previous: ${r.history.slice(1, 4).map((h) => esc(fmtDate(h.periodStart)) + '–' + esc(fmtDate(h.periodEnd))).join(', ')}</p>`;
  }
  $('report-body').innerHTML = html;
}

// ---------- data page (links + read verification) ----------

function setupDataPage() {
  $('data-btn').onclick = () => showView('data');
  $('sheet-url').value = STATUS.sheetUrl || '';
  $('doc-url').value = STATUS.docUrl || '';
  // Once links exist, the page leads with the documents themselves; the
  // link/format controls collapse behind this toggle.
  const hasLinks = !!(STATUS.sheetUrl || STATUS.docUrl);
  $('sources-panel').style.display = hasLinks ? 'none' : '';
  // First-time setup: show the suggested formats for both files up front
  if (!hasLinks) $('format-help').style.display = '';
  if (!STATUS.demo && STATUS.loggedIn) $('danger-zone').style.display = '';
  $('toggle-sources').onclick = () => {
    const p = $('sources-panel');
    p.style.display = p.style.display === 'none' ? '' : 'none';
  };
}

// Google forbids embedding the Docs/Sheets *editor* in a third-party frame,
// so each pane shows the live read-only preview and hands editing off to a
// real Google tab, then re-reads on return.
function driveId(url, kind) {
  const m = String(url || '').match(
    kind === 'sheet' ? /spreadsheets\/d\/([\w-]+)/ : /document\/d\/([\w-]+)/);
  return m ? m[1] : null;
}

function drivePane(kind, url, title) {
  const id = driveId(url, kind);
  const base = kind === 'sheet'
    ? `https://docs.google.com/spreadsheets/d/${id}`
    : `https://docs.google.com/document/d/${id}`;
  if (!id) {
    return `<div class="drive-pane"><div class="dp-head"><h3>${esc(title)}</h3></div>
      <div class="dp-empty">Not linked yet — add the URL under <b>Links &amp; format check</b>.</div></div>`;
  }
  return `<div class="drive-pane">
    <div class="dp-head">
      <h3>${esc(title)}</h3>
      <span style="display:flex;gap:6px">
        <button onclick="window.open('${base}/edit','_blank','noopener')">✏️ Edit in Google</button>
        <button onclick="refreshDrivePane(this)" title="Reload after editing">↻</button>
      </span>
    </div>
    <iframe src="${base}/preview" loading="lazy" title="${esc(title)} preview"></iframe>
  </div>`;
}

function refreshDrivePane(btn) {
  const frame = btn.closest('.drive-pane').querySelector('iframe');
  if (frame) frame.src = frame.src;
  runPreview();
}

function renderDrivePanes() {
  const el = $('drive-panes');
  if (!el) return;
  if (STATUS.demo) {
    el.innerHTML = `<p class="note">Local demo mode reads the seed files, so there's nothing to embed. Sign in with Google to link and edit live documents here.</p>`;
    return;
  }
  el.innerHTML = drivePane('sheet', STATUS.sheetUrl, 'Habit tracker')
    + drivePane('doc', STATUS.docUrl, 'Daily journal');
}

// ---------- parse debugger ----------

async function loadParseDebug() {
  const el = $('parse-debug');
  el.style.display = '';
  el.innerHTML = `<div class="coach-loading">Re-reading your sources line by line<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
  try {
    const d = await (await fetch('/api/parse-debug')).json();
    if (d.error) throw new Error(d.error);
    const c = d.journal.counts;
    let html = `<div class="ph-row"><h3>Parsing debugger</h3>
      <button class="icon-btn" title="Close" onclick="document.getElementById('parse-debug').style.display='none'">✕</button></div>
      <div class="pd-summary">
        <span>Journal: <b>${c.day || 0}</b> day headers · <b>${c.activity || 0}</b> activities · <b>${c.skipped || 0}</b> unread</span>
        <span>Sheet: <b>${d.sheet.daysParsed}</b> days · <b>${d.sheet.habitNames.length}</b> habits</span>
      </div>`;
    if (d.notes && d.notes.length) html += `<p class="note">${esc(d.notes.join(' · '))}</p>`;
    if (d.sheet.habitNames.length) {
      html += `<p class="note">Habit columns found: ${d.sheet.habitNames.map(esc).join(', ')}</p>`;
    }
    if (!d.journal.lines.length) {
      html += `<p class="note">No journal lines to show.</p>`;
    } else {
      html += `<div class="pd-lines">` + d.journal.lines.map((l) => `
        <div class="pd-line ${l.kind}">
          <span class="pd-no">${l.lineNo}</span>
          <span class="pd-tag">${l.kind === 'day' ? 'Day' : l.kind === 'activity' ? 'Read' : 'Skipped'}</span>
          <span class="pd-raw">${esc((l.raw || '').trim().slice(0, 120)) || '—'}</span>
          <span class="pd-why">${esc(
            l.kind === 'day' ? `${l.date}${l.score !== null ? ` · score ${l.score}` : ''}${l.city ? ` · ${l.city}` : ''}`
            : l.kind === 'activity' ? `${l.time} · ${l.title}${l.rating !== null ? ` · ${l.rating}/10` : ' · no rating'}`
            : l.reason || ''
          )}</span>
        </div>`).join('') + `</div>`;
      if (c.skipped) html += `<p class="note">Red rows were not read. Fix them in the doc and hit <b>Debug parsing</b> again.</p>`;
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<p class="note">Couldn't run the debugger: ${esc(e.message)}</p>`;
  }
}

async function saveAndCheck() {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheetUrl: $('sheet-url').value.trim(), docUrl: $('doc-url').value.trim() }),
  });
  runPreview();
}

async function runPreview() {
  $('preview-section').style.display = '';
  $('preview-body').innerHTML = '<p class="coach-loading">Reading your sources<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>';
  $('preview-errors').textContent = '';
  try {
    const p = await (await fetch('/api/preview')).json();
    if (p.error) throw new Error(p.error);
    let html = '';

    const h = p.habits;
    html += `<div class="preview-col"><h3>Habit tracker (Sheet)</h3>`;
    if (h.tab) {
      const many = h.tabs && h.tabs.length > 1;
      html += `<div class="note" style="margin-bottom:6px">Reading tab <b>${esc(h.tab)}</b>${many ? ` of ${h.tabs.length}${h.tabPickedBy === 'link' ? ' (from your link)' : ` — if that's not yours, paste the URL while your own tab is open`}` : ''}</div>`;
    }
    if (h.last) {
      html += `<div class="pdate">${fmtDate(h.last.date)} (${esc(h.last.weekday)}) — ${esc(h.label)}</div>
        <div class="note" style="margin-bottom:6px">${h.habitCount} habits detected · ${h.daysParsed} day(s) parsed · ${h.last.done.length}/${h.habitCount} done that day</div>
        <div class="preview-list">` +
        h.last.done.map((n) => `<div class="ok">✓ ${esc(n)}</div>`).join('') +
        h.last.missed.map((n) => `<div class="miss">✗ ${esc(n)}</div>`).join('') +
        `</div>`;
    } else {
      html += `<p class="note">No rows parsed — the sheet format may not match. Hit "Something's off" for the expected format.</p>`;
    }
    html += `</div>`;

    const j = p.journal;
    html += `<div class="preview-col"><h3>Daily journal (Doc)</h3>`;
    if (j.last) {
      html += `<div class="pdate">${fmtDate(j.last.date)} — ${esc(j.label)}${j.last.score !== null ? ` · day score ${j.last.score}` : ''}${j.last.city ? ` · ${esc(j.last.city)}` : ''}</div>
        <div class="note" style="margin-bottom:6px">${j.daysParsed} day(s) parsed · ${j.last.activities.length} activities on the latest day</div>
        <div class="preview-list">` +
        j.last.activities.map((a) =>
          `<div>${esc(a.time)} — ${esc(a.title)}${a.location ? ` <span class="miss">@ ${esc(a.location)}</span>` : ''}${a.rating !== null ? ` <b>[${a.rating}/10]</b>` : ''}</div>`
        ).join('') +
        `</div>`;
    } else {
      html += `<p class="note">No days parsed — the doc format may not match. Hit "Something's off" for the expected format.</p>`;
    }
    html += `</div>`;

    $('preview-body').innerHTML = html;
    $('preview-errors').textContent = (p.errors || []).join(' · ');
  } catch (e) {
    $('preview-body').innerHTML = `<p class="note">Couldn't read your sources: ${esc(e.message)}</p>`;
  }
}

function toggleFormatHelp() {
  const el = $('format-help');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}
async function confirmData() {
  await fetch('/api/confirm-data', { method: 'POST' });
  location.reload();
}
async function logout() { await fetch('/api/logout', { method: 'POST' }); location.reload(); }

async function deleteAccount() {
  if (!confirm('Delete your account and ALL stored data? This cannot be undone.\n\n(Your Google Sheet and Doc are not touched.)')) return;
  if (!confirm('Last check — really delete everything?')) return;
  const r = await (await fetch('/api/account', { method: 'DELETE' })).json();
  if (r.error) { alert(r.error); return; }
  location.reload();
}

// ---------- render ----------
function render(data) {
  const { habits, journal, insights, source } = data;
  $('date-badge').textContent = new Date(data.fetchedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  renderMissingBanner(data.missing || [], data.needsConfirm);
  $('errors').textContent = (source.errors || []).join(' · ');

  renderKpis(insights.kpis);
  renderRhythm(habits, journal);
  renderToday(habits, journal);
  renderHeatmap(habits);
  renderHabitBars(insights.perHabit);
  renderImpact(insights.habitImpact);
  renderPeople(insights.people);
  renderPlaces(insights.cities, insights.locationSplit);
  renderSleep(insights.recent.sleep, insights.kpis);
  renderPlant(insights.recent.plant);
  labelRecentWidgets(insights.recent);
  renderWinsFocus(insights);
  renderWeekdays(insights.weekdays);
  renderActivities(insights.recent.activities);
  ensureWidgetControls();
}

// ---------- KPIs ----------
function renderKpis(k) {
  const tiles = [];
  const compDelta = k.completionPrev7 !== null && k.completion7 !== null ? k.completion7 - k.completionPrev7 : null;
  tiles.push(tile('Habit completion · 7d', k.completion7 !== null ? k.completion7 + '%' : '—',
    compDelta !== null ? `${compDelta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(compDelta))} pts vs prior wk` : '', compDelta));
  tiles.push(tile('Avg day score · 7d', k.avgScore7 ?? '—',
    k.avgScoreAll !== null ? `all-time ${k.avgScoreAll}` : '', null));
  tiles.push(tile('Best day', k.bestDay ? k.bestDay.score : '—',
    k.bestDay ? `${fmtDate(k.bestDay.date)}${k.bestDay.city ? ' · ' + k.bestDay.city : ''}` : '', null));
  tiles.push(tile('Sleep before 12', k.beforeMidnightRate !== null ? k.beforeMidnightRate + '%' : '—',
    k.avgBedtimeMin !== null ? 'avg bedtime ' + bedtimeLabel(k.avgBedtimeMin) : '', null));
  tiles.push(tile('Live streaks (2+ days)', k.activeStreaks, 'habits on a roll', null));
  $('kpis').innerHTML = tiles.join('');
}
function tile(label, value, delta, dir) {
  const cls = dir === null || dir === undefined ? '' : dir >= 0 ? 'up' : 'down';
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="delta ${cls}">${esc(delta)}</div></div>`;
}
function bedtimeLabel(min) {
  // minutes relative to midnight -> clock time ("1:18am", "11:30pm")
  let m = Math.round(min);
  const am = m >= 0;
  if (!am) m += 12 * 60;
  const h = Math.floor(m / 60) === 0 ? 12 : Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}${am ? 'am' : 'pm'}`;
}

// ---------- rhythm: completion bars + day-score line, overlaid ----------
// One shared normalized scale: 0-10 day score on the left ≡ 0-100% completion
// on the right (both span the full plot height linearly).
function renderRhythm(habits, journal) {
  if (!journal.length && !habits.days.length) return emptyState('rhythm', 'No logged days yet — this fills in once you log a day.', '📈');
  // With no habit sheet, fall back to journal days so the score line still shows
  const haveHabits = habits.days.length > 0;
  const days = haveHabits ? habits.days : journal.map((d) => ({
    date: d.date,
    weekday: new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    done: 0, total: 0, completion: 0,
  }));
  if (!days.length) { $('rhythm').innerHTML = '<p class="note">No data yet — connect your Sheet and Doc (🔗 Data).</p>'; return; }
  const jBy = new Map(journal.map((d) => [d.date, d]));
  const W = 820, H = 240, padL = 30, padR = 40, padT = 16, padB = 26;
  const n = days.length;
  const x = (i) => padL + (i + 0.5) * ((W - padL - padR) / n);
  const y = (frac) => padT + (1 - frac) * (H - padT - padB); // frac 0..1
  const bw = Math.min(30, ((W - padL - padR) / n) - 6);

  let g = '';
  for (const v of [0, 0.5, 1]) {
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`;
    g += `<text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" class="axis-label">${v * 10}</text>`;
    if (haveHabits) g += `<text x="${W - padR + 6}" y="${y(v) + 3}" class="axis-label">${v * 100}%</text>`;
  }

  // date labels always; completion bars only when a habit sheet exists
  for (let i = 0; i < n; i++) {
    const d = days[i];
    if (haveHabits) {
      const h = y(0) - y(d.completion);
      g += `<rect x="${x(i) - bw / 2}" y="${y(d.completion)}" width="${bw}" height="${Math.max(h, 1)}" rx="6" fill="var(--seq-2)" data-tt="${tt(`${fmtDate(d.date)} (${d.weekday})`, [`Habits: <b>${d.done}/${d.total}</b> (${Math.round(d.completion * 100)}%)`])}"/>`;
    }
    g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="axis-label">${fmtDate(d.date)}</text>`;
  }
  g += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--baseline)"/>`;

  // day-score line (front)
  const pts = days.map((d, i) => ({ i, d, j: jBy.get(d.date) })).filter((p) => p.j && p.j.score !== null);
  if (pts.length > 1) {
    const path = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.j.score / 10)}`).join('');
    g += `<path d="${path}" fill="none" stroke="var(--green-dark)" stroke-width="2.5" stroke-linejoin="round"/>`;
  }
  const scores = pts.map((p) => p.j.score);
  const mx = Math.max(...scores), mn = Math.min(...scores);
  for (const p of pts) {
    const city = p.j.city ? ` · ${p.j.city}` : '';
    const rows = [`Day score: <b>${p.j.score}</b>`];
    if (haveHabits) rows.push(`Habits: ${p.d.done}/${p.d.total} (${Math.round(p.d.completion * 100)}%)`);
    g += `<circle cx="${x(p.i)}" cy="${y(p.j.score / 10)}" r="5" fill="var(--green-dark)" stroke="var(--surface)" stroke-width="2" data-tt="${tt(`${fmtDate(p.d.date)} (${p.d.weekday})${city}`, rows)}"/>`;
    if (p.j.score === mx || p.j.score === mn) {
      g += `<text x="${x(p.i)}" y="${y(p.j.score / 10) - 10}" text-anchor="middle" class="val-label">${p.j.score}</text>`;
    }
  }

  $('rhythm').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--green-dark);border-radius:999px"></span>day score (0–10)</span>
      ${haveHabits ? '<span class="key"><span class="swatch" style="background:var(--seq-2)"></span>habit completion (0–100%)</span>' : ''}
    </div>`;
}

// Stamp the rolling-week widgets with the window they actually cover
function labelRecentWidgets(recent) {
  const range = recent.start && recent.end
    ? `${fmtDate(recent.start)}–${fmtDate(recent.end)}`
    : 'last 7 days';
  const badge = `<span class="window-pill">Past week · ${esc(range)}</span>`;
  const labels = {
    sleep: 'Bedtime vs the midnight target',
    plant: 'Solo vs social sessions per day',
    activities: 'Things you do repeatedly, ranked by how they actually rate',
  };
  for (const [id, text] of Object.entries(labels)) {
    const card = document.querySelector(`[data-widget="${id}"] .sub`);
    if (card) card.innerHTML = `${esc(text)} ${badge}`;
  }
}

// ---------- today ----------
function renderToday(habits, journal) {
  if (!journal.length) return emptyState('today', 'No journal days read yet.', '📓');
  const j = journal[journal.length - 1];
  if (!j) { $('today').innerHTML = '<p class="note">No journal entries yet.</p>'; return; }
  const hd = habits.days.find((d) => d.date === j.date);
  $('today-title').textContent = 'Latest — ' + fmtDate(j.date);
  $('today-sub').textContent =
    (j.score !== null ? `day score ${j.score}` : 'no day score yet') +
    (j.city ? ` · ${j.city}` : '') +
    (hd ? ` · ${hd.done}/${hd.total} habits` : '');
  $('today').innerHTML = j.activities.length ? j.activities.map((a) =>
    `<div class="today-act"><span class="t">${esc(a.time)}</span><span>${esc(a.title)}${a.location ? ` <span class="note">· ${esc(a.location)}</span>` : ''}</span><span class="r">${a.rating ?? ''}</span></div>`
  ).join('') : '<p class="note">No activities logged for this day yet.</p>';
}

// ---------- heatmap ----------
// A real heatmap: rows are habit groups, each cell's intensity is the share
// of that group's habits completed that day (a continuous 0-100% value).
function renderHeatmap(habits) {
  if (!habits.days.length) return emptyState('heatmap', 'No habit rows read yet — check the Sheet link under 🔗 Data.', '🗓');
  const days = habits.days;
  if (!days.length) { $('heatmap').innerHTML = '<p class="note">No habit data yet — connect your Sheet (🔗 Data).</p>'; return; }
  const CATS = [
    ['Fitness', /cardio|lift|outside|fresh air/i],
    ['Diet', /protein|sugar/i],
    ['Substances', /chief|dome|alcohol/i],
    ['Sleep & screen', /sleep|screen/i],
    ['Social', /meeting|compliment|mother/i],
    ['Money & chores', /spend|chore/i],
  ];
  const groups = CATS.map(([name]) => ({ name, habits: [] }));
  const other = { name: 'Other', habits: [] };
  for (const h of habits.habitNames) {
    const idx = CATS.findIndex(([, re]) => re.test(h));
    (idx >= 0 ? groups[idx] : other).habits.push(h);
  }
  if (other.habits.length) groups.push(other);
  const rows = groups.filter((gr) => gr.habits.length);
  rows.push({ name: 'All habits', habits: habits.habitNames.slice(), summary: true });

  const ramp = (f) => f <= 0 ? 'var(--cell-off)'
    : f < 0.2 ? 'var(--seq-1)' : f < 0.4 ? 'var(--seq-2)' : f < 0.6 ? 'var(--seq-3)'
    : f < 0.8 ? 'var(--seq-4)' : f < 1 ? 'var(--seq-5)' : 'var(--seq-6)';

  const labelW = 150, cell = 42, gap = 3, rowH = 36, topH = 26;
  const W = labelW + days.length * (cell + gap) + 60;
  const H = topH + rows.length * rowH + 6;
  let g = '';
  days.forEach((d, i) => {
    g += `<text x="${labelW + i * (cell + gap) + cell / 2}" y="${topH - 8}" text-anchor="middle" class="axis-label">${fmtDate(d.date)}</text>`;
  });
  rows.forEach((row, r) => {
    const yy = topH + r * rowH;
    g += `<text x="${labelW - 8}" y="${yy + rowH / 2 + 3}" text-anchor="end" style="font-size:11px${row.summary ? ';font-weight:700' : ''}" fill="var(--ink-2)">${esc(row.name)}</text>`;
    let sum = 0;
    days.forEach((d, i) => {
      const done = row.habits.filter((h) => d.values[h]).length;
      const f = done / row.habits.length;
      sum += f;
      const detail = [`<b>${done}/${row.habits.length}</b> (${Math.round(f * 100)}%)`];
      if (!row.summary) detail.push(...row.habits.map((h) => `${d.values[h] ? '✓' : '✗'} ${h}`));
      g += `<rect x="${labelW + i * (cell + gap)}" y="${yy}" width="${cell}" height="${rowH - gap}" rx="8" fill="${ramp(f)}" data-tt="${tt(`${row.name} — ${fmtDate(d.date)} (${d.weekday})`, detail)}"/>`;
    });
    g += `<text x="${labelW + days.length * (cell + gap) + 8}" y="${yy + rowH / 2 + 3}" class="val-label">${Math.round((sum / days.length) * 100)}%</text>`;
  });
  $('heatmap').innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="max-width:none">${g}</svg>
    <div class="legend">
      <span class="key">share of group hit:</span>
      <span class="key"><span class="swatch" style="background:var(--cell-off)"></span>0%</span>
      <span class="key"><span class="swatch" style="background:var(--seq-2)"></span>25%</span>
      <span class="key"><span class="swatch" style="background:var(--seq-3)"></span>50%</span>
      <span class="key"><span class="swatch" style="background:var(--seq-4)"></span>75%</span>
      <span class="key"><span class="swatch" style="background:var(--seq-6)"></span>100%</span>
    </div>`;
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- habit bars ----------
function renderHabitBars(perHabit) {
  if (!perHabit.length) return emptyState('habit-bars', 'No habit columns found in your Sheet yet.', '📊');
  if (!perHabit.length) { $('habit-bars').innerHTML = '<p class="note">No habits found in the sheet yet.</p>'; return; }
  const sorted = [...perHabit].sort((a, b) => b.rate - a.rate);
  $('habit-bars').innerHTML = sorted.map((h) => {
    const pct = Math.round(h.rate * 100);
    const streak = h.currentStreak >= 2 ? `<span class="pill hot">🔥 ${h.currentStreak}d</span>` : '';
    return `<div class="rowbar" style="margin:7px 0" data-tt="${tt(h.name, [`Done <b>${h.done}/${h.total}</b> days (${pct}%)`, `Current streak ${h.currentStreak} · best ${h.bestStreak}`])}">
      <span style="width:190px;font-size:12px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.name)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(pct, 1)}%;background:var(--green)"></span></span>
      <span style="width:38px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px">${pct}%</span>
      <span style="width:56px">${streak}</span></div>`;
  }).join('');
}

// ---------- impact dumbbells ----------
function renderImpact(impact) {
  if (!impact.length) return emptyState('impact', 'Needs a few more logged days before habits can be compared against day scores.', '🔍');
  if (!impact.length) { $('impact').innerHTML = '<p class="note">Not enough overlapping journal + habit days yet.</p>'; return; }
  const W = 520, rowH = 30, padL = 190, padR = 60, topH = 20;
  const H = topH + impact.length * rowH + 24;
  const x = (v) => padL + (v / 10) * (W - padL - padR);
  let g = '';
  for (const v of [0, 5, 10]) {
    g += `<line x1="${x(v)}" x2="${x(v)}" y1="${topH}" y2="${H - 22}" stroke="var(--grid)"/>`;
    g += `<text x="${x(v)}" y="${H - 8}" text-anchor="middle" class="axis-label">${v}</text>`;
  }
  impact.forEach((h, i) => {
    const yy = topH + i * rowH + rowH / 2;
    const ttx = tt(h.name, [`With: avg <b>${h.avgWith}</b> (${h.nWith} days)`, `Without: avg <b>${h.avgWithout}</b> (${h.nWithout} days)`]);
    g += `<text x="${padL - 10}" y="${yy + 3}" text-anchor="end" style="font-size:11px" fill="var(--ink-2)">${esc(truncate(h.name, 26))}</text>`;
    g += `<line x1="${x(h.avgWithout)}" x2="${x(h.avgWith)}" y1="${yy}" y2="${yy}" stroke="var(--baseline)" stroke-width="2" data-tt="${ttx}"/>`;
    g += `<circle cx="${x(h.avgWithout)}" cy="${yy}" r="5" fill="var(--seq-3)" data-tt="${ttx}"/>`;
    g += `<circle cx="${x(h.avgWith)}" cy="${yy}" r="5.5" fill="var(--seq-6)" data-tt="${ttx}"/>`;
    const sign = h.delta > 0 ? '+' : '';
    g += `<text x="${W - padR + 8}" y="${yy + 3}" class="val-label" fill="${h.delta >= 0 ? 'var(--good-text)' : 'var(--critical)'}">${sign}${h.delta}</text>`;
  });
  $('impact').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--seq-6)"></span>day score with habit</span>
      <span class="key"><span class="swatch" style="background:var(--seq-3)"></span>without</span>
    </div>`;
}

// ---------- people ----------
function renderPeople(people) {
  // Ranked by how those hangs rate — but the people you actually see come
  // first, so a single lucky hangout can't crowd out a regular. One-offs fill
  // any leftover rows and are flagged as thin evidence.
  const byRating = (a, b) => (b.avgActRating ?? -1) - (a.avgActRating ?? -1) || b.acts - a.acts;
  // Enough real regulars (4+ people at 3+ hangs)? Show only them — otherwise
  // everyone makes the cut.
  const core = people.filter((p) => p.acts >= 3);
  let top;
  if (core.length > 3) {
    top = core.sort(byRating).slice(0, 12);
  } else {
    const regulars = people.filter((p) => p.acts >= 2).sort(byRating);
    const oneOffs = people.filter((p) => p.acts < 2).sort(byRating);
    top = [...regulars, ...oneOffs].slice(0, 12);
  }
  if (!top.length) {
    $('people').innerHTML = `<p class="note">No people detected yet.</p>`;
    return;
  }
  $('people').innerHTML = `<table><tr><th>Person</th><th></th><th class="num">Avg hang</th><th class="num">Avg day</th><th class="num">Hangs</th></tr>` +
    top.map((p) => {
      const w = p.avgActRating !== null ? Math.max(p.avgActRating * 10, 2) : 0;
      return `<tr class="${p.acts < 2 ? 'low-n' : ''}" data-tt="${tt(p.name, [`${p.acts} activities across ${p.days} day(s)`, p.avgDayScore !== null ? `Avg day score together: <b>${p.avgDayScore}</b>` : '', p.avgActRating !== null ? `Avg rating of those hangs: <b>${p.avgActRating}</b>` : '', p.acts < 2 ? '<i>Only one hangout — treat as noise</i>' : ''])}">
        <td>${esc(p.name)}</td>
        <td style="width:38%"><span class="rowbar"><span class="track"><span class="fill" style="width:${w}%;background:var(--blue)"></span></span></span></td>
        <td class="num"><b>${p.avgActRating ?? '—'}</b></td>
        <td class="num">${p.avgDayScore ?? '—'}</td>
        <td class="num">${p.acts}</td></tr>`;
    }).join('') + `</table>`;
}

// ---------- places ----------
function renderPlaces(cities, split) {
  if (!cities.length && !split.home.n && !split.out.n) return emptyState('places', 'No locations logged yet.', '📍');
  if (!cities.length && !split.home.n && !split.out.n) {
    $('places').innerHTML = '<p class="note">No locations in the journal yet — add a city after the day score, or locations to activities.</p>';
    return;
  }
  let html = '<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin-bottom:10px">';
  for (const c of cities) {
    html += `<div class="tile"><div class="label">${esc(c.city)}</div><div class="value">${c.avgScore ?? '—'}</div><div class="delta">${c.days} day${c.days === 1 ? '' : 's'} · avg score</div></div>`;
  }
  html += '</div>';
  html += `<table><tr><th>Setting</th><th class="num">Activities</th><th class="num">Avg rating</th></tr>
    <tr><td>Home / crib / porch</td><td class="num">${split.home.n}</td><td class="num"><b>${split.home.avgRating ?? '—'}</b></td></tr>
    <tr><td>Out in the world</td><td class="num">${split.out.n}</td><td class="num"><b>${split.out.avgRating ?? '—'}</b></td></tr></table>`;
  $('places').innerHTML = html;
}

// ---------- sleep ----------
function renderSleep(sleep, kpis) {
  if (!sleep.length) return emptyState('sleep', 'No bedtimes read yet — log a line starting with "Sleep" or "Slept".', '🌙');
  if (!sleep.length) { $('sleep').innerHTML = '<p class="note">No sleep entries found.</p>'; return; }
  const W = 520, H = 190, padL = 46, padR = 12;
  const maxAfter = Math.max(...sleep.map((s) => s.bedtimeMin), 60);
  const minBefore = Math.min(...sleep.map((s) => s.bedtimeMin), -30);
  const y = (v) => 18 + ((maxAfter - v) / (maxAfter - minBefore)) * (H - 52);
  const x = (i) => padL + (i + 0.5) * ((W - padL - padR) / sleep.length);
  const bw = Math.min(28, (W - padL - padR) / sleep.length - 6);
  let g = `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--baseline)" stroke-width="1.5"/>
    <text x="${padL - 6}" y="${y(0) + 3}" text-anchor="end" class="axis-label">12am</text>`;
  for (const v of [60, 120, 180]) {
    if (v <= maxAfter) {
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>
        <text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" class="axis-label">${v / 60}am</text>`;
    }
  }
  sleep.forEach((s, i) => {
    const after = s.bedtimeMin > 0;
    const h = Math.abs(y(s.bedtimeMin) - y(0));
    const label = after
      ? `${Math.floor(s.bedtimeMin / 60)}h ${s.bedtimeMin % 60}m past midnight`
      : `${Math.abs(s.bedtimeMin)}m before midnight`;
    g += `<rect x="${x(i) - bw / 2}" y="${Math.min(y(s.bedtimeMin), y(0))}" width="${bw}" height="${Math.max(h, 2)}" rx="3" fill="${after ? 'var(--red)' : 'var(--green)'}" data-tt="${tt(fmtDate(s.date), [`Bedtime: <b>${label}</b>`, s.score !== null ? `Day score: ${s.score}` : ''])}"/>`;
    g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="axis-label">${fmtDate(s.date)}</text>`;
  });
  $('sleep').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--green)"></span>before midnight ✓</span>
      <span class="key"><span class="swatch" style="background:var(--red)"></span>after midnight</span>
    </div>`;
}

// ---------- plant ----------
function renderPlant(plant) {
  if (!plant.daily.length) return emptyState('plant', 'No sessions logged in the past week.', '🌱');
  const days = plant.daily;
  if (!days.length || !plant.total) { $('plant').innerHTML = '<p class="note">No 🌱 sessions in the journal — nothing to chart.</p>'; return; }
  const W = 520, H = 170, padL = 30, padR = 12;
  const maxC = Math.max(...days.map((d) => d.count), 3);
  const y = (v) => 16 + (1 - v / maxC) * (H - 50);
  const x = (i) => padL + (i + 0.5) * ((W - padL - padR) / days.length);
  const bw = Math.min(26, (W - padL - padR) / days.length - 6);
  let g = '';
  for (let v = 1; v <= maxC; v++) {
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>
      <text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" class="axis-label">${v}</text>`;
  }
  days.forEach((d, i) => {
    const ttx = tt(fmtDate(d.date), [`Sessions: <b>${d.count}</b> (${d.solo} solo, ${d.social} social)`, d.score !== null ? `Day score: ${d.score}` : '']);
    let cy = y(0);
    if (d.solo) {
      const h = cy - y(d.solo);
      g += `<rect x="${x(i) - bw / 2}" y="${y(d.solo)}" width="${bw}" height="${h - 1}" rx="3" fill="var(--green)" data-tt="${ttx}"/>`;
      cy = y(d.solo);
    }
    if (d.social) {
      const h = cy - y(d.solo + d.social) - (d.solo ? 2 : 0);
      g += `<rect x="${x(i) - bw / 2}" y="${y(d.solo + d.social)}" width="${bw}" height="${Math.max(h, 1)}" rx="3" fill="var(--blue)" data-tt="${ttx}"/>`;
    }
    g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="axis-label">${fmtDate(d.date)}</text>`;
  });
  g += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--baseline)"/>`;
  const cmp = plant.avgScoreLowUse !== null && plant.avgScoreHighUse !== null
    ? `Days with ≤1 session average day score <b>${plant.avgScoreLowUse}</b> (n=${plant.nLow}); days with 2+ average <b>${plant.avgScoreHighUse}</b> (n=${plant.nHigh}).`
    : '';
  $('plant').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--green)"></span>solo</span>
      <span class="key"><span class="swatch" style="background:var(--blue)"></span>with people</span>
    </div>
    <p class="note" style="margin-top:8px">${plant.total} sessions total${plant.soloShare !== null ? ` · ${plant.soloShare}% solo` : ''}. ${cmp}</p>`;
}

// ---------- wins / focus ----------
function renderWinsFocus(ins) {
  $('wins').innerHTML = ins.wins.length ? ins.wins.map((h) =>
    `<div class="win-item"><span class="ico">✓</span><span>${esc(h.name)}</span><span class="pct">${Math.round(h.rate * 100)}%</span></div>`
  ).join('') : '<p class="note">No habits above 80% yet — closest first in the list to the left.</p>';
  $('focus').innerHTML = ins.focus.map((h) =>
    `<div class="focus-item"><span class="ico">→</span><span>${esc(h.name)}</span><span class="pct">${Math.round(h.rate * 100)}%</span></div>`
  ).join('') || '<p class="note">Nothing under 40% — strong board.</p>';
}

// ---------- weekdays ----------
function renderWeekdays(weekdays) {
  if (!weekdays.some((w) => w.avgScore !== null)) return emptyState('weekdays', 'Needs day scores across a few weekdays.', '📅');
  const W = 330, H = 150, padL = 26, padR = 8;
  const x = (i) => padL + (i + 0.5) * ((W - padL - padR) / 7);
  const y = (v) => 14 + (1 - v / 10) * (H - 46);
  let g = '';
  for (const v of [0, 5, 10]) {
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>
      <text x="${padL - 5}" y="${y(v) + 3}" text-anchor="end" class="axis-label">${v}</text>`;
  }
  weekdays.forEach((w, i) => {
    if (w.avgScore !== null) {
      const h = y(0) - y(w.avgScore);
      g += `<rect x="${x(i) - 12}" y="${y(w.avgScore)}" width="24" height="${Math.max(h, 2)}" rx="3" fill="var(--green)" data-tt="${tt(w.weekday, [`Avg day score: <b>${w.avgScore}</b>`, w.completion !== null ? `Avg habit completion: ${w.completion}%` : '', `${w.n} day(s) logged`])}"/>`;
    }
    g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="axis-label">${w.weekday.slice(0, 2)}</text>`;
  });
  $('weekdays').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

// ---------- activities ----------
// Things you actually repeat, ranked by how they rate. One-offs are noise here
// (a single 10 isn't a pattern), so they get one compact line underneath.
function renderActivities(acts) {
  if (!acts.length) return emptyState('activities', 'No rated activities in the past week.', '⭐');
  if (!acts.length) { $('activities').innerHTML = '<p class="note">No rated activities in the journal yet.</p>'; return; }
  const recurring = acts.filter((a) => a.n >= 2).sort((a, b) => b.avgRating - a.avgRating || b.n - a.n).slice(0, 12);
  const oneOffs = acts.filter((a) => a.n === 1).sort((a, b) => b.avgRating - a.avgRating);

  let html = '';
  if (recurring.length) {
    html += `<table>
      <tr><th>Activity</th><th></th><th class="num">Avg rating</th><th class="num">Times</th></tr>` +
      recurring.map((a) => `<tr>
        <td>${esc(a.title)}</td>
        <td style="width:45%"><span class="rowbar"><span class="track"><span class="fill" style="width:${a.avgRating * 10}%;background:var(--green)"></span></span></span></td>
        <td class="num"><b>${a.avgRating}</b></td><td class="num">${a.n}</td></tr>`).join('') +
      `</table>`;
  } else {
    html += `<p class="note">Nothing repeated yet — keep logging and the pattern will show up here.</p>`;
  }
  if (oneOffs.length) {
    const best = oneOffs.slice(0, 3).map((a) => `${esc(a.title)} (${a.avgRating})`).join(' · ');
    html += `<p class="note" style="margin-top:10px"><b>Best one-offs:</b> ${best}${oneOffs.length > 3 ? ` — and ${oneOffs.length - 3} more done once` : ''}</p>`;
  }
  $('activities').innerHTML = html;
}

boot();
