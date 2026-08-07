// The Coach engine — per-user, Mongo-backed.
// Daily card: headline + insight + 3 checkable habit to-dos (✗ swaps in a
// replacement), compact keep/ease/try columns, follow-through recognition.
// Weekly card: recap + 3 countable weekly goals (✗ swaps too) + experiment.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { loadCoachCache, saveCoachCache } = require('./db');
const { nowInTz } = require('./tz');

const MODEL = 'claude-opus-5';
const CACHE_VERSION = 4;
const DEMO_EMAIL = 'local@demo';
const LEGACY_FILE = path.join(__dirname, '..', 'coach-cache.json');

const WIDGET_IDS = [
  'coach', 'weekly-coach', 'kpis', 'rhythm', 'today', 'heatmap', 'habit-bars', 'impact',
  'people', 'places', 'sleep', 'plant', 'wins', 'focus', 'weekdays', 'activities',
];

const COACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'insight', 'todos', 'widgets', 'follow_through', 'keep_doing', 'ease_up', 'activity_ideas', 'watch_out'],
  properties: {
    keep_doing: {
      type: 'array',
      description: 'EXACTLY 2 things the data says are working. Tight: title + one short clause.',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'why'],
        properties: { title: { type: 'string', description: 'Max ~5 words' }, why: { type: 'string', description: 'Max ~12 words, cite the number only if striking' } },
      },
    },
    ease_up: {
      type: 'array',
      description: 'EXACTLY 1-2 patterns to cut back on. Same tight format.',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'why'],
        properties: { title: { type: 'string' }, why: { type: 'string' } },
      },
    },
    activity_ideas: {
      type: 'array',
      description: 'EXACTLY 1-2 activity suggestions — concrete things to go do, drawn from what rates highly in the journal (or a plausible variant of it: softball rated 9 → suggest another field session, gelato 8 → a new dessert spot). Lead with the activity itself, not a person.',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'why'],
        properties: { title: { type: 'string', description: 'Max ~6 words' }, why: { type: 'string', description: 'Max ~12 words' } },
      },
    },
    watch_out: {
      type: 'string',
      description: 'One honest heads-up about a trend that could go sideways, one sentence. Empty string if nothing stands out.',
    },
    follow_through: {
      type: 'array',
      description: '0-3 asks from the past week of checklists that the user actually DID — checked off, or clearly evidenced in the journal afterwards. One short line each. Only include items you can verify; empty array when there is no history or nothing was done.',
      items: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', description: 'Max ~20 words: the past ask + proof it happened. Celebratory but dry.' } },
      },
    },
    widgets: {
      type: 'array',
      description: 'The 6-9 dashboard widgets most worth seeing today, chosen to match the headline/insight/todos (e.g. include "sleep" when bedtime is the focus, "people" when the move is social). Always include "coach" and "kpis". Ids: coach (daily card), weekly-coach, kpis (top stats), rhythm (day scores + completion chart), today (latest journal day), heatmap (habit-group grid), habit-bars (completion rates), impact (habits vs day score), people, places, sleep (bedtimes), plant (🌱 sessions), wins, focus (worst habits), weekdays (avg score by weekday), activities (leaderboard).',
      items: { type: 'string', enum: WIDGET_IDS },
    },
    headline: {
      type: 'string',
      description: 'ONE forward-looking sentence for today, max ~16 words. Punchy, specific, zero recap of what already happened. Like a sharp friend texting you in the morning.',
    },
    insight: {
      type: 'string',
      description: 'The single most interesting NON-OBVIOUS pattern in the data, one sentence. Include a number only if it is genuinely striking. Never restate something the dashboard already shows plainly (like a completion percentage).',
    },
    todos: {
      type: 'array',
      description: 'EXACTLY 3 concrete HABIT moves for today, pulled from the tracked habits (lift, cardio, protein, no sugar, screen time, bedtime, spending, outside time, etc.). Specific and startable within the hour ("Lights out by 12:30", "Hit 100g protein by dinner"). NEVER about texting, calling, or seeing people.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'why'],
        properties: {
          text: { type: 'string', description: 'Imperative, max ~9 words.' },
          why: { type: 'string', description: 'Max ~12 words, shown only on hover. The pattern behind it.' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You generate a small daily card for a personal dashboard. The user tracks daily habits (true/false) and a journal (each day: 0-10 day score, city, timestamped activities each rated 0-10 for vibe).

Hard rules:
- NEVER recap the user's day or week back at them. They built the dashboard; they can see the charts. No "you're closing out a strong Friday", no narrating activities they logged.
- No generic wellness advice, no moralizing, no hedging, no disclaimers.
- To-dos are about the tracked habits only — give the exact time, amount, or place ("lights out by 12:30", "100g protein by dinner", "cardio before noon"). Never make a to-do about texting, calling, or seeing a person. Vague intentions ("sleep earlier") are banned.
- Vary the to-dos day to day. If past checklists are provided: never repeat a completed item verbatim; an unchecked item may return only if still worth doing, reworded and at most one of them.
- Voice: a sharp, funny friend who knows the data cold. Brief. Warm but never saccharine.
- Ground everything in the actual data, but quote a number only when it earns its place. Never invent numbers.
- "widgets" must always list 6-9 ids — never leave it empty.
- If a list has nothing genuine to say, return it empty — never pad with placeholders like "N/A" or "None".

Data notes: 🌱/🍃 = cannabis sessions ("No Chief" is the abstain habit — be matter-of-fact, no judgment). bedtime is minutes relative to midnight (75 = 1:15am, -30 = 11:30pm). Sample sizes may be small: treat patterns as signals, not laws. Data may be partial — missing day scores, ratings, cities, sleep entries, or an entire source (journal or habit sheet). Work only with what's present, skip angles the data can't support, and never invent or estimate missing values. big_events on a day are standout notes the user wrote in their journal around that day (often highlighted — marked ⭐) — job offers, breakups, trips, milestones. Weight them heavily for tone and context (congratulate or go easy accordingly, shape asks around them), but reference a given event at most once — never recycle it day after day. habit_sheet_notes are free-text comments the user wrote per day in their habit sheet — for users with no journal, this is the only qualitative signal. Use them exactly like journal text (context, tone, people, hypotheses), but they carry no ratings or scores — never convert them into numbers or treat them as measurements.`;

const WEEKLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'last_week', 'goals', 'experiment'],
  properties: {
    headline: { type: 'string', description: 'The theme for this week, one sentence, max ~14 words. Forward-looking.' },
    last_week: {
      type: 'array',
      description: 'EXACTLY 2-3 short observations about the past 7 days — the weekly recap lives here. Non-obvious, grounded, one line each.',
      items: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', description: 'Max ~18 words' } },
      },
    },
    goals: {
      type: 'array',
      description: 'EXACTLY 3 weekly targets, each countable over the week and drawn from the tracked habits ("Lift 3x", "4 nights lights-out before 12:30", "Keep 5 days under $50"). NEVER about texting/calling/seeing people.',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'why'],
        properties: { text: { type: 'string', description: 'Max ~9 words, countable' }, why: { type: 'string', description: 'Max ~12 words' } },
      },
    },
    experiment: { type: 'string', description: 'One low-friction thing to TRY this week that the data hints would pay off. One sentence.' },
  },
};

const WEEKLY_SYSTEM = `You generate a weekly card for a personal dashboard. Same data as the daily card: tracked habits (true/false per day) and a journal (0-10 day scores, activities rated 0-10 for vibe).

Hard rules:
- "last_week" is the one place a recap belongs — but only non-obvious observations, never narrating what they already see on charts.
- Goals must be countable over the week and about tracked habits only — never about texting, calling, or seeing people.
- No generic wellness advice, no moralizing. Voice: a sharp, funny friend who knows the data cold.
- Ground everything in the actual data; quote a number only when it earns its place. Never invent numbers.
- If stated goals are provided, at least two of the three weekly goals must move a stated goal forward, and the experiment should serve one too. Translate the goal into this week's countable version rather than restating it. Where the data says a goal is slipping, target that one first.

Data notes: 🌱/🍃 = cannabis sessions ("No Chief" is the abstain habit — matter-of-fact, no judgment). bedtime is minutes relative to midnight (75 = 1:15am, -30 = 11:30pm). Small sample: patterns are signals, not laws. Data may be partial — missing day scores, ratings, cities, sleep entries, or an entire source. Work only with what's present and never invent missing values. big_events on a day are standout notes the user wrote in their journal around that day (often highlighted — marked ⭐) — job offers, breakups, trips, milestones. Weight them heavily for tone and context (congratulate or go easy accordingly, shape asks around them), but reference a given event at most once — never recycle it day after day. habit_sheet_notes are free-text comments the user wrote per day in their habit sheet — for users with no journal, this is the only qualitative signal. Use them exactly like journal text (context, tone, people, hypotheses), but they carry no ratings or scores — never convert them into numbers or treat them as measurements.`;

const REPLACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'why'],
  properties: {
    text: { type: 'string', description: 'Imperative, max ~9 words, tracked-habit move.' },
    why: { type: 'string', description: 'Max ~12 words.' },
  },
};

// ---------- helpers ----------

function buildSummary(habits, journal, insights) {
  const days = journal.map((d) => {
    const day = {
      date: d.date.slice(5),
      score: d.score,
      city: d.city,
      bedtime: d.bedtimeMin,
      activities: d.activities.map((a) =>
        `${a.time} ${a.title}${a.location ? ' @' + a.location : ''}${a.rating !== null ? ' [' + a.rating + '/10]' : ''}`
      ),
    };
    if (d.milestones && d.milestones.length) {
      day.big_events = d.milestones.map((m) => (m.emphasized ? '⭐ ' : '') + m.text);
    }
    return day;
  });
  // Free-text notes column from the habit sheet (consent-gated upstream) —
  // for sheet-only users this is the whole qualitative signal.
  const noted = (habits.days || []).filter((d) => d.note);
  const sheetNotes = noted.slice(-30).map((d) => `${d.date.slice(5)}: ${d.note.slice(0, 300)}`);

  const habitLines = insights.perHabit.map((h) =>
    `${h.name}: ${Math.round(h.rate * 100)}% (streak ${h.currentStreak}, best ${h.bestStreak})` +
    (h.avgScoreWith !== null && h.avgScoreWithout !== null
      ? ` | day-score with ${h.avgScoreWith} vs without ${h.avgScoreWithout}`
      : '')
  );
  return JSON.stringify({
    ...(sheetNotes.length ? { habit_sheet_notes: sheetNotes } : {}),
    habit_completion: habitLines,
    journal_days: days,
    people: insights.people,
    cities: insights.cities,
    weekdays: insights.weekdays,
    plant_sessions: insights.plant,
    sleep: { avgBedtimeMinAfterMidnight: insights.kpis.avgBedtimeMin, beforeMidnightRate: insights.kpis.beforeMidnightRate },
  });
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

async function readCache(email) {
  const doc = await loadCoachCache(email);
  if (doc && doc.v === CACHE_VERSION) return { v: doc.v, days: doc.days || {}, weeks: doc.weeks || {} };
  // one-time migration of the old local file cache for local demo mode
  if (!doc && email === DEMO_EMAIL) {
    try {
      const raw = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
      if (raw && raw.v === CACHE_VERSION) return { v: raw.v, days: raw.days || {}, weeks: raw.weeks || {} };
    } catch {}
  }
  return { v: CACHE_VERSION, days: {}, weeks: {} };
}

async function writeCache(email, cache) {
  const days = {};
  for (const k of Object.keys(cache.days).sort().slice(-14)) days[k] = cache.days[k];
  const weeks = {};
  for (const k of Object.keys(cache.weeks || {}).sort().slice(-8)) weeks[k] = cache.weeks[k];
  await saveCoachCache(email, { v: CACHE_VERSION, days, weeks });
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// One structured call with server-side safety fallback + one retry on empty.
async function callStructured(params, tag, validate) {
  let lastMeta = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await getClient().beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (e) {
      if (e.status === 400) response = await getClient().messages.create(params);
      else throw e;
    }
    console.log(`[coach:${tag}] attempt ${attempt + 1}: model=${response.model} stop=${response.stop_reason}`);
    if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
    const text = response.content.find((b) => b.type === 'text');
    lastMeta = `stop_reason: ${response.stop_reason}, model: ${response.model}`;
    if (!text) continue;
    const parsed = JSON.parse(text.text);
    if (validate(parsed)) return parsed;
  }
  throw new Error(`Model returned an empty result twice (${lastMeta}) — try again.`);
}

// ---------- follow-through tracking ----------
// Everything below is derived from the stored cards: what was asked, what got
// checked off, and what was swapped away with the ✗.

function computeAdherence(cache) {
  const dayKeys = Object.keys(cache.days || {}).sort();
  const weekKeys = Object.keys(cache.weeks || {}).sort();
  const recentDays = dayKeys.slice(-14);

  let issued = 0, done = 0, discarded = 0, daysWithAny = 0;
  for (const k of recentDays) {
    const e = cache.days[k];
    const checked = e.checked || [];
    issued += (e.result.todos || []).length;
    const d = checked.filter(Boolean).length;
    done += d;
    discarded += (e.failed || []).length;
    if (d > 0) daysWithAny++;
  }

  // Consecutive days ending today/yesterday with at least one item done
  let streak = 0;
  for (let i = dayKeys.length - 1; i >= 0; i--) {
    const e = cache.days[dayKeys[i]];
    if ((e.checked || []).some(Boolean)) streak++;
    else break;
  }

  const recentWeeks = weekKeys.slice(-8);
  let wIssued = 0, wHit = 0, wDiscarded = 0;
  for (const k of recentWeeks) {
    const e = cache.weeks[k];
    wIssued += (e.result.goals || []).length;
    wHit += (e.checked || []).filter(Boolean).length;
    wDiscarded += (e.failed || []).length;
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  return {
    daily: {
      windowDays: recentDays.length,
      issued, done, discarded,
      completionRate: pct(done, issued),
      discardRate: pct(discarded, issued + discarded),
      daysWithAny,
      streak,
    },
    weekly: {
      windowWeeks: recentWeeks.length,
      issued: wIssued, hit: wHit, discarded: wDiscarded,
      completionRate: pct(wHit, wIssued),
      discardRate: pct(wDiscarded, wIssued + wDiscarded),
    },
  };
}

async function getAdherence(email) {
  return computeAdherence(await readCache(email));
}

// Prompt-ready summary so the report can talk about follow-through honestly.
function adherenceBlock(a) {
  if (!a || (!a.daily.issued && !a.weekly.issued)) return '';
  const lines = [];
  if (a.daily.issued) {
    lines.push(`- Daily checklists (last ${a.daily.windowDays} logged days): ${a.daily.done} of ${a.daily.issued} asks completed (${a.daily.completionRate}%), ${a.daily.discarded} swapped away with the ✗, at least one item done on ${a.daily.daysWithAny} of those days, current streak ${a.daily.streak}.`);
  }
  if (a.weekly.issued) {
    lines.push(`- Weekly goals (last ${a.weekly.windowWeeks} weeks): ${a.weekly.hit} of ${a.weekly.issued} hit (${a.weekly.completionRate}%), ${a.weekly.discarded} abandoned mid-week.`);
  }
  return `\n\nMY FOLLOW-THROUGH ON THE COACH (this is behaviour data too — a high discard rate means the asks were wrong for me, not just that I failed):\n${lines.join('\n')}`;
}

function dailyEntryToResponse(date, entry, cached) {
  return { ...entry.result, date, checked: entry.checked, generatedAt: entry.generatedAt, cached };
}
function weeklyEntryToResponse(week, entry, cached) {
  return { ...entry.result, week, checked: entry.checked, generatedAt: entry.generatedAt, cached };
}

function checklistHistoryBlock(cache, label, keys) {
  if (!keys.length) return '';
  const blocks = keys.map((k) => {
    const e = cache.days[k];
    const lines = e.result.todos.map((t, i) => `  ${e.checked[i] ? '✓ done' : '✗ not done'}: ${t.text}`);
    for (const t of e.failed || []) lines.push(`  ✗ gave up on: ${t.text}`);
    return `${k}:\n${lines.join('\n')}`;
  });
  return `\n\n${label}\n${blocks.join('\n')}`;
}

// ---------- daily ----------

const pendingDaily = new Map();

async function getCoach(email, opts) {
  if (pendingDaily.has(email)) return pendingDaily.get(email);
  const p = generateCoach(email, opts).finally(() => pendingDaily.delete(email));
  pendingDaily.set(email, p);
  return p;
}

async function generateCoach(email, { habits, journal, insights, widgetState = null, tz = null, force = false }) {
  const now = nowInTz(tz);
  const todayKey = now.key;
  const cache = await readCache(email);
  // Drop cards accidentally generated "in the future" by the old UTC bug
  for (const k of Object.keys(cache.days)) if (k > todayKey) delete cache.days[k];
  const existing = cache.days[todayKey];
  if (!force && existing) return { ...dailyEntryToResponse(todayKey, existing, true), available: Object.keys(cache.days).sort() };
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — add it to .env / Vercel env vars.');
  }

  const pastKeys = Object.keys(cache.days).filter((k) => k < todayKey).sort().slice(-7);
  const prevBlock = checklistHistoryBlock(cache, 'My checklists from the past week (✓ = I checked it off):', pastKeys);

  // The user's last widget setup steers today's suggested widgets
  let widgetBlock = '';
  if (widgetState && Array.isArray(widgetState.lastVisible) && widgetState.lastVisible.length) {
    widgetBlock = `\n\nWidgets I kept visible last session: ${widgetState.lastVisible.join(', ')}. For "widgets", bias toward keeping these and only add or drop ones today's focus genuinely calls for.`;
  }

  const summary = buildSummary(habits, journal, insights);
  const params = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: COACH_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Today is ${now.pretty}. Here is my data:\n\n${summary}${prevBlock}${widgetBlock}\n\nGive me today's card.`,
    }],
  };

  const result = await callStructured(params, 'daily', (p) => p.headline && Array.isArray(p.todos) && p.todos.length);
  result.todos = result.todos.slice(0, 3);
  if (!Array.isArray(result.widgets) || result.widgets.length < 3) {
    result.widgets = ['rhythm', 'heatmap', 'people', 'sleep', 'plant', 'wins', 'focus'];
  }
  const entry = {
    result,
    generatedAt: new Date().toISOString(),
    checked: result.todos.map(() => false),
  };
  cache.days[todayKey] = entry;
  await writeCache(email, cache);
  return { ...dailyEntryToResponse(todayKey, entry, false), available: Object.keys(cache.days).sort() };
}

