// The Life Report: a structured, repeatable read on a 2-week period.
//
// Design: every number the report cites is computed deterministically in
// report-stats.js. The model's job is interpretation — spotting what matters,
// naming patterns, and being honest about confidence — never arithmetic.
// Sections are a fixed list so two reports can be read side by side.

const Anthropic = require('@anthropic-ai/sdk');
const { buildReportStats } = require('./report-stats');
const { loadReports, saveReports } = require('./db');

const MODEL = 'claude-opus-5';
const PERIOD_DAYS = 14;

const SECTION_IDS = [
  'good_day_signature',
  'habits_that_matter',
  'places',
  'people',
  'rhythms_and_sleep',
  'standout_moments',
  'trends',
  'blind_spots',
];

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'executive_summary', 'snapshot', 'sections', 'experiments', 'open_questions', 'since_last_report'],
  properties: {
    title: {
      type: 'string',
      description: 'A specific, non-generic title for this fortnight, max ~9 words. Name the actual theme, e.g. "The two-session tax" — not "Your Life Report".',
    },
    executive_summary: {
      type: 'string',
      description: 'One paragraph (3-5 sentences) a reader could take away on its own: what this fortnight looked like, the single clearest pattern, and the one thing most worth changing. Concrete, grounded in the numbers.',
    },
    snapshot: {
      type: 'array',
      description: 'EXACTLY 4 headline metrics for the period. Use only precomputed values.',
      items: {
        type: 'object', additionalProperties: false, required: ['label', 'value', 'note'],
        properties: {
          label: { type: 'string', description: 'Max ~4 words, e.g. "Avg day score"' },
          value: { type: 'string', description: 'The figure, e.g. "6.3" or "52%"' },
          note: { type: 'string', description: 'Max ~9 words of context, e.g. "up 0.8 from last fortnight"' },
        },
      },
    },
    sections: {
      type: 'array',
      description: 'EXACTLY 8 sections, in the given id order — always all 8, so reports stay comparable across periods.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'heading', 'summary', 'findings'],
        properties: {
          id: { type: 'string', enum: SECTION_IDS },
          heading: { type: 'string', description: 'Short display heading for the section, max ~5 words.' },
          summary: { type: 'string', description: '2-3 sentences framing what this dimension of their life looks like. If the data cannot support this section, say exactly that in one plain sentence instead of speculating.' },
          findings: {
            type: 'array',
            description: '1-3 findings. Each must rest on a specific precomputed number or a specific logged event. Skip a finding rather than pad.',
            items: {
              type: 'object', additionalProperties: false, required: ['claim', 'evidence', 'confidence'],
              properties: {
                claim: { type: 'string', description: 'The pattern, stated plainly in one sentence. Association language, never causal ("goes with", "shows up on") unless it is a tautology.' },
                evidence: { type: 'string', description: 'The specific numbers or events behind it, max ~25 words. Quote precomputed figures exactly.' },
                confidence: {
                  type: 'string',
                  enum: ['strong', 'moderate', 'tentative'],
                  description: 'strong = large effect AND n>=10 days; moderate = clear effect with n>=6; tentative = small sample, weak correlation, or a single instance. When unsure, choose the lower one.',
                },
              },
            },
          },
        },
      },
    },
    experiments: {
      type: 'array',
      description: 'EXACTLY 3 things to try over the NEXT fortnight, each a direct response to a finding above. Tracked-habit or activity moves only — never about texting/calling/seeing a specific person.',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'rationale', 'how_to_measure'],
        properties: {
          text: { type: 'string', description: 'Imperative, concrete, max ~10 words.' },
          rationale: { type: 'string', description: 'Which finding motivates it, max ~15 words.' },
          how_to_measure: { type: 'string', description: 'What number in this report should move, and roughly by how much. Max ~15 words.' },
        },
      },
    },
    open_questions: {
      type: 'array',
      description: '2-3 questions the data cannot currently answer, each paired with the specific thing they would need to start logging to answer it.',
      items: { type: 'string', description: 'Max ~22 words.' },
    },
    since_last_report: {
      type: 'string',
      description: 'If a previous report is provided: 2-3 sentences on what actually changed since then — which experiments moved a number, which patterns held or broke. If no previous report, return an empty string.',
    },
  },
};

