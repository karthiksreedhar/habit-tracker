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
// Headers that explicitly mark a free-text notes/comments column
const NOTES_HEADER_RE = /^(notes?|comments?|journal|log|remarks?|diary|thoughts?|reflections?|summary|recap)\b/i;

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

  // --- notes/comments columns: free-text context, e.g. for sheet-only users.
  // Two ways in: an explicit notes-ish header (anywhere), or prose-dominated
  // content — but content-detection only near the habit grid, so unrelated
  // text blocks parked far to the right (summary tables etc.) never qualify.
  const colLabel = (c) => {
    let name = '';
    for (let r = Math.max(headerRow, 0); r >= 0 && !name; r--) {
      const t = cellText(rows[r] && rows[r][c]);
      if (t && !/^[▾▼v]$/i.test(t)) name = t;
    }
    return name;
  };
  const maxCoreIdx = Math.max(dateCol, dayCol, ...habitCols.map((h) => h.idx));
  const notesCols = [];
  for (let c = 0; c < width; c++) {
    if (c === dateCol || c === dayCol || habitCols.some((h) => h.idx === c)) continue;
    const name = colLabel(c);
    let prose = 0, other = 0;
    for (let r = firstDataRow; r < rows.length; r++) {
      const raw = rows[r] ? cellText(rows[r][c]) : '';
      if (!raw) continue;
      const isProse = raw.length >= 15 && /\s/.test(raw) && !raw.endsWith('%')
        && boolCell(raw) === null && !parseDateCell(raw, today);
      if (isProse) prose++; else other++;
    }
    if (NOTES_HEADER_RE.test(name) && prose + other >= 1) notesCols.push({ idx: c, name: name || 'Notes' });
    else if (c <= maxCoreIdx + 3 && prose >= 2 && prose >= other) notesCols.push({ idx: c, name: name || 'Notes' });
  }

  return { dateCol, dayCol, firstDataRow, habitCols, notesCols };
}

// rows: array of arrays. Returns { habitNames, days, layout }.
function parseHabitRows(rows, today = new Date()) {
  if (!rows || !rows.length) return { habitNames: [], days: [], notesColumns: [] };
  const grid = rows.map((r) => (Array.isArray(r) ? r : []));
  const layout = detectLayout(grid, today);
  if (!layout || !layout.habitCols.length) return { habitNames: [], days: [], notesColumns: [] };
  const { dateCol, dayCol, firstDataRow, habitCols, notesCols = [] } = layout;

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
    // Free-text note for the day (never counts toward any metric)
    const note = notesCols
      .map((nc) => cellText(row[nc.idx]))
      .filter(Boolean)
      .join(' · ')
      .slice(0, 500) || null;

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
      note,
    });
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Trailing all-false days are "not filled in yet", not real zero days —
  // unless the user wrote a note that day, which proves the row is real.
  while (days.length && days[days.length - 1].done === 0 && !days[days.length - 1].note) days.pop();
  return {
    habitNames: habitCols.map((h) => h.name),
    days,
    layout,
    notesColumns: (layout.notesCols || []).map((n) => n.name),
  };
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
// Words that show up inside a "w/ …" clause but aren't people. Anything here
// also ends the name run, so "w/ Ian from work" yields just Ian.
const NAME_STOPWORDS = new Set([
  // generic people words
  'girl', 'girls', 'guy', 'guys', 'dude', 'dudes', 'friend', 'friends', 'people',
  'family', 'fam', 'roommate', 'roommates', 'coworkers', 'colleagues', 'others',
  'stranger', 'strangers', 'someone', 'everybody', 'somebody', 'boys',
  // connectors / prepositions / filler
  'etc', 'etc.', 'and', 'the', 'a', 'an', 'my', 'his', 'her', 'their', 'our',
  'from', 'at', 'in', 'on', 'to', 'for', 'of', 'about', 'after', 'before',
  'some', 'few', 'more', 'other', 'rest', 'plus', 'via',
  // places/context that trail names in this journal
  'work', 'home', 'school', 'office', 'solo', 'bvc', 'legs', 'listen', 'labs',
]);

// "w/ squad" means "the same people as the previous activity", not a person.
const GROUP_REF_RE = /^(the\s+)?(squad|crew|gang|group|team|same|same\s+(crew|group|people|squad|guys)|everyone|them|all|usual|usuals)$/i;