async function setChecked(email, date, index, checked) {
  const cache = await readCache(email);
  const entry = cache.days[date];
  if (!entry) throw new Error('No coach entry for ' + date);
  if (index < 0 || index >= entry.checked.length) throw new Error('Bad todo index');
  entry.checked[index] = !!checked;
  await writeCache(email, cache);
  return entry.checked;
}

async function replaceTodo(email, { date, index, habits, journal, insights, tz = null }) {
  const cache = await readCache(email);
  const entry = cache.days[date];
  if (!entry) throw new Error('No coach entry for ' + date);
  if (index < 0 || index >= entry.result.todos.length) throw new Error('Bad todo index');

  const failedItem = entry.result.todos[index];
  entry.failed = entry.failed || [];
  entry.failed.push(failedItem);

  const summary = buildSummary(habits, journal, insights);
  const now = new Date();
  const listLines = entry.result.todos.map((t, i) =>
    `- ${i === index ? 'JUST FAILED' : entry.checked[i] ? 'done' : 'open'}: ${t.text}`);
  const failedLines = entry.failed.map((t) => `- ${t.text}`);
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: REPLACE_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Today is ${nowInTz(tz).pretty}, it is currently ${nowInTz(tz).hhmm}. Here is my data:\n\n${summary}\n\nToday's checklist:\n${listLines.join('\n')}\n\nAlready failed today (do NOT suggest these again, or near-variants):\n${failedLines.join('\n')}\n\nI just hit ✗ on "${failedItem.text}" — not happening. Give me ONE replacement to-do for the rest of today. Same rules: tracked habits only, concrete, startable now, nothing about texting/calling/seeing people. Pick something still realistic at this hour.`,
    }],
  };

  const replacement = await callStructured(params, 'replace', (p) => !!p.text);
  entry.result.todos[index] = replacement;
  entry.checked[index] = false;
  await writeCache(email, cache);
  return dailyEntryToResponse(date, entry, false);
}