const SYSTEM_PROMPT = `You write a fortnightly Life Report for someone who tracks daily habits (true/false per day) and keeps a journal (each day: a 0-10 day score, a city, and timestamped activities each rated 0-10).

THE NUMBERS ARE ALREADY COMPUTED. Every statistic you receive — correlations, averages, deltas, counts, trends — was calculated deterministically from their raw logs. Your job is interpretation, not arithmetic. Quote the provided figures exactly as given. Never compute a new statistic, never estimate, never round differently, and never cite a number that is not in the input.

How to read what you're given:
- Correlation coefficients ("r") come with their sample size ("n"). On these sample sizes: |r| >= 0.6 is a strong signal, 0.35-0.6 moderate, below 0.35 is noise — say so rather than dressing it up. Any finding with n < 6 is at most "tentative", whatever the effect size.
- A "scoreDelta" is the gap in average day score between days a habit was done and days it wasn't. Deltas from very lopsided splits (e.g. 10 days vs 1) are weak evidence — note the imbalance.
- Lagged correlations (bedtime vs NEXT day's score) are more interesting than same-day ones; call that out when the lagged one is stronger.
- Correlation is not causation, and these are self-reported logs from one person. Use association language ("days with X tend to score Y", "X shows up on their best days"). The place to propose causation is the experiments section, as something to test.

Voice and standards:
- Write like a sharp friend who has actually read the data and respects the reader: specific, warm, dry, never a wellness bot. No moralizing, no hedging padding, no "remember to be kind to yourself."
- 🌱/🍃 are cannabis sessions and "No Chief" is the abstain habit. Report what the numbers show, matter-of-factly, with zero judgment either way.
- Every claim must rest on a specific number or a specific named event from their logs. If you cannot ground it, cut it.
- Prefer the surprising true thing over the obvious true thing. "You score higher on days you exercise" is worth saying only if the effect is large; find the non-obvious structure.
- Never invent activities, people, places, or days that are not in the data. Partial data is normal — missing day scores, unrated activities, gaps in logging. Work with what is there, and put what's missing in blind_spots.
- If a whole section has too little data to support anything, say that plainly in its summary and return no findings for it. That is a correct answer, not a failure.

The 8 sections are fixed and always all present, in this order:
1. good_day_signature — what actually separates their high-scoring days from their low ones.
2. habits_that_matter — which tracked habits move with day score, and which are noise despite being tracked diligently.
3. places — cities, venues, home vs out.
4. people — who they spend time with and how those days and hangs rate.
5. rhythms_and_sleep — weekday patterns, time-of-day patterns, bedtime.
6. standout_moments — the specific best and worst logged moments, and what they have in common.
7. trends — what changed across this fortnight and versus the previous one.
8. blind_spots — what this report cannot see: logging gaps, unrated activities, confounds worth naming.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

// Slice both sources down to the report window.
function sliceToPeriod(habits, journal, periodDays) {
  const all = [...habits.days.map((d) => d.date), ...journal.map((d) => d.date)].sort();
  if (!all.length) return { habits, journal, start: null, end: null };
  const end = all[all.length - 1];
  const startDate = new Date(end + 'T12:00:00');
  startDate.setDate(startDate.getDate() - (periodDays - 1));
  const start = isoDate(startDate);
  return {
    habits: { ...habits, days: habits.days.filter((d) => d.date >= start) },
    journal: journal.filter((d) => d.date >= start),
    start, end,
  };
}

async function callModel(params, tag, validate) {
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
    console.log(`[report:${tag}] attempt ${attempt + 1}: model=${response.model} stop=${response.stop_reason} out=${response.usage && response.usage.output_tokens}`);
    if (response.stop_reason === 'refusal') throw new Error('The model declined to generate this report.');
    const text = response.content.find((b) => b.type === 'text');
    lastMeta = `stop_reason: ${response.stop_reason}, model: ${response.model}`;
    if (!text) continue;
    const parsed = JSON.parse(text.text);
    if (validate(parsed)) return parsed;
  }
  throw new Error(`The report came back incomplete twice (${lastMeta}) — try again.`);
}

const pendingReports = new Map();

async function getReport(email, opts) {
  if (pendingReports.has(email)) return pendingReports.get(email);
  const p = generateReport(email, opts).finally(() => pendingReports.delete(email));
  pendingReports.set(email, p);
  return p;
}

// force=false returns the stored report if one exists (generation is slow and
// costly); the UI drives regeneration explicitly.
async function generateReport(email, { habits, journal, insights, force = false }) {
  const store = (await loadReports(email)) || { reports: [] };
  const list = store.reports || [];
  if (!force && list.length) return { ...list[0], cached: true, history: historyOf(list) };

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — add it to .env / Vercel env vars.');
  }

  const period = sliceToPeriod(habits, journal, PERIOD_DAYS);
  if (!period.habits.days.length && !period.journal.length) {
    throw new Error('No logged days in the last two weeks to report on.');
  }

  // Stats for the report window, plus the fortnight before it for comparison
  const stats = buildReportStats(period.habits, period.journal, insights);
  const priorEnd = new Date(period.start + 'T12:00:00');
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - (PERIOD_DAYS - 1));
  const priorHabits = { ...habits, days: habits.days.filter((d) => d.date >= isoDate(priorStart) && d.date <= isoDate(priorEnd)) };
  const priorJournal = journal.filter((d) => d.date >= isoDate(priorStart) && d.date <= isoDate(priorEnd));
  const priorStats = (priorHabits.days.length || priorJournal.length)
    ? buildReportStats(priorHabits, priorJournal, insights)
    : null;

  const previous = list[0] || null;
  let prevBlock = '';
  if (previous) {
    prevBlock = `\n\nMY PREVIOUS REPORT (${previous.periodStart} to ${previous.periodEnd}), for the since_last_report section:\n` +
      JSON.stringify({
        title: previous.title,
        executive_summary: previous.executive_summary,
        section_summaries: (previous.sections || []).map((s) => ({ id: s.id, summary: s.summary })),
        experiments: (previous.experiments || []).map((e) => e.text),
      });
  }

  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: REPORT_SCHEMA }, effort: 'high' },
    messages: [{
      role: 'user',
      content:
        `Write my Life Report for the fortnight ${period.start} to ${period.end} (today is ${new Date().toDateString()}).\n\n` +
        `PRECOMPUTED STATISTICS FOR THIS FORTNIGHT — these are correct; quote them, never recompute:\n${JSON.stringify(stats)}\n\n` +
        (priorStats
          ? `PRECOMPUTED STATISTICS FOR THE PREVIOUS FORTNIGHT (${isoDate(priorStart)} to ${isoDate(priorEnd)}), for the trends section:\n${JSON.stringify({
              period: priorStats.period, dayScore: { mean: priorStats.dayScore.mean, median: priorStats.dayScore.median },
              trends: priorStats.trends, sleep: { avgBedtimeMinutesAfterMidnight: priorStats.sleep.avgBedtimeMinutesAfterMidnight, beforeMidnightRate: priorStats.sleep.beforeMidnightRate },
              sessions: { total: priorStats.sessions.total }, social: { avgScoreSoloDays: priorStats.social.avgScoreSoloDays, avgScoreDaysWithPeople: priorStats.social.avgScoreDaysWithPeople },
            })}\n`
          : `There is no data for the previous fortnight — say so in the trends section rather than comparing.\n`) +
        prevBlock,
    }],
  };

  const result = await callModel(params, 'generate', (p) =>
    p.title && Array.isArray(p.sections) && p.sections.length >= 6 && Array.isArray(p.experiments));

  // Keep sections in canonical order so two reports line up visually
  result.sections = SECTION_IDS
    .map((id) => (result.sections || []).find((s) => s.id === id))
    .filter(Boolean);

  const report = {
    ...result,
    periodStart: period.start,
    periodEnd: period.end,
    periodDays: PERIOD_DAYS,
    daysLogged: period.journal.length || period.habits.days.length,
    generatedAt: new Date().toISOString(),
  };

  const next = [report, ...list].slice(0, 8);
  await saveReports(email, { reports: next });
  return { ...report, cached: false, history: historyOf(next) };
}

function historyOf(list) {
  return list.map((r) => ({
    periodStart: r.periodStart, periodEnd: r.periodEnd,
    title: r.title, generatedAt: r.generatedAt,
  }));
}

async function listReports(email) {
  const store = (await loadReports(email)) || { reports: [] };
  return store.reports || [];
}

module.exports = { getReport, listReports, PERIOD_DAYS };
