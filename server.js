// Habit + journal dashboard server — multi-user, Mongo-backed, Vercel-ready.
//
// Modes:
// - Hosted / configured: GOOGLE_CLIENT_ID+SECRET set (env or google-credentials.json)
//   → users sign in with Google, paste their Sheet + Doc links, everything is
//   per-user in Mongo (tokens, links, coach state).
// - Local demo: no Google OAuth configured → no login, seed CSV + journal,
//   coach state stored in Mongo under a demo user.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tiny .env loader (keeps the project dependency-light); Vercel injects env directly.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

const express = require('express');
const { google } = require('googleapis');
const { csvToRows, parseHabitRows, parseJournal, parseJournalDebug } = require('./lib/parse');
const { buildInsights } = require('./lib/analytics');
const {
  getCoach, setChecked, replaceTodo,
  getWeeklyCoach, setWeeklyChecked, replaceWeeklyGoal,
  getAdherence, adherenceBlock,
  DEMO_EMAIL,
} = require('./lib/coach');
const { getUser, updateUser } = require('./lib/db');
const { getReport, listReports } = require('./lib/report');
const { listGoals, addGoal, removeGoal, assessGoals, goalsPromptBlock } = require('./lib/goals');

const PORT = process.env.PORT || 5757;
const CREDS_PATH = path.join(__dirname, 'google-credentials.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSION_COOKIE = 'hd_session';
const SESSION_DAYS = 30;
const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- OAuth config ----------

function oauthCreds() {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
  }
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    return c.web || c.installed;
  } catch {
    return null;
  }
}
const demoMode = () => !oauthCreds();

function redirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/oauth2callback`;
}

function makeOAuthClient(req) {
  const c = oauthCreds();
  if (!c) return null;
  return new google.auth.OAuth2(c.client_id, c.client_secret, redirectUri(req));
}

// ---------- session cookies (HMAC-signed, httpOnly) ----------

function signSession(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  try {
    const [payload, sig] = String(token).split('.');
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.email || data.exp < Date.now()) return null;
    return data.email;
  } catch {
    return null;
  }
}

function getSessionEmail(req) {
  const cookies = String(req.headers.cookie || '');
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return m ? verifySession(decodeURIComponent(m[1])) : null;
}

function setSessionCookie(req, res, email) {
  const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(signSession(email))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Resolve the acting user for a request (demo user when OAuth isn't configured).
function userEmailFor(req) {
  const email = getSessionEmail(req);
  if (email) return email;
  return demoMode() ? DEMO_EMAIL : null;
}

// Gate /api/* (except status) behind a user identity.
app.use('/api', (req, res, next) => {
  if (req.path === '/status') return next();
  const email = userEmailFor(req);
  if (!email) return res.status(401).json({ error: 'Not signed in', loginRequired: true });
  req.userEmail = email;
  next();
});

// ---------- auth routes ----------

app.get('/auth/google', (req, res) => {
  const client = makeOAuthClient(req);
  if (!client) return res.status(400).send('Google OAuth not configured — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.');
  res.redirect(client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  }));
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const client = makeOAuthClient(req);
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const email = String(userInfo.email || '').toLowerCase();
    if (!email) throw new Error('Google did not return an email address');

    // Preserve an existing refresh_token if this grant didn't include one
    const existing = await getUser(email);
    const merged = { ...(existing && existing.tokens), ...tokens };
    await updateUser(email, { tokens: merged });

    setSessionCookie(req, res, email);
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Sign-in failed: ' + e.message);
  }
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
  const email = getSessionEmail(req);
  const demo = demoMode();
  let user = null;
  try { user = await getUser(email || (demo ? DEMO_EMAIL : '')); } catch {}
  res.json({
    googleConfigured: !demo,
    loginRequired: !demo && !email,
    loggedIn: !!email,
    demo,
    email: email || (demo ? 'local demo' : null),
    sheetUrl: user ? user.sheetUrl || null : null,
    docUrl: user ? user.docUrl || null : null,
    widgetState: user ? user.widgetState || null : null,
  });
});

// Persist the user's widget setup (mode, order, visibility) so it follows
// them across devices and informs the next day's suggested widgets.
app.post('/api/widgets', async (req, res) => {
  try {
    const s = req.body || {};
    await updateUser(req.userEmail, {
      widgetState: {
        mode: s.mode || 'suggested',
        order: Array.isArray(s.order) ? s.order : null,
        prefs: s.prefs || {},
        suggestedOverrides: s.suggestedOverrides || {},
        lastVisible: Array.isArray(s.lastVisible) ? s.lastVisible : null,
        savedAt: new Date().toISOString(),
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const fields = {};
    if ('sheetUrl' in req.body) fields.sheetUrl = String(req.body.sheetUrl || '').trim() || null;
    if ('docUrl' in req.body) fields.docUrl = String(req.body.docUrl || '').trim() || null;
    fields.dataConfirmed = false; // new links -> re-confirm the parse
    await updateUser(req.userEmail, fields);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What did we actually parse? Most recent day from each source, so the user
// can confirm their (possibly slightly different) format was read correctly.
app.get('/api/preview', async (req, res) => {
  try {
    const data = await loadDashboardData(req);
    // Check against the previous day, not today — yesterday's log is complete,
    // today's usually isn't. Fall back to the most recent completed day.
    const todayKey = new Date().toISOString().slice(0, 10);
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yesterdayKey = y.toISOString().slice(0, 10);
    const pick = (list, getDate) => {
      if (!list.length) return { day: null, label: '' };
      const prev = list.filter((d) => getDate(d) < todayKey);
      const day = prev.length ? prev[prev.length - 1] : list[list.length - 1];
      const label = getDate(day) === yesterdayKey ? 'yesterday'
        : getDate(day) < todayKey ? 'most recent completed day'
        : 'latest day (today — still in progress)';
      return { day, label };
    };
    const { day: lastH, label: labelH } = pick(data.habits.days, (d) => d.date);
    const { day: lastJ, label: labelJ } = pick(data.journal, (d) => d.date);
    res.json({
      errors: data.source.errors,
      habits: {
        daysParsed: data.habits.days.length,
        habitCount: data.habits.habitNames.length,
        habitNames: data.habits.habitNames,
        tab: data.source.sheetTab || null,
        tabs: data.source.sheetTabs || null,
        tabPickedBy: data.source.sheetTabPickedBy || null,
        label: labelH,
        last: lastH ? {
          date: lastH.date,
          weekday: lastH.weekday,
          done: data.habits.habitNames.filter((h) => lastH.values[h]),
          missed: data.habits.habitNames.filter((h) => !lastH.values[h]),
        } : null,
      },
      journal: {
        daysParsed: data.journal.length,
        label: labelJ,
        last: lastJ ? {
          date: lastJ.date,
          score: lastJ.score,
          city: lastJ.city,
          activities: lastJ.activities.map((a) => ({ time: a.time, title: a.title, location: a.location, rating: a.rating })),
        } : null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Line-by-line account of how the journal was read, so a user whose format
// differs can see exactly which lines were dropped and why.
app.get('/api/parse-debug', async (req, res) => {
  try {
    const email = req.userEmail;
    let journalText = '';
    let habitRows = [];
    const notes = [];

    if (email === DEMO_EMAIL) {
      try { journalText = fs.readFileSync(path.join(__dirname, 'seed-journal.txt'), 'utf8'); } catch {}
      try { habitRows = csvToRows(fs.readFileSync(path.join(__dirname, 'seed-habits.csv'), 'utf8')); } catch {}
    } else {
      const user = await getUser(email);
      const client = authedClientForUser(req, user);
      if (!client) notes.push('Not connected to Google yet.');
      if (client && user.docUrl) {
        try { journalText = await fetchDocText(client, user.docUrl); }
        catch (e) { notes.push('Doc fetch failed: ' + e.message); }
      } else if (!user || !user.docUrl) notes.push('No journal Doc linked.');
      if (client && user.sheetUrl) {
        try { habitRows = await fetchSheetRows(client, user.sheetUrl); }
        catch (e) { notes.push('Sheet fetch failed: ' + e.message); }
      } else if (!user || !user.sheetUrl) notes.push('No habit Sheet linked.');
    }

    const habits = parseHabitRows(habitRows, new Date());
    res.json({
      journal: parseJournalDebug(journalText),
      sheet: {
        rows: habitRows.length,
        header: habitRows.length ? habitRows[0].filter(Boolean).slice(0, 30) : [],
        habitNames: habits.habitNames,
        daysParsed: habits.days.length,
      },
      notes,
      hasDoc: !!journalText,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/confirm-data', async (req, res) => {
  try {
    await updateUser(req.userEmail, { dataConfirmed: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Google data fetching ----------

function extractId(url, kind) {
  if (!url) return null;
  const m = String(url).match(
    kind === 'sheet' ? /spreadsheets\/d\/([\w-]+)/ : /document\/d\/([\w-]+)/
  );
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(String(url).trim()) ? String(url).trim() : null;
}

function authedClientForUser(req, user) {
  if (!user || !user.tokens) return null;
  const client = makeOAuthClient(req);
  if (!client) return null;
  client.setCredentials(user.tokens);
  client.on('tokens', (t) => {
    updateUser(user.email, { tokens: { ...user.tokens, ...t } }).catch(() => {});
  });
  return client;
}

// A Sheets URL usually carries #gid=… identifying the exact tab the user was
// looking at — that's the authoritative choice. Shared trackers often have one
// tab per person, so when there's no gid we fall back to: a tab whose name
// looks like the user, else whichever tab parses to the most logged days.
async function fetchSheetRows(client, sheetUrl, { userEmail = '' } = {}) {
  const id = extractId(sheetUrl, 'sheet');
  if (!id) throw new Error('Bad sheet URL');
  const gidMatch = String(sheetUrl).match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? Number(gidMatch[1]) : null;

  const sheets = google.sheets({ version: 'v4', auth: client });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
  const props = meta.data.sheets.map((s) => s.properties);
  if (!props.length) throw new Error('Spreadsheet has no tabs');
  const tabs = props.map((p) => p.title);

  const byGid = gid !== null ? props.find((p) => p.sheetId === gid) : null;
  if (byGid) {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range: `'${byGid.title}'!A1:BZ2000`,
    });
    return { rows: data.values || [], tab: byGid.title, tabs, pickedBy: 'link' };
  }

  if (tabs.length === 1) {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range: `'${tabs[0]}'!A1:BZ2000`,
    });
    return { rows: data.values || [], tab: tabs[0], tabs, pickedBy: 'only tab' };
  }

  const { data } = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: id,
    ranges: tabs.map((t) => `'${t}'!A1:BZ2000`),
  });
  const parsed = (data.valueRanges || []).map((vr, i) => {
    const rows = vr.values || [];
    let days = 0;
    try { days = parseHabitRows(rows, new Date()).days.length; } catch {}
    return { tab: tabs[i], rows, days };
  });

  // Does a tab name look like this user? ("Karthik (Trial)" for karthik@…)
  const localPart = String(userEmail).split('@')[0].toLowerCase();
  const nameTokens = localPart.split(/[._\-0-9]+/).filter((t) => t.length >= 3);
  const nameMatch = parsed.find((p) =>
    p.days > 0 && nameTokens.some((t) => p.tab.toLowerCase().includes(t)));
  if (nameMatch) return { ...nameMatch, tabs, pickedBy: 'name match' };

  const best = parsed.filter((p) => p.days > 0).sort((a, b) => b.days - a.days)[0];
  if (!best) return { rows: parsed[0].rows, tab: tabs[0], tabs, pickedBy: 'fallback' };
  return { ...best, tabs, pickedBy: 'most data' };
}

async function fetchDocText(client, docUrl) {
  const id = extractId(docUrl, 'doc');
  if (!id) throw new Error('Bad doc URL');
  const docs = google.docs({ version: 'v1', auth: client });
  const { data } = await docs.documents.get({ documentId: id });
  const lines = [];
  for (const el of data.body.content || []) {
    if (!el.paragraph) continue;
    let line = '';
    for (const run of el.paragraph.elements || []) {
      if (run.textRun) line += run.textRun.content;
    }
    lines.push(line.replace(/\n$/, ''));
  }
  return lines.join('\n');
}

async function loadDashboardData(req) {
  const today = new Date();
  const email = req.userEmail;
  const source = { habits: 'seed', journal: 'seed', errors: [] };
  let habitRows = null;
  let journalText = null;
  let needsSetup = false;
  let needsConfirm = false;

  if (email !== DEMO_EMAIL) {
    const user = await getUser(email);
    const client = authedClientForUser(req, user);
    if (!user || (!user.sheetUrl && !user.docUrl)) needsSetup = true;
    else if (!user.dataConfirmed) needsConfirm = true;
    if (client && user.sheetUrl) {
      try {
        const got = await fetchSheetRows(client, user.sheetUrl, { userEmail: email });
        habitRows = got.rows;
        source.habits = 'google';
        source.sheetTab = got.tab;
        source.sheetTabs = got.tabs;
        source.sheetTabPickedBy = got.pickedBy;
      } catch (e) { source.errors.push('Sheet fetch failed: ' + e.message); }
    }
    if (client && user.docUrl) {
      try {
        journalText = await fetchDocText(client, user.docUrl);
        source.journal = 'google';
      } catch (e) { source.errors.push('Doc fetch failed: ' + e.message); }
    }
    // Real users never fall back to the local demo seed data
    if (!habitRows) habitRows = [];
    if (journalText === null) journalText = '';
  } else {
    try { habitRows = csvToRows(fs.readFileSync(path.join(__dirname, 'seed-habits.csv'), 'utf8')); }
    catch { habitRows = []; }
    try { journalText = fs.readFileSync(path.join(__dirname, 'seed-journal.txt'), 'utf8'); }
    catch { journalText = ''; }
  }

  const habits = parseHabitRows(habitRows, today);
  const journal = parseJournal(journalText);
  const insights = buildInsights(habits, journal);
  return { source, needsSetup, needsConfirm, fetchedAt: today.toISOString(), habits, journal, insights };
}

const hasData = (d) => d.habits.days.length || d.journal.length;

// ---------- data + coach API ----------

app.get('/api/data', async (req, res) => {
  try {
    res.json(await loadDashboardData(req));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/coach', async (req, res) => {
  try {
    const data = await loadDashboardData(req);
    if (!hasData(data)) return res.json({ error: 'Add your habit tracker + journal links first (⚙︎ Widgets → Data sources).' });
    let widgetState = null;
    try { widgetState = (await getUser(req.userEmail))?.widgetState || null; } catch {}
    const card = await getCoach(req.userEmail, { ...data, widgetState, force: req.query.refresh === '1' });
    res.json({ ...card, adherence: await getAdherence(req.userEmail) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/coach/check', async (req, res) => {
  try {
    const { date, index, checked } = req.body;
    res.json({ ok: true, checked: await setChecked(req.userEmail, date, Number(index), !!checked) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/coach/fail', async (req, res) => {
  try {
    const { date, index } = req.body;
    const data = await loadDashboardData(req);
    res.json(await replaceTodo(req.userEmail, { date, index: Number(index), ...data }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/coach/weekly', async (req, res) => {
  try {
    const data = await loadDashboardData(req);
    if (!hasData(data)) return res.json({ error: 'Add your habit tracker + journal links first (⚙︎ Widgets → Data sources).' });
    // Stated goals steer the weekly card
    let goalsBlock = '';
    try {
      const goals = await listGoals(req.userEmail);
      if (goals.length) {
        const user = await getUser(req.userEmail);
        goalsBlock = goalsPromptBlock(goals, user && user.goalAssessment);
      }
    } catch {}
    const card = await getWeeklyCoach(req.userEmail, { ...data, goalsBlock, force: req.query.refresh === '1' });
    res.json({ ...card, adherence: await getAdherence(req.userEmail) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/coach/weekly/check', async (req, res) => {
  try {
    const { week, index, checked } = req.body;
    res.json({ ok: true, checked: await setWeeklyChecked(req.userEmail, week, Number(index), !!checked) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/coach/weekly/fail', async (req, res) => {
  try {
    const { week, index } = req.body;
    const data = await loadDashboardData(req);
    res.json(await replaceWeeklyGoal(req.userEmail, { week, index: Number(index), ...data }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- goals ----------

app.get('/api/goals', async (req, res) => {
  try {
    const goals = await listGoals(req.userEmail);
    let assessment = { goals: [], assessedAt: null };
    if (goals.length) {
      const data = await loadDashboardData(req);
      if (hasData(data)) {
        try { assessment = await assessGoals(req.userEmail, { ...data, force: req.query.assess === '1' }); }
        catch (e) { assessment = { goals: [], assessedAt: null, error: e.message }; }
      }
    }
    res.json({ goals, assessment });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/goals', async (req, res) => {
  try {
    res.json({ ok: true, goal: await addGoal(req.userEmail, req.body.text) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/goals/:id', async (req, res) => {
  try {
    res.json({ ok: true, goals: await removeGoal(req.userEmail, req.params.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

app.get('/api/report', async (req, res) => {
  try {
    const data = await loadDashboardData(req);
    if (!hasData(data)) return res.json({ error: 'Connect your Sheet and Doc first (🔗 Data).' });
    let goalsBlock = '';
    try {
      const goals = await listGoals(req.userEmail);
      if (goals.length) {
        const user = await getUser(req.userEmail);
        goalsBlock = goalsPromptBlock(goals, user && user.goalAssessment);
      }
    } catch {}
    let followThrough = '';
    try { followThrough = adherenceBlock(await getAdherence(req.userEmail)); } catch {}
    res.json(await getReport(req.userEmail, {
      ...data,
      goalsBlock: goalsBlock + followThrough,
      start: ISO_DATE.test(req.query.start || '') ? req.query.start : null,
      end: ISO_DATE.test(req.query.end || '') ? req.query.end : null,
      force: req.query.generate === '1',
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/report/history', async (req, res) => {
  try {
    const all = await listReports(req.userEmail);
    res.json({ reports: all });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- boot ----------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Habit dashboard running at http://localhost:${PORT}`);
    console.log(`Mode: ${demoMode() ? 'local demo (no Google OAuth configured)' : 'multi-user (Google sign-in)'}`);
  });
}

module.exports = app;