// One token -> a person's name, or null if it isn't one.
function normalizeName(raw) {
  const t = String(raw).replace(/[^A-Za-z.]/g, '').trim();
  if (!t || t.length < 2) return null;
  const lower = t.toLowerCase().replace(/\.$/, '');
  if (NAME_STOPWORDS.has(lower) || NAME_STOPWORDS.has(t.toLowerCase())) return null;
  if (NAME_ALIASES[lower]) return NAME_ALIASES[lower];
  return t[0].toUpperCase() + t.slice(1).toLowerCase();
}

// People are listed every which way: "w/ Vedant + Duff", "w/ Cory, Meg and Ian",
// "w/ Vedant Duffy Ian" (bare spaces), or "w/ squad" meaning the same group as
// the previous activity. Returns the names found plus whether a group reference
// was used, which parseJournal resolves against the rest of the day.
function extractPeople(title) {
  const people = [];
  let groupRef = false;
  const m = title.match(/\b(?:w\/|w\b|with)\s+(.+)$/i);
  if (m) {
    for (const part of m[1].split(/[+&,/;—–]|\band\b/i)) {
      const chunk = part.trim().replace(/[.!?]+$/, '');
      if (!chunk) continue;
      if (GROUP_REF_RE.test(chunk)) { groupRef = true; continue; }
      // A run of bare names ("Vedant Duffy Ian") is several people; stop the
      // run at the first token that isn't a name ("Ian from work" -> Ian).
      for (const token of chunk.split(/\s+/)) {
        if (GROUP_REF_RE.test(token)) { groupRef = true; break; }
        const n = normalizeName(token);
        if (!n) break;
        if (!people.includes(n)) people.push(n);
      }
    }
  }
  return { people, groupRef };
}

// "Anmol's Birthday", "Post @ Elliot's" — a possessive is a strong signal that
// the word is a person, even with no "w/" anywhere in the line.
const NON_PERSON_POSSESSIVE = new Set([
  'today', 'tonight', 'yesterday', 'tomorrow', 'week', 'month', 'year', 'day',
  'morning', 'afternoon', 'evening', 'night', 'work', 'moms', 'dads', 'friends',
  'someone', 'everyone', 'todays',
]);

// Words that mean an activity, so a title made of them isn't a list of people.
const ACTIVITY_WORDS = new Set([
  'lift', 'lifted', 'gym', 'cardio', 'run', 'ran', 'walk', 'walked', 'bike', 'ebike',
  'swim', 'yoga', 'softball', 'volleyball', 'basketball', 'football', 'tennis', 'golf',
  'sleep', 'slept', 'nap', 'woke', 'wake', 'shower', 'chores', 'chore', 'laundry',
  'call', 'calls', 'meeting', 'meetings', 'chat', 'interview', 'standup', 'sync',
  'work', 'working', 'study', 'read', 'reading', 'write', 'writing', 'code', 'coding',
  'brews', 'brew', 'beer', 'beers', 'booze', 'drinks', 'drink', 'wine', 'bar',
  'dinner', 'lunch', 'brunch', 'breakfast', 'coffee', 'food', 'doordash', 'takeout',
  'uber', 'lyft', 'bus', 'train', 'flight', 'drive', 'transit', 'commute',
  'party', 'concert', 'movie', 'show', 'game', 'gaming', 'shopping', 'errands',
  'therapy', 'doctor', 'dentist', 'class', 'lecture', 'church', 'clean', 'cook',
]);

// A title that is nothing but names ("duffy nina joe") is a hangout. Several
// name-like words in a row is a safe signal; a single bare word is not —
// "Gelato" is a dessert, not a friend — so a lone word only counts when that
// name is established elsewhere in the journal.
function bareNameTitle(title, known) {
  const raw = String(title).trim();
  if (!raw || /\d/.test(raw)) return [];
  const tokens = raw.split(/[^A-Za-z]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 4) return [];
  const out = [];
  for (const t of tokens) {
    if (ACTIVITY_WORDS.has(t.toLowerCase())) return [];
    const n = normalizeName(t);
    if (!n) return [];
    out.push(n);
  }
  if (!out.some((n) => n.length >= 3)) return [];
  if (out.length === 1) return known.has(out[0].toLowerCase()) ? out : [];
  return out;
}

