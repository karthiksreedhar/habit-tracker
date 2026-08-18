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
async function logEvent(email, type, meta) {
  try {
    const db = await getDb();
    const col = db.collection('events');
    if (!eventsIndexed) {
      eventsIndexed = true;
      col.createIndex({ ts: 1 }, { expireAfterSeconds: 90 * 86400 }).catch(() => {});
    }
    await col.insertOne({ ts: new Date(), email, type, ...(meta ? { meta } : {}) });
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
