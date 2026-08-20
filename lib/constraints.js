// Standing constraints the coach must respect.
//
// Captured when the user gives a reason for hitting ✕ on a suggestion. Two
// lifetimes, classified by the model from what the user typed:
//   permanent    — "I'm vegetarian". Never expires.
//   conditional  — "I'm injured". Retires itself the first time the user logs
//                  the unblock habit (e.g. Lift), so lifting suggestions come
//                  back on their own once they're actually lifting again.
//
// Stored on the user doc (encrypted at rest like goals) rather than in the
// coach cache, because they outlive any individual card.

const Anthropic = require('@anthropic-ai/sdk');
const { getUser, updateUser } = require('./db');

const MODEL = 'claude-opus-5';

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rule', 'scope', 'unblock_habit', 'label'],
  properties: {
    rule: {
      type: 'string',
      description:
        'The standing instruction, addressed to the coach, stating what NOT to suggest and what is still fine. ' +
        'One sentence, concrete. E.g. "Never suggest meat or fish; eggs, dairy and plant protein are fine."',
    },
    scope: {
      type: 'string',
      enum: ['permanent', 'conditional'],
      description:
        'permanent = a standing fact about the user (diet, allergy, dislikes, no car). ' +
        'conditional = a temporary state that will end (injury, illness, travel, exam period).',
    },
    unblock_habit: {
      type: ['string', 'null'],
      description:
        'Conditional only: the EXACT tracked habit name whose next logged day should retire this constraint. ' +
        'Choose from the provided habit list only. null for permanent, or if no tracked habit fits.',
    },
    label: {
      type: 'string',
      description: 'Two to four words naming the constraint for a compact UI chip. E.g. "Vegetarian", "Injured — no lifting".',
    },
  },
};

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM = `You turn a user's throwaway reason for rejecting a habit suggestion into a durable rule for their coach.

Rules:
- Capture ONLY what the user actually said. Never invent adjacent restrictions ("vegetarian" does not imply no dairy, no alcohol, or no caffeine).
- State what is still allowed whenever the reason rules something out, so the coach keeps having options.
- "permanent" is for standing facts about the person. "conditional" is for states that will pass.
- For conditional constraints, pick the unblock habit whose next logged day proves the state has passed — for an injury that stopped them lifting, that is the lifting habit itself.
- If the reason is vague or just a mood ("not feeling it", "too busy today"), classify it permanent=false with scope "conditional" and unblock_habit null: it is a one-off, not a rule.`;

async function classifyReason({ reason, item, habitNames }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set.');
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    messages: [{
      role: 'user',
      content:
        `My coach suggested: "${item}"\n` +
        `I rejected it and said: "${reason}"\n\n` +
        `My tracked habits are: ${habitNames.join(', ')}\n\n` +
        `Turn this into a standing rule for the coach.`,
    }],
  });
  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('Model returned nothing to classify.');
  return JSON.parse(text.text);
}

function newId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function listConstraints(email) {
  const user = await getUser(email);
  return (user && user.constraints) || [];
}

async function saveConstraints(email, constraints) {
  await updateUser(email, { constraints });
}

// A conditional constraint dies the first time its unblock habit is logged
// true on a date AFTER the constraint was created. Returns the still-active
// ones, persisting any retirements as a side effect.
async function activeConstraints(email, habits) {
  const all = await listConstraints(email);
  if (!all.length) return [];

  const days = (habits && habits.days) || [];
  let changed = false;
  for (const c of all) {
    if (c.retiredAt || c.scope !== 'conditional' || !c.unblockHabit) continue;
    const done = days.some((d) => d.date > c.createdDate && d.values && d.values[c.unblockHabit]);
    if (done) {
      c.retiredAt = new Date().toISOString();
      c.retiredBy = c.unblockHabit;
      changed = true;
    }
  }
  if (changed) await saveConstraints(email, all);
  return all.filter((c) => !c.retiredAt);
}

async function addConstraint(email, { reason, item, date, habitNames }) {
  const parsed = await classifyReason({ reason, item, habitNames });

  // A vague "not today" is not a rule — record nothing.
  if (parsed.scope === 'conditional' && !parsed.unblock_habit && !/\b(injur|hurt|sick|ill|travel|away|broke|pain|recover)/i.test(reason)) {
    return null;
  }

  const all = await listConstraints(email);
  const constraint = {
    id: newId(),
    rule: parsed.rule,
    label: parsed.label,
    scope: parsed.scope,
    unblockHabit: parsed.scope === 'conditional' ? parsed.unblock_habit : null,
    reason,
    fromItem: item,
    createdDate: date,
    createdAt: new Date().toISOString(),
  };
  all.push(constraint);
  await saveConstraints(email, all);
  return constraint;
}

async function removeConstraint(email, id) {
  const all = await listConstraints(email);
  const next = all.filter((c) => c.id !== id);
  await saveConstraints(email, next);
  return next;
}

// Prompt block. Deliberately blunt — these override anything the data suggests.
function constraintsBlock(active) {
  if (!active || !active.length) return '';
  const lines = active.map((c) => {
    const until = c.scope === 'conditional' && c.unblockHabit
      ? ` (in effect until I log "${c.unblockHabit}" again)`
      : '';
    return `- ${c.rule}${until}`;
  });
  return `\n\nHARD CONSTRAINTS — these override everything else, including what the data suggests. Never suggest anything that violates them, and never mention or allude to the constraints themselves:\n${lines.join('\n')}`;
}

module.exports = {
  listConstraints,
  activeConstraints,
  addConstraint,
  removeConstraint,
  constraintsBlock,
};