// ---------- weekly ----------

const pendingWeekly = new Map();

async function getWeeklyCoach(email, opts) {
  if (pendingWeekly.has(email)) return pendingWeekly.get(email);
  const p = generateWeekly(email, opts).finally(() => pendingWeekly.delete(email));
  pendingWeekly.set(email, p);
  return p;
}

async function generateWeekly(email, { habits, journal, insights, goalsBlock = '', force = false }) {
  const now = new Date();
  const weekKey = isoWeekKey(now);
  const cache = await readCache(email);
  cache.weeks = cache.weeks || {};
  const existing = cache.weeks[weekKey];
  if (!force && existing) return { ...weeklyEntryToResponse(weekKey, existing, true), available: Object.keys(cache.weeks).sort() };
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — add it to .env / Vercel env vars.');
  }

  const summary = buildSummary(habits, journal, insights);
  const histBlock = checklistHistoryBlock(cache, 'My daily coach checklists recently:', Object.keys(cache.days).sort().slice(-7));

  let pwBlock = '';
  const pw = Object.keys(cache.weeks).filter((k) => k < weekKey).sort().pop();
  if (pw) {
    const e = cache.weeks[pw];
    const lines = e.result.goals.map((g, i) => `  ${e.checked[i] ? '✓ hit' : '✗ missed'}: ${g.text}`);
    for (const g of e.failed || []) lines.push(`  ✗ gave up on: ${g.text}`);
    pwBlock = `\n\nLast week's goals (${pw}):\n${lines.join('\n')}`;
  }

  const params = {
    model: MODEL,
    max_tokens: 8000,
    system: WEEKLY_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: WEEKLY_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Today is ${local.pretty} (ISO week ${weekKey}). Here is my data:\n\n${summary}${histBlock}${pwBlock}${goalsBlock}\n\nGive me this week's card.`,
    }],
  };

  const result = await callStructured(params, 'weekly', (p) => p.headline && Array.isArray(p.goals) && p.goals.length);
  result.goals = result.goals.slice(0, 3);

  const entry = { result, generatedAt: new Date().toISOString(), checked: result.goals.map(() => false) };
  cache.weeks[weekKey] = entry;
  await writeCache(email, cache);
  return { ...weeklyEntryToResponse(weekKey, entry, false), available: Object.keys(cache.weeks).sort() };
}