function possessiveNames(title) {
  const out = [];
  for (const m of String(title).matchAll(/\b([A-Za-z]{2,})['’]s\b/g)) {
    const lower = m[1].toLowerCase();
    if (NON_PERSON_POSSESSIVE.has(lower)) continue;
    const n = normalizeName(m[1]);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
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
  if (/🍺|booze|brews?\b|beer|drink/iu.test(t)) flags.booze = true;
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

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// A day header, in whatever shape the writer likes:
//   07/21/26 | 3 | Cambridge      7/21 - 8 - NYC        2026-07-21
//   July 21, 2026 | 8            21 Jul 26 | 7 | Boston
// Returns {date, score, city} or null.
function parseDayHeader(line, fallbackYear) {
  const [head, ...restParts] = line.split(/\s*[|–—]\s*|\s+-\s+/);
  const raw = String(head || '').trim().replace(/[,:]$/, '');
  let y = null, mo = null, da = null;

  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); // 2026-07-21
  if (m) { y = +m[1]; mo = +m[2]; da = +m[3]; }
  if (!m) {
    m = raw.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/); // 7/21 or 07/21/26
    if (m) { mo = +m[1]; da = +m[2]; y = m[3] ? +m[3] : null; }
  }
  if (!m) {
    m = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\w{0,2})?(?:[,\s]+(\d{2,4}))?$/); // July 21, 2026
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
      mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; da = +m[2]; y = m[3] ? +m[3] : null;
    } else m = null;
  }
  if (!m) {
    m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:[,\s]+(\d{2,4}))?$/); // 21 July 2026
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
      da = +m[1]; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = m[3] ? +m[3] : null;
    } else m = null;
  }
  if (!m || !mo || !da || mo > 12 || da > 31) return null;
  if (y === null) y = fallbackYear;
  if (y < 100) y += 2000;

  // Remaining fields in any order: a 0-10 number is the day score, text is the city
  let score = null, city = null;
  for (const partRaw of restParts) {
    const part = String(partRaw).trim();
    if (!part) continue;
    const n = part.match(/^(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10)?$/);
    if (n && score === null && +n[1] <= 10) score = Number(n[1]);
    else if (city === null) city = part;
  }
  return { date: isoDate(new Date(y, mo - 1, da)), score, city, activities: [] };
}

// "10:30", "10:30am", "10am", "22:30", "9.30" -> normalized "10:30"; else null
function parseTimeToken(tok) {
  const t = String(tok || '').replace(/\(\?\)/g, '').trim().toLowerCase();
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\.?$/);
  if (!m) return null;
  const h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (h > 23 || min > 59) return null;
  if (!m[2] && !m[3] && h > 12) return null; // a bare "15" is probably not a time
  return { text: `${h}:${String(min).padStart(2, '0')}`, meridiem: m[3] || null };
}

// Parse the journal. Deliberately forgiving: bullets optional, `|` or tab or
// ` - ` as separators, several date shapes, times with or without am/pm, and
// ratings written "8" or "8/10". Every line that can't be understood is
// reported by parseJournalDebug so the writer can see why.
// A standalone note between day blocks — a big event, milestone, that kind of
// thing. Google Docs highlights/bold arrive with the «!» sentinel from the
// fetcher; plain-text journals qualify structurally (a sentence with no
// time/separator shape).
function looksLikeEventNote(line) {
  return line.length >= 5 && !/^[\W_]+$/.test(line);
}

