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
  setupDrawer();
  hydrateWidgetState();
  renderWidgetMenu();
  applyWidgets();
  applyWidgetOrder();
  initDragAndDrop();
  const res = await fetch('/api/data');
  const data = await res.json();
  if (data.error) { $('errors').textContent = 'Failed to build dashboard: ' + data.error; return; }
  $('setup-banner').style.display = data.needsSetup ? '' : 'none';
  if (data.needsConfirm) openDataPage(true);
  if (data.needsSetup) {
    $('coach').innerHTML = '<h2>Daily Coach</h2><p class="note">Connect your Sheet + Doc first — then the coach reads them.</p>';
    $('weekly-coach').innerHTML = '<h2>Weekly Coach</h2><p class="note">Connect your data to get weekly goals.</p>';
  } else {
    loadCoach(false);
    loadWeeklyCoach(false);
  }
  render(data);
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
  html += `<div class="coach-meta">
    <span class="progress">${done}/${c.todos.length} done</span>
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
  html += `<div class="coach-meta">
    <span class="progress">${done}/${w.goals.length} weekly goals</span>
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

// ---------- data page (links + read verification) ----------

function setupDataPage() {
  $('data-btn').onclick = () => openDataPage(!!(STATUS.sheetUrl || STATUS.docUrl));
  $('data-close').onclick = closeDataPage;
  $('sheet-url').value = STATUS.sheetUrl || '';
  $('doc-url').value = STATUS.docUrl || '';
}

// withCheck: also run the parse preview right away (for users who already
// have links and want to verify reads)
function openDataPage(withCheck) {
  $('data-page').classList.add('open');
  if (withCheck) runPreview();
  else $('preview-section').style.display = 'none';
}

function closeDataPage() { $('data-page').classList.remove('open'); }

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

// ---------- render ----------
function render(data) {
  const { habits, journal, insights, source } = data;
  const badge = $('source-badge');
  const live = source.habits === 'google' || source.journal === 'google';
  badge.textContent = live ? 'Live from Google' : 'Local snapshot';
  badge.classList.toggle('live', live);
  $('date-badge').textContent = new Date(data.fetchedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  $('errors').textContent = (source.errors || []).join(' · ');

  renderKpis(insights.kpis);
  renderRhythm(habits, journal);
  renderToday(habits, journal);
  renderHeatmap(habits);
  renderHabitBars(insights.perHabit);
  renderImpact(insights.habitImpact);
  renderPeople(insights.people);
  renderPlaces(insights.cities, insights.locationSplit);
  renderSleep(insights.sleep, insights.kpis);
  renderPlant(insights.plant);
  renderWinsFocus(insights);
  renderWeekdays(insights.weekdays);
  renderActivities(insights.activities);
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

// ---------- today ----------
function renderToday(habits, journal) {
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
  // Ordered by how good days with them are, best first
  const top = people.filter((p) => p.days >= 1)
    .sort((a, b) => (b.avgDayScore ?? -1) - (a.avgDayScore ?? -1) || b.acts - a.acts)
    .slice(0, 10);
  if (!top.length) { $('people').innerHTML = '<p class="note">No people detected yet.</p>'; return; }
  $('people').innerHTML = `<table><tr><th>Person</th><th></th><th class="num">Avg day</th><th class="num">Avg hang</th><th class="num">Hangs</th></tr>` +
    top.map((p) => {
      const w = p.avgDayScore !== null ? Math.max(p.avgDayScore * 10, 2) : 0;
      return `<tr data-tt="${tt(p.name, [`${p.acts} activities across ${p.days} day(s)`, p.avgDayScore !== null ? `Avg day score together: <b>${p.avgDayScore}</b>` : '', p.avgActRating !== null ? `Avg rating of those hangs: <b>${p.avgActRating}</b>` : ''])}">
        <td>${esc(p.name)}</td>
        <td style="width:38%"><span class="rowbar"><span class="track"><span class="fill" style="width:${w}%;background:var(--blue)"></span></span></span></td>
        <td class="num"><b>${p.avgDayScore ?? '—'}</b></td>
        <td class="num">${p.avgActRating ?? '—'}</td>
        <td class="num">${p.acts}</td></tr>`;
    }).join('') + `</table>`;
}

// ---------- places ----------
function renderPlaces(cities, split) {
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
function renderActivities(acts) {
  if (!acts.length) { $('activities').innerHTML = '<p class="note">No rated activities in the journal yet.</p>'; return; }
  // Strictly rating-ordered (ties broken by how often it happens)
  const rows = [...acts].sort((a, b) => b.avgRating - a.avgRating || b.n - a.n).slice(0, 14);
  $('activities').innerHTML = `<table>
    <tr><th>Activity</th><th></th><th class="num">Avg rating</th><th class="num">Times</th></tr>` +
    rows.map((a) => `<tr>
      <td>${esc(a.title)}</td>
      <td style="width:45%"><span class="rowbar"><span class="track"><span class="fill" style="width:${a.avgRating * 10}%;background:var(--green)"></span></span></span></td>
      <td class="num"><b>${a.avgRating}</b></td><td class="num">${a.n}</td></tr>`).join('') +
    `</table>`;
}

boot();
