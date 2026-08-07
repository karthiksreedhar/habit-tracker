// Social: opt-in sharing between users of the app.
//
// Privacy model, in one place:
// - Nothing is shared until the walkthrough is completed; every field is opt-in.
// - What others see is a SNAPSHOT built from only the fields the owner enabled,
//   refreshed when the owner uses the app. Raw data and tokens never leave
//   the owner's account.
// - Audience is per-owner: 'everyone' (all app users) or a named allowlist.
//   A viewer sees an owner's snapshot/posts only if the owner shares with them.
// - Leaderboards and insight lines are computed per viewer from the snapshots
//   that viewer is allowed to see — deterministically, no model calls.

const crypto = require('crypto');
const { getDb, getUser, updateUser } = require('./db');
const { decryptField } = require('./crypto');

const DEFAULT_SETTINGS = {
  enabled: false,
  walkthroughDone: false,
  displayName: '',
  audience: { mode: 'selected', emails: [] }, // default: share with nobody
  share: {
    habits: { enabled: false, names: [] }, // per-habit opt-in
    habitCompletion: false,
    dayScores: false,
    bedtimes: false,
    sessions: false,   // explicitly sensitive — labeled as such in the UI
    activities: false,
    goals: false,
    adherence: false,
  },
};

function getSettings(user) {
  const s = (user && user.social) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    audience: { ...DEFAULT_SETTINGS.audience, ...(s.audience || {}) },
    share: {
      ...DEFAULT_SETTINGS.share,
      ...(s.share || {}),
      habits: { ...DEFAULT_SETTINGS.share.habits, ...((s.share || {}).habits || {}) },
    },
  };
}

// Whitelist-sanitize settings coming from the client.
function sanitizeSettings(input, email) {
  const s = getSettings({ social: input || {} });
  const emails = Array.isArray(s.audience.emails) ? s.audience.emails : [];
  return {
    enabled: !!s.enabled,
    walkthroughDone: !!s.walkthroughDone,
    displayName: String(s.displayName || '').trim().slice(0, 40) || String(email).split('@')[0],
    audience: {
      mode: s.audience.mode === 'everyone' ? 'everyone' : 'selected',
      emails: [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e !== email))].slice(0, 50),
    },
    share: {
      habits: {
        enabled: !!s.share.habits.enabled,
        names: (Array.isArray(s.share.habits.names) ? s.share.habits.names : []).map((n) => String(n).slice(0, 60)).slice(0, 30),
      },
      habitCompletion: !!s.share.habitCompletion,
      dayScores: !!s.share.dayScores,
      bedtimes: !!s.share.bedtimes,
      sessions: !!s.share.sessions,
      activities: !!s.share.activities,
      goals: !!s.share.goals,
      adherence: !!s.share.adherence,
    },
    updatedAt: new Date().toISOString(),
  };
}

// Does `ownerUser` share with `viewerEmail`?
function sharesWith(ownerUser, viewerEmail) {
  const s = getSettings(ownerUser);
  if (!s.enabled || !s.walkthroughDone) return false;
  if (ownerUser.email === viewerEmail) return true;
  if (s.audience.mode === 'everyone') return true;
  return s.audience.emails.includes(viewerEmail);
}

// Build the snapshot others may see — ONLY fields the owner enabled.
function buildSnapshot(settings, { habits, insights, goals, goalAssessment, adherence }) {
  const sh = settings.share;
  const snap = { displayName: settings.displayName, updatedAt: new Date().toISOString() };
  const k = insights.kpis || {};
  if (sh.habitCompletion) snap.habitCompletion7 = k.completion7 ?? null;
  if (sh.dayScores) snap.avgDayScore7 = k.avgScore7 ?? null;
  if (sh.bedtimes) {
    snap.bedtime = { avgMin: k.avgBedtimeMin ?? null, beforeMidnightRate: k.beforeMidnightRate ?? null };
  }
  if (sh.sessions) snap.sessions7 = insights.recent && insights.recent.plant ? insights.recent.plant.total : null;
  if (sh.activities) {
    snap.topActivities = ((insights.recent && insights.recent.activities) || [])
      .slice(0, 3).map((a) => ({ title: String(a.title).slice(0, 60), avgRating: a.avgRating, n: a.n }));
  }
  if (sh.adherence && adherence && adherence.daily.issued >= 3) {
    snap.adherence = { completionRate: adherence.daily.completionRate, streak: adherence.daily.streak };
  }
  if (sh.goals) {
    const byId = new Map(((goalAssessment && goalAssessment.goals) || []).map((g) => [g.id, g]));
    snap.goals = (goals || []).slice(0, 6).map((g) => {
      const a = byId.get(g.id);
      return { text: String(g.text).slice(0, 120), status: a ? a.status : null, percent: a ? a.metric.percent : null };
    });
  }
  if (sh.habits.enabled && sh.habits.names.length) {
    const wanted = new Set(sh.habits.names.map((n) => n.toLowerCase()));
    snap.habits = (insights.perHabit || [])
      .filter((h) => wanted.has(h.name.toLowerCase()))
      .map((h) => ({ name: h.name, ratePct: Math.round(h.rate * 100), streak: h.currentStreak }));
  }
  return snap;
}

