// Goals: what the user is actually trying to do, stated in their own words.
// Stored on the user document; progress is assessed by Claude against the
// habit + journal data, since goals are free text ("lift 4x a week", "be in
// bed before 1am", "see friends more than screens").

const Anthropic = require('@anthropic-ai/sdk');
const { getUser, updateUser } = require('./db');

const MODEL = 'claude-opus-5';

const ASSESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goals'],
  properties: {
    goals: {
      type: 'array',
      description: 'One entry per goal given, in the same order. Never invent goals.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'headline', 'metric', 'evidence', 'next_step'],
        properties: {
          id: { type: 'string', description: 'The goal id exactly as given.' },
          status: {
            type: 'string',
            enum: ['on_track', 'close', 'slipping', 'no_signal'],
            description: 'on_track = the data clearly supports it; close = partial; slipping = the data works against it; no_signal = nothing logged that measures this goal.',
          },
          headline: { type: 'string', description: 'One sentence, max ~16 words, on where this goal actually stands. No hedging.' },
          metric: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'value', 'target', 'percent'],
            description: 'The single best measurable proxy for this goal from the data.',
            properties: {
              label: { type: 'string', description: 'What is being measured, max ~6 words, e.g. "Lifts this week".' },
              value: { type: 'string', description: 'Where they are now, e.g. "2" or "1:18am". Empty string if nothing measures it.' },
              target: { type: 'string', description: 'What the goal implies, e.g. "4" or "before 1:00am". Empty string if not inferable.' },
              percent: { type: 'number', description: 'Progress 0-100 for the bar. Use 0 when there is no signal.' },
            },
          },
          evidence: {
            type: 'array',
            description: 'EXACTLY 1-3 short factual lines from the data supporting the status. Cite real numbers, dates, or logged activities.',
            items: { type: 'string', description: 'Max ~18 words.' },
          },
          next_step: { type: 'string', description: 'One concrete move for the next few days that would advance this goal. Max ~14 words.' },
        },
      },
    },
  },
};

const ASSESS_SYSTEM = `You assess progress on a person's stated goals using their tracked habits (true/false per day) and journal (0-10 day scores, timestamped activities rated 0-10).

Rules:
- Judge only from the data given. If nothing in the data measures a goal, say so with status "no_signal" and percent 0 — never guess or flatter.
- Pick the single most honest proxy metric per goal. A goal like "sleep earlier" is measured by bedtime; "lift more" by the lift habit; "see people more" by logged social activities.
- Be concrete and unsentimental. Cite real figures. No pep talk, no moralizing, no generic wellness advice.
- Percent is progress toward the goal as stated, not a grade. A goal with no deadline still gets a sensible reading of recent behaviour.
- Small samples are normal: be honest that a few days is thin evidence rather than overclaiming.

Data notes: 🌱/🍃 = cannabis sessions ("No Chief" is the abstain habit — matter-of-fact, no judgment). bedtime is minutes relative to midnight (75 = 1:15am, -30 = 11:30pm).`;

let client = null;
const getClient = () => (client = client || new Anthropic());

function newId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function listGoals(email) {
  const user = await getUser(email);
  return (user && user.goals) || [];
}

async function addGoal(email, text) {
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) throw new Error('A goal needs some text.');
  const goals = await listGoals(email);
  if (goals.length >= 12) throw new Error('12 goals is plenty — remove one first.');
  const goal = { id: newId(), text: clean, createdAt: new Date().toISOString() };
  await updateUser(email, { goals: [...goals, goal] });
  return goal;
}

async function removeGoal(email, id) {
  const goals = await listGoals(email);
  const next = goals.filter((g) => g.id !== id);
  await updateUser(email, { goals: next });
  const user = await getUser(email);
  // Drop any stale assessment for the removed goal
  const a = user && user.goalAssessment;
  if (a && Array.isArray(a.goals)) {
    await updateUser(email, {
      goalAssessment: { ...a, goals: a.goals.filter((x) => x.id !== id) },
    });
  }
  return next;
}

// Compact view of the data the assessor needs.
function assessSummary(habits, journal, insights) {
  return JSON.stringify({
    habit_completion: insights.perHabit.map((h) =>
      `${h.name}: ${Math.round(h.rate * 100)}% overall (current streak ${h.currentStreak})`),
    recent_days: journal.slice(-14).map((d) => ({
      date: d.date.slice(5),
      score: d.score,
      city: d.city,
      bedtime: d.bedtimeMin,
      activities: d.activities.map((a) =>
        `${a.time} ${a.title}${a.rating !== null ? ' [' + a.rating + '/10]' : ''}`),
    })),
    habit_days: habits.days.slice(-14).map((d) => ({
      date: d.date.slice(5),
      done: Object.keys(d.values).filter((k) => d.values[k]),
    })),
    people: insights.people.slice(0, 12),
    sleep: { avgBedtimeMin: insights.kpis.avgBedtimeMin, beforeMidnightRate: insights.kpis.beforeMidnightRate },
    sessions: insights.plant,
  });
}

async function assessGoals(email, { habits, journal, insights, force = false }) {
  const user = await getUser(email);
  const goals = (user && user.goals) || [];
  if (!goals.length) return { goals: [], assessedAt: null };

  const cached = user && user.goalAssessment;
  const sameSet = cached && Array.isArray(cached.goals)
    && cached.goals.length === goals.length
    && goals.every((g) => cached.goals.some((c) => c.id === g.id));
  const fresh = cached && cached.assessedAt && (Date.now() - new Date(cached.assessedAt)) < 6 * 3600e3;
  if (!force && sameSet && fresh) return { ...cached, cached: true };

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set.');

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: ASSESS_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ASSESS_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Today is ${new Date().toDateString()}.\n\nMY GOALS:\n${goals.map((g) => `- [${g.id}] ${g.text}`).join('\n')}\n\nMY DATA:\n${assessSummary(habits, journal, insights)}\n\nAssess each goal.`,
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('Empty assessment — try again.');
  const parsed = JSON.parse(text.text);

  // Keep the user's own wording alongside the assessment
  const byId = new Map(goals.map((g) => [g.id, g]));
  const merged = (parsed.goals || [])
    .filter((g) => byId.has(g.id))
    .map((g) => ({ ...g, text: byId.get(g.id).text }));

  const assessment = { goals: merged, assessedAt: new Date().toISOString() };
  await updateUser(email, { goalAssessment: assessment });
  return { ...assessment, cached: false };
}

// Text block the coach and report prompts embed so goals steer them.
function goalsPromptBlock(goals, assessment) {
  if (!goals || !goals.length) return '';
  const byId = new Map(((assessment && assessment.goals) || []).map((g) => [g.id, g]));
  const lines = goals.map((g) => {
    const a = byId.get(g.id);
    return `- "${g.text}"` + (a ? ` — currently ${a.status.replace('_', ' ')}: ${a.headline}` : '');
  });
  return `\n\nMY STATED GOALS (these are what I am actually trying to do — weigh them heavily):\n${lines.join('\n')}`;
}

module.exports = { listGoals, addGoal, removeGoal, assessGoals, goalsPromptBlock };
