// Parsers for the two data sources: the habit-tracker grid (CSV or Google
// Sheet values) and the daily-journal text (pasted text or Google Doc body).

// ---------- Habit tracker ----------

// Simple CSV line splitter (handles quoted fields).
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvToRows(text) {
  return text.split(/\r?\n/).filter((l) => l.length).map(splitCsvLine);
}

// rows: array of arrays (first row = header). Returns { habitNames, days }.
// Columns between DATE and "Daily Completion %" are habit columns.
// Rows are kept only if they have a parseable date that is <= today.
function parseHabitRows(rows, today = new Date()) {
  if (!rows || !rows.length) return { habitNames: [], days: [] };
  const header = rows[0].map((h) => String(h || '').trim());
  const dateIdx = header.findIndex((h) => h.toUpperCase() === 'DATE');
  let endIdx = header.findIndex((h) => /daily completion/i.test(h));
  if (endIdx === -1) endIdx = header.length;
  const dayIdx = header.findIndex((h) => h.toUpperCase() === 'DAY');
  const habitCols = [];
  for (let c = dateIdx + 1; c < endIdx; c++) {
    if (header[c]) habitCols.push({ idx: c, name: header[c] });
  }
  const completionIdx = header.findIndex((h) => /daily completion/i.test(h));

  const year = today.getFullYear();
  const days = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[dateIdx]) continue;
    const m = String(row[dateIdx]).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!m) continue;
    let y = m[3] ? Number(m[3]) : year;
    if (y < 100) y += 2000;
    const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
    if (d > today) continue; // pre-filled future rows
    const values = {};
    let done = 0;
    for (const hc of habitCols) {
      const v = String(row[hc.idx] || '').trim().toUpperCase() === 'TRUE';
      values[hc.name] = v;
      if (v) done++;
    }
    let completion = habitCols.length ? done / habitCols.length : 0;
    const sheetPct = completionIdx >= 0 ? String(row[completionIdx] || '').trim() : '';
    if (sheetPct.endsWith('%')) {
      const n = parseFloat(sheetPct);
      if (!Number.isNaN(n)) completion = n / 100;
    }
    days.push({
      date: isoDate(d),
      weekday: dayIdx >= 0 ? String(row[dayIdx] || '').trim() : WEEKDAYS[d.getDay()],
      values,
      done,
      total: habitCols.length,
      completion,
    });
  }
  // Trailing all-false days are almost always "not filled in yet", not real
  // zero days — drop them so they don't poison averages.
  while (days.length && days[days.length - 1].done === 0) days.pop();
  return { habitNames: habitCols.map((h) => h.name), days };
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- Journal ----------

const PLANT_RE = /[\u{1F331}\u{1F343}]/u; // 🌱 🍃
const NAME_ALIASES = {
  duff: 'Duffy', duffy: 'Duffy',
  prodyumna: 'Pradyumna', pradyumna: 'Pradyumna',
};
const NAME_STOPWORDS = new Set(['girl', 'guys', 'etc', 'etc.', 'bvc', 'legs', 'solo', 'stranger', 'listen', 'labs']);

function normalizeName(raw) {
  const first = String(raw).trim().split(/\s+/)[0] || '';
  const t = first.replace(/[^A-Za-z.]/g, '').trim();
  if (!t || t.length < 2) return null;
  const lower = t.toLowerCase();
  if (NAME_STOPWORDS.has(lower)) return null;
  if (NAME_ALIASES[lower]) return NAME_ALIASES[lower];
  return t[0].toUpperCase() + t.slice(1).toLowerCase();
}

function extractPeople(title) {
  const people = [];
  // "w/ X", "w X", "with X" — take the remainder and split on separators
  const m = title.match(/\b(?:w\/|w\b|with)\s*(.+)$/i);
  if (m) {
    for (const part of m[1].split(/[+&,/—–]|\band\b/i)) {
      const n = normalizeName(part);
      if (n && !people.includes(n)) people.push(n);
    }
  }
  return people;
}

function categorize(title, location, people) {
  const t = title.toLowerCase();
  const loc = (location || '').toLowerCase();
  const flags = {};
  if (PLANT_RE.test(title)) flags.plant = true;
  if (/\blift|cardio|softball|volleyball|basketball|\bgym\b|ebike|\brun\b|swim/i.test(t) || /\u{1F3C8}/u.test(title)) flags.fitness = true;
  if (loc.includes('transit') || /^uber|\bbus\b|\btrain\b|started drive|flight/i.test(t)) flags.transit = true;
  if (/^(sleep|slept)\b/.test(t)) flags.sleep = true;
  if (/^woke/.test(t)) flags.wake = true;
  if (/\b(call|meeting|chat|outreach|interview)\b/.test(t)) flags.work = true;
  if (/booze|brews?\b|beer|drink/i.test(t)) flags.booze = true;
  if (!flags.work && (people.length > 0 || /party|birthday|concert|brunch|dinner|linked|hangout/i.test(t))) flags.social = true;
  return flags;
}

// Journal times have no am/pm. For sleep entries, convert to minutes relative
// to midnight: 12:45 -> +45, 1:15 -> +75, 11:30 -> -30 (assumed pm).
function bedtimeMinutes(timeStr) {
  const m = String(timeStr || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 12) h = 0;
  if (h >= 7 && h <= 11) return h * 60 + min - 720;
  return h * 60 + min;
}

// Parse the journal text. Day headers look like "07/21/26 | 3 | Cambridge"
// (score/city optional). Activity lines look like
// "* 10:30 | Title | Location | 8" — bullets optional (Google Docs strips
// them), location optional, "(?)" allowed after times.
function parseJournal(text) {
  const days = [];
  let cur = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s*•●-]+/, '').trim();
    if (!line) continue;
    const dayM = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(?:\|\s*(\d+(?:\.\d+)?)?\s*)?(?:\|\s*(.+))?$/);
    if (dayM) {
      let y = Number(dayM[3]);
      if (y < 100) y += 2000;
      cur = {
        date: isoDate(new Date(y, Number(dayM[1]) - 1, Number(dayM[2]))),
        score: dayM[4] !== undefined && dayM[4] !== '' ? Number(dayM[4]) : null,
        city: dayM[5] ? dayM[5].trim() : null,
        activities: [],
      };
      days.push(cur);
      continue;
    }
    if (!cur || !line.includes('|')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;
    const time = parts[0].replace(/\(\?\)/g, '').trim();
    if (!/^\d{1,2}(:\d{2})?$/.test(time)) continue;
    let title = parts[1] || '';
    let location = null;
    let rating = null;
    if (parts.length >= 4) {
      location = parts[2] || null;
      rating = numOrNull(parts[3]);
    } else if (parts.length === 3) {
      const n = numOrNull(parts[2]);
      if (n !== null) rating = n;
      else location = parts[2] || null;
    }
    const people = extractPeople(title);
    const flags = categorize(title, location, people);
    cur.activities.push({ time, title, location, rating, people, flags });
  }
  // Per-day derived fields
  for (const d of days) {
    const sleepAct = d.activities.find((a) => a.flags.sleep);
    d.bedtimeMin = sleepAct ? bedtimeMinutes(sleepAct.time) : null;
    d.plantCount = d.activities.filter((a) => a.flags.plant).length;
  }
  return days;
}

function numOrNull(s) {
  const t = String(s || '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 10 ? n : null;
}

module.exports = { csvToRows, parseHabitRows, parseJournal, isoDate };
