// Turns parsed habit days + journal days into everything the dashboard renders.

function avg(arr) {
  const v = arr.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function round1(x) { return x === null ? null : Math.round(x * 10) / 10; }

// --- window-able computations (used for both all-time and the last 7 days) ---

function computeSleep(days) {
  return days
    .filter((d) => d.bedtimeMin !== null)
    .map((d) => ({ date: d.date, bedtimeMin: d.bedtimeMin, score: d.score }));
}

function computePlant(days) {
  const daily = days.map((d) => {
    const acts = d.activities.filter((a) => a.flags.plant);
    return {
      date: d.date,
      count: acts.length,
      solo: acts.filter((a) => a.people.length === 0).length,
      social: acts.filter((a) => a.people.length > 0).length,
      score: d.score,
      avgRating: round1(avg(acts.map((a) => a.rating))),
    };
  });
  const acts = days.flatMap((d) => d.activities.filter((a) => a.flags.plant));
  const low = daily.filter((d) => d.score !== null && d.count <= 1);
  const high = daily.filter((d) => d.score !== null && d.count >= 2);
  return {
    daily,
    total: acts.length,
    soloShare: acts.length
      ? round1((acts.filter((a) => a.people.length === 0).length / acts.length) * 100)
      : null,
    avgRating: round1(avg(acts.map((a) => a.rating))),
    avgScoreLowUse: round1(avg(low.map((d) => d.score))),
    avgScoreHighUse: round1(avg(high.map((d) => d.score))),
    nLow: low.length,
    nHigh: high.length,
  };
}

function computeActivities(days) {
  const map = new Map();
  for (const d of days) {
    for (const a of d.activities) {
      if (a.flags.sleep || a.flags.wake || a.rating === null) continue;
      const key = activityKey(a);
      if (!map.has(key)) map.set(key, { title: key, n: 0, ratings: [] });
      const e = map.get(key);
      e.n++;
      e.ratings.push(a.rating);
    }
  }
  return [...map.values()]
    .map((e) => ({ title: e.title, n: e.n, avgRating: round1(avg(e.ratings)) }))
    .sort((a, b) => b.avgRating - a.avgRating || b.n - a.n);
}

function computeStreaks(days, habit) {
  let best = 0, cur = 0, current = 0;
  for (const d of days) {
    if (d.values[habit]) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].values[habit]) current++;
    else break;
  }
  return { current, best };
}