async function saveSettings(email, input) {
  const settings = sanitizeSettings(input, email);
  await updateUser(email, { social: settings });
  return settings;
}

async function updateSnapshot(email, data) {
  const user = await getUser(email);
  const settings = getSettings(user);
  if (!settings.enabled || !settings.walkthroughDone) return null;
  const snap = buildSnapshot(settings, data);
  await updateUser(email, { socialSnapshot: snap });
  return snap;
}

// Users who have opted into social at all (needed to pick an audience).
async function listDirectory() {
  const db = await getDb();
  const rows = await db.collection('users')
    .find({ 'social.enabled': true }, { projection: { email: 1, 'social.displayName': 1 } })
    .limit(100).toArray();
  return rows.map((u) => ({ email: u.email, displayName: (u.social && u.social.displayName) || u.email.split('@')[0] }));
}

// ---------- leaderboards + insight lines (deterministic) ----------

// Minutes relative to midnight (-30 = 11:30pm, 75 = 1:15am) -> clock string.
const fmtBedtime = (min) => {
  if (min === null || min === undefined) return '—';
  const dayMin = ((Math.round(min) % 1440) + 1440) % 1440; // minutes since midnight
  const h24 = Math.floor(dayMin / 60), m = dayMin % 60;
  const ampm = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
};

function buildBoards(members) {
  const boards = [];
  const add = (id, title, emoji, rows, { higherBetter = true, unit = '' } = {}) => {
    const filled = rows.filter((r) => r.value !== null && r.value !== undefined);
    if (!filled.length) return;
    filled.sort((a, b) => (higherBetter ? b.value - a.value : a.value - b.value));
    boards.push({ id, title, emoji, unit, rows: filled });
  };

  add('completion', 'Habit completion (7d)', '✅',
    members.map((m) => ({ name: m.snapshot.displayName, email: m.email, value: m.snapshot.habitCompletion7 ?? null, display: m.snapshot.habitCompletion7 != null ? `${m.snapshot.habitCompletion7}%` : '—' })));
  add('dayscore', 'Avg day score (7d)', '🌞',
    members.map((m) => ({ name: m.snapshot.displayName, email: m.email, value: m.snapshot.avgDayScore7 ?? null, display: m.snapshot.avgDayScore7 != null ? String(m.snapshot.avgDayScore7) : '—' })));
  add('bedtime', 'Earliest average bedtime', '🌙',
    members.map((m) => ({ name: m.snapshot.displayName, email: m.email, value: m.snapshot.bedtime ? m.snapshot.bedtime.avgMin : null, display: m.snapshot.bedtime && m.snapshot.bedtime.avgMin != null ? fmtBedtime(m.snapshot.bedtime.avgMin) : '—' })),
    { higherBetter: false });
  add('adherence', 'Coach follow-through', '🎯',
    members.map((m) => ({ name: m.snapshot.displayName, email: m.email, value: m.snapshot.adherence ? m.snapshot.adherence.completionRate : null, display: m.snapshot.adherence ? `${m.snapshot.adherence.completionRate}%` : '—' })));

  // Per-habit boards where 2+ people share a habit of the same name
  const byHabit = new Map();
  for (const m of members) {
    for (const h of m.snapshot.habits || []) {
      const key = h.name.toLowerCase();
      if (!byHabit.has(key)) byHabit.set(key, { name: h.name, rows: [] });
      byHabit.get(key).rows.push({ name: m.snapshot.displayName, email: m.email, value: h.ratePct, display: `${h.ratePct}%${h.streak >= 2 ? ` · ${h.streak}🔥` : ''}` });
    }
  }
  for (const [key, h] of byHabit) {
    if (h.rows.length >= 2) add('habit:' + key, h.name, '🏅', h.rows);
  }
  return boards;
}