function parseJournal(text, { onLine } = {}) {
  const days = [];
  let cur = null;
  let pendingMilestones = [];
  const fallbackYear = new Date().getFullYear();
  let lineNo = 0;

  const addMilestone = (line, emphasized, rawLine) => {
    const m = { text: line.slice(0, 200), emphasized };
    if (cur) (cur.milestones = cur.milestones || []).push(m);
    else pendingMilestones.push(m);
    if (onLine) onLine({ lineNo, raw: rawLine, kind: 'event', emphasized });
  };

  for (const rawLine of String(text).split(/\r?\n/)) {
    lineNo++;
    let line = rawLine.replace(/^[\s*•●○▪·+\-–—]+/, '').trim();
    // «!» = the Docs fetcher marked this line as highlighted/bold
    let emphasized = false;
    if (line.startsWith('«!»')) { emphasized = true; line = line.slice(3).trim(); }
    if (!line) { if (onLine) onLine({ lineNo, raw: rawLine, kind: 'blank' }); continue; }

    const header = parseDayHeader(line, fallbackYear);
    if (header) {
      cur = header;
      days.push(cur);
      if (pendingMilestones.length) { cur.milestones = pendingMilestones; pendingMilestones = []; }
      if (onLine) onLine({ lineNo, raw: rawLine, kind: 'day', date: cur.date, score: cur.score, city: cur.city });
      continue;
    }

    // Activity line: split on | first, then tabs, then " - "
    let parts = line.includes('|') ? line.split('|')
      : line.includes('\t') ? line.split('\t')
      : line.split(/\s+[-–—]\s+/);
    parts = parts.map((p) => p.trim()).filter((p, i) => p !== '' || i === 0);

    if (parts.length < 2) {
      // No time/separator shape at all -> a standalone note (big event etc.).
      // Plain text before the first day header is a doc title/preamble, not
      // an event — only emphasized lines count up there.
      if (emphasized || (cur && looksLikeEventNote(line))) addMilestone(line, emphasized, rawLine);
      else if (onLine) onLine({ lineNo, raw: rawLine, kind: 'skipped', reason: cur ? 'Needs at least a time and a title, separated by "|".' : 'Text before the first date line is ignored.' });
      continue;
    }
    if (!cur) {
      if (emphasized) { addMilestone(line, true, rawLine); continue; }
      if (onLine) onLine({ lineNo, raw: rawLine, kind: 'skipped', reason: 'No day header seen yet — add a date line above it.' });
      continue;
    }
    const t = parseTimeToken(parts[0]);
    if (!t) {
      // Highlighted lines are trusted as events even when they contain "|"
      if (emphasized) { addMilestone(line, true, rawLine); continue; }
      if (onLine) onLine({ lineNo, raw: rawLine, kind: 'skipped', reason: `"${parts[0].slice(0, 24)}" isn't a time — activity lines start with one, e.g. "10:30".` });
      continue;
    }
    const time = t.text;
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
    if (onLine) onLine({ lineNo, raw: rawLine, kind: 'activity', time, title, location, rating });
    const { people, groupRef } = extractPeople(title);
    for (const n of possessiveNames(title)) if (!people.includes(n)) people.push(n);
    cur.activities.push({ time, title, location, rating, people, groupRef });
  }

  // Names are resolved in rounds, weakest evidence last. Explicit "w/" clauses
  // and possessives are trustworthy on their own, so they seed the known set;
  // looser signals are only believed once a name is already established.
  const known = new Map(); // lowercase -> display name
  const learn = (names) => { for (const n of names) known.set(n.toLowerCase(), n); };
  for (const d of days) for (const a of d.activities) learn(a.people);

  // Titles that are only names ("duffy nina joe"); a lone word must be known.
  for (const d of days) {
    for (const a of d.activities) {
      if (a.people.length) continue;
      const names = bareNameTitle(a.title, known);
      if (names.length) { a.people.push(...names); learn(names); }
    }
  }

  // Finally, credit known names wherever they appear ("Vedant Crib", "Cory bday")
  for (const d of days) {
    for (const a of d.activities) {
      if (!a.title) continue;
      for (const token of String(a.title).split(/[^A-Za-z]+/)) {
        const hit = known.get(token.toLowerCase());
        if (hit && !a.people.includes(hit)) a.people.push(hit);
      }
    }
  }

  // Resolve group references ("w/ squad") to the last known group that day,
  // then classify — the social flag depends on the resolved people.
  for (const d of days) {
    let lastGroup = [];
    for (const a of d.activities) {
      if (a.groupRef && lastGroup.length) {
        a.people = [...new Set([...lastGroup, ...a.people])];
      }
      if (a.people.length) lastGroup = a.people;
      a.flags = categorize(a.title, a.location, a.people);
    }
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

// "8", "8/10", "8.5" -> 8 ; anything outside 0-10 -> null
function numOrNull(s) {
  const t = String(s || '').trim().replace(/\s*\/\s*10$/, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 10 ? n : null;
}

// Line-by-line account of how the journal was read, for the debugger UI.
function parseJournalDebug(text) {
  const lines = [];
  const days = parseJournal(text, { onLine: (info) => lines.push(info) });
  const counts = { day: 0, activity: 0, skipped: 0, blank: 0 };
  for (const l of lines) counts[l.kind] = (counts[l.kind] || 0) + 1;
  return { lines: lines.filter((l) => l.kind !== 'blank'), counts, days: days.length };
}

module.exports = { csvToRows, parseHabitRows, parseJournal, parseJournalDebug, isoDate };