function buildInsights(habits, journal) {
  const hDays = habits.days;
  const jDays = journal;
  const jByDate = new Map(jDays.map((d) => [d.date, d]));

  // --- per-habit stats ---
  const perHabit = habits.habitNames.map((name) => {
    const done = hDays.filter((d) => d.values[name]).length;
    const { current, best } = computeStreaks(hDays, name);
    // day-score impact: avg journal score on days habit was done vs not
    const withScores = [], withoutScores = [];
    for (const d of hDays) {
      const j = jByDate.get(d.date);
      if (!j || j.score === null) continue;
      (d.values[name] ? withScores : withoutScores).push(j.score);
    }
    return {
      name,
      done,
      total: hDays.length,
      rate: hDays.length ? done / hDays.length : 0,
      currentStreak: current,
      bestStreak: best,
      avgScoreWith: round1(avg(withScores)),
      avgScoreWithout: round1(avg(withoutScores)),
      nWith: withScores.length,
      nWithout: withoutScores.length,
    };
  });

  const scoredDays = jDays.filter((d) => d.score !== null);

  // --- KPIs ---
  const last7h = hDays.slice(-7);
  const prev7h = hDays.slice(-14, -7);
  const last7j = scoredDays.slice(-7);
  const bedtimes = jDays.filter((d) => d.bedtimeMin !== null);
  const kpis = {
    completion7: round1(avg(last7h.map((d) => d.completion * 100))),
    completionPrev7: round1(avg(prev7h.map((d) => d.completion * 100))),
    avgScore7: round1(avg(last7j.map((d) => d.score))),
    avgScoreAll: round1(avg(scoredDays.map((d) => d.score))),
    bestDay: scoredDays.length
      ? scoredDays.reduce((a, b) => (b.score >= a.score ? b : a))
      : null,
    activeStreaks: perHabit.filter((h) => h.currentStreak >= 2).length,
    beforeMidnightRate: bedtimes.length
      ? round1((bedtimes.filter((d) => d.bedtimeMin <= 0).length / bedtimes.length) * 100)
      : null,
    avgBedtimeMin: round1(avg(bedtimes.map((d) => d.bedtimeMin))),
  };

  // --- habit -> day-score impact (only habits with >=2 days on each side) ---
  const habitImpact = perHabit
    .filter((h) => h.nWith >= 2 && h.nWithout >= 2)
    .map((h) => ({
      name: h.name,
      delta: round1(h.avgScoreWith - h.avgScoreWithout),
      avgWith: h.avgScoreWith,
      avgWithout: h.avgScoreWithout,
      nWith: h.nWith,
      nWithout: h.nWithout,
    }))
    .sort((a, b) => b.delta - a.delta);

  // --- people ---
  const peopleMap = new Map();
  for (const d of jDays) {
    const seenToday = new Set();
    for (const a of d.activities) {
      for (const p of a.people) {
        if (!peopleMap.has(p)) peopleMap.set(p, { name: p, acts: 0, days: new Set(), dayScores: [], ratings: [] });
        const e = peopleMap.get(p);
        e.acts++;
        e.days.add(d.date);
        if (a.rating !== null) e.ratings.push(a.rating);
        if (!seenToday.has(p) && d.score !== null) { e.dayScores.push(d.score); seenToday.add(p); }
      }
    }
  }
  const people = [...peopleMap.values()]
    .map((e) => ({
      name: e.name,
      acts: e.acts,
      days: e.days.size,
      avgDayScore: round1(avg(e.dayScores)),
      avgActRating: round1(avg(e.ratings)),
    }))
    .sort((a, b) => b.acts - a.acts);

  // social density vs score
  const socialVsScore = scoredDays.map((d) => ({
    date: d.date,
    score: d.score,
    socialActs: d.activities.filter((a) => a.people.length > 0).length,
    uniquePeople: new Set(d.activities.flatMap((a) => a.people)).size,
  }));

  // --- cities / locations ---
  const cityMap = new Map();
  for (const d of scoredDays) {
    const city = d.city || 'Unknown';
    if (!cityMap.has(city)) cityMap.set(city, []);
    cityMap.get(city).push(d.score);
  }
  const cities = [...cityMap.entries()]
    .map(([city, scores]) => ({ city, days: scores.length, avgScore: round1(avg(scores)) }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const homeActs = jDays.flatMap((d) => d.activities).filter((a) => /home|crib|porch/i.test(a.location || ''));
  const outActs = jDays.flatMap((d) => d.activities).filter((a) => a.location && !/home|crib|porch/i.test(a.location));
  const locationSplit = {
    home: { n: homeActs.length, avgRating: round1(avg(homeActs.map((a) => a.rating))) },
    out: { n: outActs.length, avgRating: round1(avg(outActs.map((a) => a.rating))) },
  };

  // --- sleep ---
  const sleep = computeSleep(jDays);

  // --- plant (🌱) ---
  const plant = computePlant(jDays);

  // --- recurring activities leaderboard ---
  const activities = computeActivities(jDays);

  // --- weekday pattern ---
  const wdOrder = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const weekdays = wdOrder.map((wd) => {
    const hd = hDays.filter((d) => d.weekday === wd);
    const jd = hd.map((d) => jByDate.get(d.date)).filter((j) => j && j.score !== null);
    return {
      weekday: wd,
      completion: hd.length ? round1(avg(hd.map((d) => d.completion * 100))) : null,
      avgScore: jd.length ? round1(avg(jd.map((j) => j.score))) : null,
      n: hd.length,
    };
  });

  // --- wins & focus ---
  const sortedByRate = [...perHabit].sort((a, b) => b.rate - a.rate);
  const wins = sortedByRate.filter((h) => h.rate >= 0.8).slice(0, 5);
  const focus = sortedByRate.filter((h) => h.rate < 0.4).slice(-3).reverse();
  const bestWeekday = weekdays.filter((w) => w.avgScore !== null).sort((a, b) => b.avgScore - a.avgScore)[0] || null;

  // Widgets about current behaviour (sleep, sessions, what you're doing) read
  // better as a rolling week than as an all-time average.
  const RECENT_DAYS = 7;
  const recentSlice = jDays.slice(-RECENT_DAYS);
  const recent = {
    days: RECENT_DAYS,
    start: recentSlice.length ? recentSlice[0].date : null,
    end: recentSlice.length ? recentSlice[recentSlice.length - 1].date : null,
    daysLogged: recentSlice.length,
    sleep: computeSleep(recentSlice),
    plant: computePlant(recentSlice),
    activities: computeActivities(recentSlice),
  };

  // Activity leaderboard windows: last week / last month / all time
  const monthSlice = jDays.slice(-30);
  const windowOf = (slice, list) => ({
    list,
    start: slice.length ? slice[0].date : null,
    end: slice.length ? slice[slice.length - 1].date : null,
    n: slice.length,
  });
  recent.activityWindows = {
    week: windowOf(recentSlice, recent.activities),
    month: windowOf(monthSlice, computeActivities(monthSlice)),
    all: windowOf(jDays, activities),
  };
  recent.plantWindows = {
    week: { ...windowOf(recentSlice, null), plant: recent.plant },
    month: { ...windowOf(monthSlice, null), plant: computePlant(monthSlice) },
    all: { ...windowOf(jDays, null), plant },
  };

  return {
    kpis, perHabit, habitImpact, people, socialVsScore, cities, locationSplit,
    sleep, plant, activities, weekdays, wins, focus, bestWeekday, recent,
  };
}

// Group recurring activities under a stable label, so the same thing done with
// different people ("Softball w/ Cory", "Softball w/ Mike") counts as one.
function activityKey(a) {
  const t = a.title.toLowerCase();
  if (/[\u{1F331}\u{1F343}]/u.test(a.title)) return a.people.length ? '🌱 with people' : '🌱 solo';
  if (/\blift\b|\bgym\b/.test(t)) return 'Lift';
  if (/^uber|\blyft\b/.test(t)) return 'Uber';
  if (/brews?\b|booze|\bbeer\b|drinks?\b/.test(t)) return 'Drinks';
  if (/\bebike\b|\bbike\b/.test(t)) return 'Bike ride';

  let base = a.title.replace(/\s+/g, ' ').trim();
  // For 1:1 meetings the person IS the activity, so keep them named
  if (!/^(call|meeting|chat|catch ?up|sync)\b/i.test(base)) {
    base = base.replace(/\s*[-—–]?\s*\b(w\/|w|with)\s+.+$/i, '').trim() || base;
  }
  base = base.replace(/\s*\([^)]*\)\s*$/, '').trim(); // drop trailing "(...)" notes
  return base.charAt(0).toUpperCase() + base.slice(1);
}

module.exports = { buildInsights };
