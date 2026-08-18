// Mongo layer. One connection cached across serverless invocations.
// Collections:
//   users        — { email, tokens*, sheetUrl, docUrl, widgetState, goals*,
//                    goalAssessment*, social, socialSnapshot*, updatedAt }
//   coach_cache  — { email, v, days*, weeks* }   (one doc per user)
//   reports      — { email, reports* }
//   bulletin     — { pid, email, displayName, text, createdAt }
// Fields marked * are encrypted at rest via lib/crypto (AES-256-GCM) when
// DATA_ENCRYPTION_KEY is set; legacy plaintext reads pass through and get
// encrypted on their next write.

const { MongoClient } = require('mongodb');
const { encryptField, decryptField } = require('./crypto');

let clientPromise = null;

function getDb() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set — add it to .env / Vercel env vars.');
  if (!clientPromise) clientPromise = new MongoClient(process.env.MONGODB_URI).connect();
  return clientPromise.then((c) => c.db(process.env.MONGODB_DB || 'habit_dashboard'));
}

// Which user-document fields are sealed before writes / opened after reads
const ENCRYPTED_USER_FIELDS = ['tokens', 'goals', 'goalAssessment', 'socialSnapshot', 'customWidgets'];

function sealUserFields(fields) {
  const out = { ...fields };
  for (const f of ENCRYPTED_USER_FIELDS) {
    if (f in out) out[f] = encryptField(out[f]);
  }
  return out;
}

function openUserDoc(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  for (const f of ENCRYPTED_USER_FIELDS) {
    if (out[f] !== undefined) out[f] = decryptField(out[f]);
  }
  return out;
}

async function getUser(email) {
  const db = await getDb();
  return openUserDoc(await db.collection('users').findOne({ email }));
}

async function updateUser(email, fields) {
  const db = await getDb();
  await db.collection('users').updateOne(
    { email },
    { $set: { ...sealUserFields(fields), email, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function loadCoachCache(email) {
  const db = await getDb();
  const doc = await db.collection('coach_cache').findOne({ email });
  if (!doc) return doc;
  return { ...doc, days: decryptField(doc.days), weeks: decryptField(doc.weeks) };
}

async function saveCoachCache(email, cache) {
  const db = await getDb();
  await db.collection('coach_cache').updateOne(
    { email },
    { $set: { ...cache, days: encryptField(cache.days), weeks: encryptField(cache.weeks), email, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function loadReports(email) {
  const db = await getDb();
  const doc = await db.collection('reports').findOne({ email });
  if (!doc) return doc;
  return { ...doc, reports: decryptField(doc.reports) };
}

async function saveReports(email, doc) {
  const db = await getDb();
  await db.collection('reports').updateOne(
    { email },
    { $set: { ...doc, reports: encryptField(doc.reports), email, updatedAt: new Date() } },
    { upsert: true }
  );
}

// ---------- usage events (owner analytics) ----------
// One tiny doc per action; TTL-expired after 90 days. Fire-and-forget —
// logging must never block or break a user request.
let eventsIndexed = false;

// Which running counter (in usage_summary) an event increments
function counterFor(type, meta) {
  switch (type) {
    case 'login': return 'logins';
    case 'data_load': return 'dashboard_opens';
    case 'coach_check':
      if (!meta || !meta.checked) return null; // only count check-ONs
      return meta.kind === 'weekly' ? 'weekly_checks' : 'daily_checks';
    case 'coach_swap': return 'todo_swaps';
    case 'goal_create': return 'goals_created';
    case 'goal_complete': return 'goals_completed';
    case 'goal_reopen': return 'goals_reopened';
    case 'goal_tag': return 'goal_tags';
    case 'goal_delete': return 'goals_deleted';
    case 'widget_state': return 'widget_tweaks';
    case 'report_generate': return 'reports_generated';
    case 'widget_request': return 'custom_widget_requests';
    default: return null;
  }
}

async function logEvent(email, type, meta) {
  try {
    const db = await getDb();
    const col = db.collection('events');
    if (!eventsIndexed) {
      eventsIndexed = true;
      col.createIndex({ ts: 1 }, { expireAfterSeconds: 90 * 86400 }).catch(() => {});
    }
    const now = new Date();
    await col.insertOne({ ts: now, email, type, ...(meta ? { meta } : {}) });

    // Keep a human-readable running summary per user — read it straight in
    // Atlas/Compass: db.usage_summary. Counters are all-time since logging
    // began; `events` holds the raw 90-day trail for anything finer.
    const counter = counterFor(type, meta);
    const summary = db.collection('usage_summary');
    const today = now.toISOString().slice(0, 10);
    if (type === 'data_load') {
      // count distinct active days without needing a set
      const cur = await summary.findOne({ email }, { projection: { lastActiveDay: 1 } });
      const newDay = !cur || cur.lastActiveDay !== today;
      await summary.updateOne({ email }, {
        $set: { email, lastSeen: now, lastActiveDay: today },
        $inc: { dashboard_opens: 1, ...(newDay ? { active_days: 1 } : {}) },
      }, { upsert: true });
    } else {
      await summary.updateOne({ email }, {
        $set: { email, lastSeen: now },
        ...(counter ? { $inc: { [counter]: 1 } } : {}),
      }, { upsert: true });
    }
  } catch {}
}

async function recentEvents(days = 30) {
  const db = await getDb();
  return db.collection('events')
    .find({ ts: { $gte: new Date(Date.now() - days * 864e5) } })
    .limit(20000).toArray();
}

// Wipe everything the app knows about a user (account deletion).
async function deleteUserData(email) {
  const db = await getDb();
  await Promise.all([
    db.collection('users').deleteOne({ email }),
    db.collection('coach_cache').deleteOne({ email }),
    db.collection('reports').deleteOne({ email }),
    db.collection('bulletin').deleteMany({ email }),
    db.collection('events').deleteMany({ email }),
  ]);
}

module.exports = {
  getDb, getUser, updateUser,
  loadCoachCache, saveCoachCache, loadReports, saveReports,
  deleteUserData, logEvent, recentEvents,
};