async function setWeeklyChecked(email, week, index, checked) {
  const cache = await readCache(email);
  cache.weeks = cache.weeks || {};
  const entry = cache.weeks[week];
  if (!entry) throw new Error('No weekly coach entry for ' + week);
  if (index < 0 || index >= entry.checked.length) throw new Error('Bad goal index');
  entry.checked[index] = !!checked;
  await writeCache(email, cache);
  return entry.checked;
}

async function replaceWeeklyGoal(email, { week, index, habits, journal, insights, tz = null }) {
  const cache = await readCache(email);
  cache.weeks = cache.weeks || {};
  const entry = cache.weeks[week];
  if (!entry) throw new Error('No weekly coach entry for ' + week);
  if (index < 0 || index >= entry.result.goals.length) throw new Error('Bad goal index');

  const failedItem = entry.result.goals[index];
  entry.failed = entry.failed || [];
  entry.failed.push(failedItem);

  const summary = buildSummary(habits, journal, insights);
  const now = new Date();
  const listLines = entry.result.goals.map((g, i) =>
    `- ${i === index ? 'JUST FAILED' : entry.checked[i] ? 'hit' : 'open'}: ${g.text}`);
  const failedLines = entry.failed.map((g) => `- ${g.text}`);
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system: WEEKLY_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: REPLACE_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Today is ${nowInTz(tz).pretty} (ISO week ${week}). Here is my data:\n\n${summary}\n\nThis week's goals:\n${listLines.join('\n')}\n\nAlready given up on this week (do NOT suggest these again, or near-variants):\n${failedLines.join('\n')}\n\nI just hit ✗ on "${failedItem.text}" — not happening this week. Give me ONE replacement weekly goal, countable over the REMAINING days of this week, tracked habits only, nothing about texting/calling/seeing people.`,
    }],
  };

  const replacement = await callStructured(params, 'weekly-replace', (p) => !!p.text);
  entry.result.goals[index] = replacement;
  entry.checked[index] = false;
  await writeCache(email, cache);
  return weeklyEntryToResponse(week, entry, false);
}

// Read-only history views for the coach nav arrows.
async function getCachedDaily(email, date) {
  const cache = await readCache(email);
  const entry = cache.days[date];
  if (!entry) return null;
  return { ...dailyEntryToResponse(date, entry, true), available: Object.keys(cache.days).sort() };
}

async function getCachedWeekly(email, week) {
  const cache = await readCache(email);
  const entry = (cache.weeks || {})[week];
  if (!entry) return null;
  return { ...weeklyEntryToResponse(week, entry, true), available: Object.keys(cache.weeks || {}).sort() };
}

module.exports = {
  getCachedDaily, getCachedWeekly,
  getCoach, setChecked, replaceTodo,
  getWeeklyCoach, setWeeklyChecked, replaceWeeklyGoal,
  getAdherence, adherenceBlock,
  DEMO_EMAIL,
};
