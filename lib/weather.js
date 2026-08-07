// Daily temperatures for the cities in the journal, via Open-Meteo (free, no
// key). Geocoding results and per-day temps are cached in Mongo, so external
// calls only happen for never-seen cities/dates.
//
// City disambiguation: common shorthands are alias-mapped ("nyc" -> New York);
// everything else geocodes with a preference for the country the user's other
// cities resolved to — so "Cambridge" lands in Massachusetts for someone whose
// journal also says NYC, and in England for someone logging London.

const { getDb } = require('./db');

const ALIASES = {
  nyc: 'New York', 'new york city': 'New York', manhattan: 'New York',
  bk: 'Brooklyn', sf: 'San Francisco', la: 'Los Angeles', philly: 'Philadelphia',
  dc: 'Washington', chi: 'Chicago', atl: 'Atlanta', bos: 'Boston',
  vegas: 'Las Vegas', nola: 'New Orleans',
};

function normCity(raw) {
  const t = String(raw || '').trim();
  if (!t || /^(home|transit|outside|work|school|office)$/i.test(t)) return null;
  const key = t.toLowerCase();
  return { name: ALIASES[key] || t, fromAlias: !!ALIASES[key] };
}

async function geocode(db, name, preferCountry) {
  const q = name.toLowerCase();
  const col = db.collection('weather_geo');
  const hit = await col.findOne({ q });
  if (hit) return hit;
  let doc = { q, found: false };
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
    const j = await r.json();
    const results = j.results || [];
    if (results.length) {
      const pick = (preferCountry && results.find((x) => x.country_code === preferCountry)) || results[0];
      doc = {
        q, found: true,
        name: pick.name, admin1: pick.admin1 || null, country: pick.country_code || null,
        lat: pick.latitude, lon: pick.longitude,
      };
    }
  } catch { return doc; /* network hiccup: don't cache the failure */ }
  await col.updateOne({ q }, { $set: doc }, { upsert: true });
  return doc;
}

const dayKey = (geo, date) => `${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}|${date}`;

// Mean/max temps (°F) for a set of ISO dates at one location, cache-first.
async function tempsFor(db, geo, dates) {
  const col = db.collection('weather_days');
  const out = new Map();
  const missing = [];
  for (const d of dates) {
    const hit = await col.findOne({ k: dayKey(geo, d) });
    if (hit && hit.tempF != null) out.set(d, hit);
    else missing.push(d);
  }
  if (missing.length) {
    try {
      const sorted = [...missing].sort();
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${geo.lat}&longitude=${geo.lon}` +
        `&start_date=${sorted[0]}&end_date=${sorted[sorted.length - 1]}` +
        `&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto`;
      const r = await fetch(url);
      const j = await r.json();
      const t = j.daily || {};
      const idx = new Map((t.time || []).map((dt, i) => [dt, i]));
      for (const d of missing) {
        const i = idx.get(d);
        const val = (arr) => (i != null && arr && arr[i] != null ? Math.round(arr[i]) : null);
        const doc = {
          k: dayKey(geo, d), date: d,
          tempF: val(t.temperature_2m_mean),
          tmaxF: val(t.temperature_2m_max),
          tminF: val(t.temperature_2m_min),
        };
        // Recent days aren't in the archive yet — don't cache nulls
        if (doc.tempF != null) await col.updateOne({ k: doc.k }, { $set: doc }, { upsert: true });
        out.set(d, doc);
      }
    } catch { /* leave missing days blank */ }
  }
  return out;
}

function pearson(pairs) {
  const p = pairs.filter(([x, y]) => x != null && y != null);
  const n = p.length;
  if (n < 4) return { r: null, n };
  const mx = p.reduce((s, [x]) => s + x, 0) / n;
  const my = p.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of p) { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
  const den = Math.sqrt(dx * dy);
  return { r: den ? Math.round((num / den) * 100) / 100 : null, n };
}

// journal -> [{date, city, resolved, tempF, tmaxF, score}] + correlation
async function weatherSeries(journal) {
  const withCity = journal.filter((d) => d.city && normCity(d.city));
  if (!withCity.length) return { days: [], correlation: { r: null, n: 0 } };
  const db = await getDb();

  // Group dates by normalized city; alias-mapped cities geocode first so they
  // establish the country prior for ambiguous names.
  const groups = new Map();
  for (const d of withCity) {
    const c = normCity(d.city);
    if (!groups.has(c.name)) groups.set(c.name, { fromAlias: c.fromAlias, dates: [] });
    groups.get(c.name).dates.push(d.date);
  }
  const order = [...groups.entries()].sort((a, b) => (b[1].fromAlias ? 1 : 0) - (a[1].fromAlias ? 1 : 0));

  let prior = null;
  const perDate = new Map(); // date -> {tempF, tmaxF, resolved}
  for (const [name, g] of order) {
    const geo = await geocode(db, name, prior);
    if (!geo.found) continue;
    if (!prior && geo.country) prior = geo.country;
    const temps = await tempsFor(db, geo, [...new Set(g.dates)]);
    const resolved = `${geo.name}${geo.admin1 ? ', ' + geo.admin1 : ''}${geo.country ? ' (' + geo.country + ')' : ''}`;
    for (const [date, t] of temps) {
      perDate.set(date, { tempF: t.tempF, tmaxF: t.tmaxF, resolved });
    }
  }

  const days = withCity.map((d) => {
    const w = perDate.get(d.date) || {};
    return {
      date: d.date, city: d.city, resolved: w.resolved || null,
      tempF: w.tempF ?? null, tmaxF: w.tmaxF ?? null, score: d.score,
    };
  });
  const correlation = pearson(days.map((d) => [d.tempF, d.score]));
  return { days, correlation };
}

module.exports = { weatherSeries };
