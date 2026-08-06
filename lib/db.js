// Mongo layer. One connection cached across serverless invocations.
// Collections:
//   users        — { email, tokens, sheetUrl, docUrl, updatedAt }
//   coach_cache  — { email, v, days: {...}, weeks: {...} }  (one doc per user)

const { MongoClient } = require('mongodb');

let clientPromise = null;

function getDb() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set — add it to .env / Vercel env vars.');
  if (!clientPromise) clientPromise = new MongoClient(process.env.MONGODB_URI).connect();
  return clientPromise.then((c) => c.db(process.env.MONGODB_DB || 'habit_dashboard'));
}

async function getUser(email) {
  const db = await getDb();
  return db.collection('users').findOne({ email });
}

async function updateUser(email, fields) {
  const db = await getDb();
  await db.collection('users').updateOne(
    { email },
    { $set: { ...fields, email, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function loadCoachCache(email) {
  const db = await getDb();
  return db.collection('coach_cache').findOne({ email });
}

async function saveCoachCache(email, cache) {
  const db = await getDb();
  await db.collection('coach_cache').updateOne(
    { email },
    { $set: { ...cache, email, updatedAt: new Date() } },
    { upsert: true }
  );
}

module.exports = { getDb, getUser, updateUser, loadCoachCache, saveCoachCache };
