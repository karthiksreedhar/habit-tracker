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
  getCachedDaily, getCachedWeekly, isoWeekKey,
  DEMO_EMAIL,
} = require('./lib/coach');
const { getUser, updateUser, deleteUserData, getDb, loadCoachCache } = require('./lib/db');
const { nowInTz, userTz } = require('./lib/tz');
const { getReport, listReports } = require('./lib/report');
const { weatherSeries } = require('./lib/weather');
const { generateWidget, approveWidget, deleteWidget } = require('./lib/custom-widgets');
const { listGoals, addGoal, removeGoal, assessGoals, assessSingleGoal, goalsPromptBlock, linkActivity, unlinkActivity } = require('./lib/goals');
const social = require('./lib/social');

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
  if (req.path.startsWith('/cron/')) return next(); // cron auths via CRON_SECRET
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

// Delete the account: every stored trace of the user, then sign out.
app.delete('/api/account', async (req, res) => {
  try {
    const email = userEmailFor(req);
    if (!email || email === DEMO_EMAIL) return res.status(400).json({ error: 'No account to delete.' });
    await deleteUserData(email);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
        notesColumns: habits.notesColumns || [],
        notedDays: habits.days.filter((d) => d.note).length,
      },
      notes,
      hasDoc: !!journalText,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notes-consent', async (req, res) => {
  try {
    const granted = !!req.body.granted;
    await updateUser(req.userEmail, {
      notesConsent: granted ? 'granted' : 'declined',
      notesConsentAt: new Date().toISOString(),
    });
    res.json({ ok: true, notesConsent: granted ? 'granted' : 'declined' });
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
    let highlighted = false;
    let hasText = false;
    let allBold = true;
    for (const run of el.paragraph.elements || []) {
      if (!run.textRun) continue;
      const t = run.textRun.content;
      line += t;
      if (t.trim()) {
        hasText = true;
        const st = run.textRun.textStyle || {};
        if (st.backgroundColor && st.backgroundColor.color) highlighted = true; // any highlight color
        if (!st.bold) allBold = false;
      }
    }
    line = line.replace(/\n$/, '');
    // Emphasized lines (highlight or fully bold) carry a sentinel the parser
    // understands — how users mark "big event" varies, formatting survives it.
    if (hasText && (highlighted || allBold)) line = '«!» ' + line.trim();
    lines.push(line);
  }
  return lines.join('\n');
}

async function loadDashboardData(req) {
  const today = nowInTz(userTz(req)).date;
  const email = req.userEmail;
  const source = { habits: 'seed', journal: 'seed', errors: [] };
  let habitRows = null;
  let journalText = null;
  let needsSetup = false;
  let needsConfirm = false;
  let notesConsent = null; // 'granted' | 'declined' | null (never asked)
  const missing = []; // which of the two source links are absent

  if (email !== DEMO_EMAIL) {
    const user = await getUser(email);
    notesConsent = user && user.notesConsent ? user.notesConsent : null;
    const client = authedClientForUser(req, user);
    if (!user || !user.sheetUrl) missing.push('sheet');
    if (!user || !user.docUrl) missing.push('doc');
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

  // Sheet notes are consent-gated: detected columns are reported so the UI
  // can ask, but the note text only flows onward after an explicit yes.
  const notesDetected = habits.notesColumns || [];
  const demo = email === DEMO_EMAIL;
  if (!demo && notesConsent !== 'granted') {
    for (const d of habits.days) d.note = null;
  }
  const notesPrompt = !demo && notesDetected.length > 0 && notesConsent === null;

  const insights = buildInsights(habits, journal);
  let customWidgets = [];
  try { customWidgets = ((await getUser(email)) || {}).customWidgets || []; } catch {}
  return {
    source, needsSetup, needsConfirm, missing,
    notesDetected, notesConsent, notesPrompt, customWidgets,
    fetchedAt: today.toISOString(), habits, journal, insights,
  };
}

const hasData = (d) => d.habits.days.length || d.journal.length;

// ---------- data + coach API ----------

// Refresh the user's shared snapshot from freshly-parsed data (no-op unless
// they opted into social). Fire-and-forget from data loads.
async function refreshSocialSnapshot(email, data) {
  const user = await getUser(email);
  if (!user || !user.social || !user.social.enabled) return;
  let adherence = null;
  try { adherence = await getAdherence(email); } catch {}
  await social.updateSnapshot(email, {
    habits: data.habits,
    insights: data.insights,
    goals: user.goals || [],
    goalAssessment: user.goalAssessment || null,
    adherence,
  });
}

app.get('/api/data', async (req, res) => {
  try {
    const data = await loadDashboardData(req);
    const tz = userTz(req);
    if (tz && req.userEmail !== DEMO_EMAIL) updateUser(req.userEmail, { tz }).catch(() => {});
    // If both sources fetched cleanly and parsed real days, the read is
    // self-evidently fine — confirm silently instead of nagging forever.
    if (data.needsConfirm && !data.source.errors.length
        && data.habits.days.length && data.journal.length) {
      await updateUser(req.userEmail, { dataConfirmed: true });
      data.needsConfirm = false;
    }
    res.json(data);
    refreshSocialSnapshot(req.userEmail, data).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- social ----------

app.get('/api/social', async (req, res) => {
  try {
    const user = await getUser(req.userEmail);
    const settings = social.getSettings(user);
    const directory = (await social.listDirectory()).filter((d) => d.email !== req.userEmail);
    const feed = settings.enabled && settings.walkthroughDone
      ? await social.feedFor(req.userEmail)
      : null;
    res.json({ email: req.userEmail, settings, directory, feed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/social/settings', async (req, res) => {
  try {
    const settings = await social.saveSettings(req.userEmail, req.body);
    // Snapshot immediately so the new choices take effect right away
    if (settings.enabled && settings.walkthroughDone) {
      const data = await loadDashboardData(req);
      await refreshSocialSnapshot(req.userEmail, data);
    }
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/social/post', async (req, res) => {
  try {
    const user = await getUser(req.userEmail);
    const settings = social.getSettings(user);
    if (!settings.enabled || !settings.walkthroughDone) {
      return res.status(403).json({ error: 'Finish the social walkthrough first.' });
    }
    res.json({ ok: true, post: await social.addPost(req.userEmail, settings.displayName, req.body.text) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/social/post/:pid', async (req, res) => {
  try {
    await social.deletePost(req.userEmail, req.params.pid);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/coach', async (req, res) => {
  try {
    // History view: read-only card for a past day, no generation
    if (req.query.date) {
      const card = await getCachedDaily(req.userEmail, String(req.query.date));
      return res.json(card || { error: 'No coach card saved for that day.' });
    }
    const data = await loadDashboardData(req);
    if (!hasData(data)) return res.json({ error: 'Add your habit tracker + journal links first (⚙︎ Widgets → Data sources).' });
    let widgetState = null;
    try { widgetState = (await getUser(req.userEmail))?.widgetState || null; } catch {}
    const card = await getCoach(req.userEmail, { ...data, widgetState, tz: userTz(req), force: req.query.refresh === '1' });
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
    res.json(await replaceTodo(req.userEmail, { date, index: Number(index), tz: userTz(req), ...data }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/coach/weekly', async (req, res) => {
  try {
    if (req.query.week) {
      const card = await getCachedWeekly(req.userEmail, String(req.query.week));
      return res.json(card || { error: 'No weekly card saved for that week.' });
    }
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
    const card = await getWeeklyCoach(req.userEmail, { ...data, goalsBlock, tz: userTz(req), force: req.query.refresh === '1' });
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
    res.json(await replaceWeeklyGoal(req.userEmail, { week, index: Number(index), tz: userTz(req), ...data }));
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

// Tag changes re-measure ONLY the affected goal; the rest of the board keeps
// its cached assessment.
app.post('/api/goals/:id/link', async (req, res) => {
  try {
    const goal = await linkActivity(req.userEmail, req.params.id, req.body.phrase);
    const data = await loadDashboardData(req);
    const assessment = await assessSingleGoal(req.userEmail, req.params.id, data);
    res.json({ ok: true, goal, assessment });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/goals/:id/unlink', async (req, res) => {
  try {
    const goal = await unlinkActivity(req.userEmail, req.params.id, req.body.phrase);
    const data = await loadDashboardData(req);
    const assessment = await assessSingleGoal(req.userEmail, req.params.id, data);
    res.json({ ok: true, goal, assessment });
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

// ---------- morning cron: pre-generate coach cards for every user ----------
// Vercel Cron hits this daily (see vercel.json). Auth: Vercel sends
// "Authorization: Bearer $CRON_SECRET" when that env var is set.

app.get('/api/cron/morning', async (req, res) => {
  if (process.env.CRON_SECRET) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'bad cron auth' });
    }
  } else if (!demoMode()) {
    return res.status(401).json({ error: 'CRON_SECRET not configured' });
  }
  try {
    const db = await getDb();
    const users = await db.collection('users')
      .find(
        { tokens: { $exists: true }, $or: [{ sheetUrl: { $ne: null } }, { docUrl: { $ne: null } }] },
        { projection: { email: 1, tz: 1 } }
      ).limit(50).toArray();

    const results = await Promise.allSettled(users.map(async (u) => {
      const email = u.email;
      const tz = u.tz || null;
      const todayKey = nowInTz(tz).key;
      const weekKey = isoWeekKey(nowInTz(tz).date);

      // Cheap pre-check: nothing to do if both cards already exist
      let cache = null;
      try { cache = await loadCoachCache(email); } catch {}
      const hasDaily = !!(cache && cache.days && cache.days[todayKey]);
      const hasWeekly = !!(cache && cache.weeks && cache.weeks[weekKey]);
      if (hasDaily && hasWeekly) return { email, daily: 'cached', weekly: 'cached' };

      // Fake request: enough for data loading + tz-aware generation
      const fakeReq = { userEmail: email, headers: { 'x-tz': tz || '' }, query: {}, protocol: 'https' };
      const data = await loadDashboardData(fakeReq);
      if (!hasData(data)) return { email, daily: 'no-data', weekly: 'no-data' };

      const out = { email, daily: 'cached', weekly: 'cached' };
      if (!hasDaily) {
        const user = await getUser(email);
        await getCoach(email, { ...data, widgetState: (user && user.widgetState) || null, tz });
        out.daily = 'generated';
      }
      if (!hasWeekly) {
        let goalsBlock = '';
        try {
          const goals = await listGoals(email);
          if (goals.length) {
            const user = await getUser(email);
            goalsBlock = goalsPromptBlock(goals, user && user.goalAssessment);
          }
        } catch {}
        await getWeeklyCoach(email, { ...data, goalsBlock, tz });
        out.weekly = 'generated';
      }
      return out;
    }));

    res.json({
      ran: users.length,
      results: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason && r.reason.message || r.reason) })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill a daily card for a past date (same auth as the cron).
// GET /api/cron/backfill?email=...&date=YYYY-MM-DD
app.get('/api/cron/backfill', async (req, res) => {
  if (process.env.CRON_SECRET) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'bad cron auth' });
    }
  } else if (!demoMode()) {
    return res.status(401).json({ error: 'CRON_SECRET not configured' });
  }
  try {
    const email = String(req.query.email || '').toLowerCase();
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'no such user' });
    const tz = user.tz || null;
    const todayKey = nowInTz(tz).key;
    if (date >= todayKey) return res.status(400).json({ error: 'backfill is for past dates — load the app for today\'s card' });
    const floor = new Date(todayKey + 'T12:00:00'); floor.setDate(floor.getDate() - 13);
    if (date < floor.toISOString().slice(0, 10)) return res.status(400).json({ error: 'older than the 14-day card shelf' });

    const fakeReq = { userEmail: email, headers: { 'x-tz': tz || '' }, query: {}, protocol: 'https' };
    const data = await loadDashboardData(fakeReq);
    if (!hasData(data)) return res.status(400).json({ error: 'no readable data for this user (sources: ' + (data.source.errors.join('; ') || 'empty') + ')' });
    const card = await getCoach(email, { ...data, widgetState: user.widgetState || null, tz, forDate: date });
    res.json({ ok: true, date: card.date, headline: card.headline, todos: card.todos.map((t) => t.text), available: card.available });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- custom widgets (user-requested, approval-gated) ----------

app.post('/api/widgets/generate', async (req, res) => {
  try {
    res.json({ ok: true, widget: await generateWidget(req.userEmail, req.body.prompt) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/widgets/custom/:id/approve', async (req, res) => {
  try {
    res.json({ ok: true, widget: await approveWidget(req.userEmail, req.params.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/widgets/custom/:id', async (req, res) => {
  try {
    await deleteWidget(req.userEmail, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Temperature vs day score, from the cities in the journal
app.get('/api/weather', async (req, res) => {
  try {
    const data = await loadDashboardData(req);
    res.json(await weatherSeries(data.journal));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Every generated report is kept (last 24) — this returns the full shelf.
app.get('/api/report/saved', async (req, res) => {
  try {
    res.json({ reports: await listReports(req.userEmail) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
      tz: userTz(req),
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