const HABIT_EMOJI = [
  [/lift|gym|strength/i, '🏋️'], [/cardio|run/i, '🏃'], [/sleep|bed/i, '😴'],
  [/protein|sugar|diet|eat/i, '🍗'], [/outside|fresh air/i, '🌳'], [/screen/i, '📱'],
  [/spend|\$/i, '💸'], [/chore/i, '🧹'],
];

function insightLines(boards, members, viewerEmail) {
  const lines = [];
  const multi = members.length >= 2;
  for (const b of boards) {
    if (!b.rows.length) continue;
    const top = b.rows[0];
    const isHabit = b.id.startsWith('habit:');
    if (isHabit && multi) {
      const emoji = (HABIT_EMOJI.find(([re]) => re.test(b.title)) || [null, '🏅'])[1];
      lines.push(`${emoji} Looks like ${top.name}'s been on the "${b.title}" grind — ${top.display} this stretch.`);
    }
    const me = b.rows.findIndex((r) => r.email === viewerEmail);
    if (multi && me > 0 && b.id === 'completion') {
      lines.push(`✅ ${top.name} leads habit completion at ${top.display} — you're #${me + 1} of ${b.rows.length}.`);
    }
  }
  const night = boards.find((b) => b.id === 'bedtime');
  if (night && night.rows.length >= 2) {
    const owl = night.rows[night.rows.length - 1];
    lines.push(`🦉 ${owl.name} is the resident night owl (avg ${owl.display}).`);
  }
  const sesh = members.filter((m) => m.snapshot.sessions7 != null).sort((a, b) => b.snapshot.sessions7 - a.snapshot.sessions7);
  if (sesh.length >= 2 && sesh[0].snapshot.sessions7 > 0) {
    lines.push(`🌱 ${sesh[0].snapshot.displayName} logged the most sessions this week (${sesh[0].snapshot.sessions7}).`);
  }
  for (const m of members) {
    for (const g of m.snapshot.goals || []) {
      if (g.status === 'on_track' && m.email !== viewerEmail) {
        lines.push(`🎯 ${m.snapshot.displayName} is on track for "${g.text}".`);
        break;
      }
    }
  }
  return lines.slice(0, 6);
}

// ---------- bulletin ----------

async function addPost(email, displayName, text) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) throw new Error('Empty post.');
  const db = await getDb();
  const post = { pid: 'p' + crypto.randomBytes(6).toString('hex'), email, displayName, text: clean, createdAt: new Date().toISOString() };
  await db.collection('bulletin').insertOne(post);
  return post;
}

async function deletePost(email, pid) {
  const db = await getDb();
  await db.collection('bulletin').deleteOne({ pid: String(pid), email }); // own posts only
}

// Posts a viewer may see: their own + posts by people who share with them.
async function visiblePosts(viewerEmail, sharers) {
  const db = await getDb();
  const emails = [...new Set([viewerEmail, ...sharers])];
  const rows = await db.collection('bulletin')
    .find({ email: { $in: emails } }).sort({ createdAt: -1 }).limit(50).toArray();
  return rows.map((p) => ({ pid: p.pid, email: p.email, displayName: p.displayName, text: p.text, createdAt: p.createdAt, mine: p.email === viewerEmail }));
}

// ---------- the feed ----------

async function feedFor(viewerEmail) {
  const db = await getDb();
  const candidates = await db.collection('users')
    .find({ 'social.enabled': true }, { projection: { email: 1, social: 1, socialSnapshot: 1 } })
    .limit(200).toArray();
  const visible = candidates
    .map((u) => ({ ...u, socialSnapshot: decryptField(u.socialSnapshot) }))
    .filter((u) => sharesWith(u, viewerEmail) && u.socialSnapshot);
  const members = visible.map((u) => ({ email: u.email, snapshot: u.socialSnapshot }));
  const boards = buildBoards(members);
  const insights = insightLines(boards, members, viewerEmail);
  const posts = await visiblePosts(viewerEmail, visible.map((u) => u.email));
  return { members, boards, insights, posts };
}

module.exports = {
  getSettings, saveSettings, updateSnapshot, listDirectory,
  feedFor, addPost, deletePost, sharesWith,
};
