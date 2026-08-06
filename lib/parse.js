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

// Habit sheets vary a lot between people: header rows in different places,
// category banner rows above the header, unlabelled DAY/DATE columns, extra
// percentage/notes columns, different checkbox representations. So rather than
// assuming a layout, we detect one:
//   1. find the date column (by header text, else by which column holds dates)
//   2. find where the data rows start
//   3. treat any column that is mostly TRUE/FALSE in those rows as a habit
//   4. name each habit from the nearest non-empty cell above the data

const TRUE_SET = new Set(['TRUE', 'YES', 'Y', 'X', '✓', '✔', 'DONE', 'T', '1']);
const FALSE_SET = new Set(['FALSE', 'NO', 'N', 'F', '0']);
const WEEKDAY_SET = new Set([
  'MON', 'TUE', 'TUES', 'WED', 'THU', 'THUR', 'THURS', 'FRI', 'SAT', 'SUN',
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
]);

// null = no signal (blank / not boolean-ish)
function boolCell(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return null;
  if (TRUE_SET.has(s)) return true;
  if (FALSE_SET.has(s)) return false;
  return null;
}

function parseDateCell(v, today) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let y, mo, da;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // ISO
  if (m) { y = +m[1]; mo = +m[2]; da = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/); // M/D or M/D/YY
    if (!m) return null;
    mo = +m[1]; da = +m[2];
    y = m[3] ? +m[3] : today.getFullYear();
    if (y < 100) y += 2000;
  }
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const d = new Date(y, mo - 1, da);
  if (d.getMonth() !== mo - 1) return null; // e.g. 2/31
  // A year-less date far in the future almost always belongs to last year
  if (!m[3] && d - today > 180 * 864e5) d.setFullYear(y - 1);
  return d;
}

const cellText = (v) => String(v ?? '').trim();

function detectLayout(rows, today) {
  const width = Math.max(...rows.map((r) => (r ? r.length : 0)), 0);
  const headerScan = Math.min(rows.length, 8);

  // --- date column: prefer an explicit "DATE" header, else detect by content
  let dateCol = -1, headerRow = -1;
  for (let r = 0; r < headerScan && dateCol < 0; r++) {
    for (let c = 0; c < width; c++) {
      if (/^date$/i.test(cellText(rows[r][c]))) { dateCol = c; headerRow = r; break; }
    }
  }
  if (dateCol < 0) {
    let best = { col: -1, hits: 0 };
    for (let c = 0; c < width; c++) {
      let hits = 0;
      for (const row of rows) if (row && parseDateCell(row[c], today)) hits++;
      if (hits > best.hits) best = { col: c, hits };
    }
    if (best.hits < 3) return null; // not a habit grid
    dateCol = best.col;
  }

  // --- first data row = first row with a real date in that column
  let firstDataRow = rows.findIndex((row) => row && parseDateCell(row[dateCol], today));
  if (firstDataRow < 0) return null;
  if (headerRow < 0 || headerRow >= firstDataRow) headerRow = firstDataRow - 1;

  // --- day-of-week column (optional; we can derive it from the date)
  let dayCol = -1;
  if (headerRow >= 0) {
    for (let c = 0; c < width; c++) {
      if (/^day$/i.test(cellText(rows[headerRow][c]))) { dayCol = c; break; }
    }
  }
  if (dayCol < 0) {
    for (let c = 0; c < width && dayCol < 0; c++) {
      let hits = 0;
      for (let r = firstDataRow; r < rows.length; r++) {
        if (rows[r] && WEEKDAY_SET.has(cellText(rows[r][c]).toUpperCase())) hits++;
      }
      if (hits >= 3) dayCol = c;
    }
  }

  // --- habit columns: mostly-boolean columns among the data rows
  const dataRowCount = rows.length - firstDataRow;
  const minSignal = Math.max(3, Math.floor(dataRowCount * 0.1));
  const habitCols = [];
  for (let c = 0; c < width; c++) {
    if (c === dateCol || c === dayCol) continue;
    let bools = 0, others = 0;
    for (let r = firstDataRow; r < rows.length; r++) {
      const raw = rows[r] ? rows[r][c] : '';
      const b = boolCell(raw);
      if (b !== null) bools++;
      else if (cellText(raw)) others++; // text/percent/number = not a habit column
    }
    if (bools < minSignal || others > bools * 0.2) continue;
    // Name it from the nearest non-empty label above the data
    let name = '';
    for (let r = Math.max(headerRow, 0); r >= 0 && !name; r--) {
      const t = cellText(rows[r] && rows[r][c]);
      if (t && !/^[▾▼v]$/i.test(t)) name = t;
    }
    habitCols.push({ idx: c, name: name || `Habit ${c + 1}` });
  }

  return { dateCol, dayCol, firstDataRow, habitCols };
}

// rows: array of arrays. Returns { habitNames, days, layout }.
function parseHabitRows(rows, today = new Date()) {
  if (!rows || !rows.length) return { habitNames: [], days: [] };
  const grid = rows.map((r) => (Array.isArray(r) ? r : []));
  const layout = detectLayout(grid, today);
  if (!layout || !layout.habitCols.length) return { habitNames: [], days: [] };
  const { dateCol, dayCol, firstDataRow, habitCols } = layout;

  const byDate = new Map();
  for (let r = firstDataRow; r < grid.length; r++) {
    const row = grid[r];
    const d = parseDateCell(row[dateCol], today);
    if (!d) continue;
    if (d > today) continue; // pre-filled future rows
    const values = {};
    let done = 0;
    for (const hc of habitCols) {
      const v = boolCell(row[hc.idx]) === true;
      values[hc.name] = v;
      if (v) done++;
    }
    const iso = isoDate(d);
    byDate.set(iso, {
      date: iso,
      weekday: dayCol >= 0 && cellText(row[dayCol])
        ? cellText(row[dayCol]).toUpperCase().slice(0, 3)
        : WEEKDAYS[d.getDay()],
      values,
      done,
      total: habitCols.length,
      completion: habitCols.length ? done / habitCols.length : 0,
    });
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Trailing all-false days are "not filled in yet", not real zero days
  while (days.length && days[days.length - 1].done === 0) days.pop();
  return { habitNames: habitCols.map((h) => h.name), days, layout };
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
  // Resolve am/pm from ordering: journal entries run chronologically, so each
  // time must be >= the previous one; bump by 12h until it is.
  for (const d of days) {
    let prev = -1;
    for (const a of d.activities) {
      const m = String(a.time).match(/(\d{1,2}):?(\d{2})?/);
      if (!m) { a.minutesOfDay = null; continue; }
      const h = Number(m[1]) % 12;
      const min = Number(m[2] || 0);
      let v = h * 60 + min;
      if (prev < 0) {
        // First entry: 7-11 reads as AM, 12 as noon, 1-6 as afternoon
        const rawH = Number(m[1]);
        if (rawH === 12) v = 720 + min;
        else if (rawH >= 1 && rawH <= 6) v += 720;
      } else {
        while (v < prev && v < prev + 1440) v += 720;
      }
      a.minutesOfDay = v;
      prev = v;
    }
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
