// Deterministic statistics for the Life Report.
// Everything the report cites is computed here — the model interprets these
// numbers, it never derives them. That keeps reports accurate and repeatable.

const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10);

function mean(a) {
  const v = a.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function median(a) {
  const v = a.filter((x) => x !== null && !Number.isNaN(x)).sort((p, q) => p - q);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function stdev(a) {
  const v = a.filter((x) => x !== null && !Number.isNaN(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

// Pearson r. Needs >= 4 pairs to mean anything at all; returns n alongside so
// the model can weight it honestly.
function pearson(pairs) {
  const p = pairs.filter(([x, y]) => x !== null && y !== null && !Number.isNaN(x) && !Number.isNaN(y));
  const n = p.length;
  if (n < 4) return { r: null, n };
  const mx = mean(p.map(([x]) => x));
  const my = mean(p.map(([, y]) => y));
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of p) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return { r: den ? r2(num / den) : null, n };
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const TIME_BUCKETS = [
  ['Morning (before noon)', 0, 720],
  ['Afternoon (12–5pm)', 720, 1020],
  ['Evening (5–9pm)', 1020, 1260],
  ['Night (9pm–1am)', 1260, 1500],
  ['Late night (after 1am)', 1500, 3000],
];

function buildReportStats(habits, journal, insights) {
  const jByDate = new Map(journal.map((d) => [d.date, d]));
  const hByDate = new Map(habits.days.map((d) => [d.date, d]));
  const scored = journal.filter((d) => d.score !== null);
  const allDates = [...new Set([...habits.days.map((d) => d.date), ...journal.map((d) => d.date)])].sort();
  const allActs = journal.flatMap((d) => d.activities.map((a) => ({ ...a, date: d.date })));
  const ratedActs = allActs.filter((a) => a.rating !== null);

  // ---- period ----
  const period = {
    start: allDates[0] || null,
    end: allDates[allDates.length - 1] || null,
    calendarDaysSpanned: allDates.length
      ? Math.round((new Date(allDates[allDates.length - 1]) - new Date(allDates[0])) / 864e5) + 1
      : 0,
    habitDaysLogged: habits.days.length,
    journalDaysLogged: journal.length,
    daysWithDayScore: scored.length,
    habitsTracked: habits.habitNames.length,
    activitiesLogged: allActs.length,
  };

  // ---- day score distribution ----
  const scores = scored.map((d) => d.score);
  const sortedDays = [...scored].sort((a, b) => b.score - a.score);
  const dayScore = {
    mean: r1(mean(scores)),
    median: r1(median(scores)),
    stdev: r1(stdev(scores)),
    min: scores.length ? Math.min(...scores) : null,
    max: scores.length ? Math.max(...scores) : null,
    bestDays: sortedDays.slice(0, 3).map((d) => ({
      date: d.date, score: d.score, city: d.city,
      activities: d.activities.map((a) => `${a.title}${a.rating !== null ? ` [${a.rating}]` : ''}`),
    })),
    worstDays: sortedDays.slice(-3).reverse().map((d) => ({
      date: d.date, score: d.score, city: d.city,
      activities: d.activities.map((a) => `${a.title}${a.rating !== null ? ` [${a.rating}]` : ''}`),
    })),
  };

  // ---- habits vs day score ----
  const habitCorrelations = habits.habitNames.map((name) => {
    const pairs = [];
    const withS = [], withoutS = [];
    for (const hd of habits.days) {
      const j = jByDate.get(hd.date);
      if (!j || j.score === null) continue;
      const on = hd.values[name] ? 1 : 0;
      pairs.push([on, j.score]);
      (on ? withS : withoutS).push(j.score);
    }
    const { r, n } = pearson(pairs);
    const done = habits.days.filter((d) => d.values[name]).length;
    return {
      habit: name,
      completionRate: r2(habits.days.length ? done / habits.days.length : 0),
      r, n,
      daysDone: withS.length, daysNotDone: withoutS.length,
      avgScoreWhenDone: r1(mean(withS)),
      avgScoreWhenNot: r1(mean(withoutS)),
      scoreDelta: withS.length && withoutS.length ? r1(mean(withS) - mean(withoutS)) : null,
    };
  }).sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0));

  const completionVsScore = pearson(habits.days.map((hd) => {
    const j = jByDate.get(hd.date);
    return [hd.completion, j && j.score !== null ? j.score : null];
  }));

  // ---- places ----
  const locMap = new Map();
  for (const a of ratedActs) {
    if (!a.location) continue;
    const key = a.location.trim();
    if (!locMap.has(key)) locMap.set(key, []);
    locMap.get(key).push(a.rating);
  }
  const locations = {
    cities: insights.cities,
    homeVsOut: insights.locationSplit,
    topPlaces: [...locMap.entries()]
      .map(([location, rs]) => ({ location, timesLogged: rs.length, avgRating: r1(mean(rs)) }))
      .filter((x) => x.timesLogged >= 2)
      .sort((a, b) => b.avgRating - a.avgRating)
      .slice(0, 10),
  };

  // ---- sleep (same-day and lagged next-day) ----
  const bedPairsSame = [], bedPairsNext = [];
  for (const d of journal) {
    if (d.bedtimeMin === null) continue;
    if (d.score !== null) bedPairsSame.push([d.bedtimeMin, d.score]);
    const next = jByDate.get(addDays(d.date, 1));
    if (next && next.score !== null) bedPairsNext.push([d.bedtimeMin, next.score]);
  }
  const sleep = {
    avgBedtimeMinutesAfterMidnight: r1(mean(journal.map((d) => d.bedtimeMin))),
    nightsLogged: journal.filter((d) => d.bedtimeMin !== null).length,
    beforeMidnightRate: insights.kpis.beforeMidnightRate,
    earliest: journal.filter((d) => d.bedtimeMin !== null).sort((a, b) => a.bedtimeMin - b.bedtimeMin)[0]?.bedtimeMin ?? null,
    latest: journal.filter((d) => d.bedtimeMin !== null).sort((a, b) => b.bedtimeMin - a.bedtimeMin)[0]?.bedtimeMin ?? null,
    corrWithSameDayScore: pearson(bedPairsSame),
    corrWithNextDayScore: pearson(bedPairsNext),
  };

  // ---- social ----
  const socialPairs = [], actPairs = [];
  const soloDays = [], peopleDays = [];
  for (const d of scored) {
    const uniquePeople = new Set(d.activities.flatMap((a) => a.people)).size;
    const socialActs = d.activities.filter((a) => a.people.length > 0).length;
    socialPairs.push([uniquePeople, d.score]);
    actPairs.push([socialActs, d.score]);
    (uniquePeople === 0 ? soloDays : peopleDays).push(d.score);
  }
  const social = {
    corrUniquePeopleVsScore: pearson(socialPairs),
    corrSocialActivitiesVsScore: pearson(actPairs),
    avgScoreSoloDays: r1(mean(soloDays)),
    soloDayCount: soloDays.length,
    avgScoreDaysWithPeople: r1(mean(peopleDays)),
    daysWithPeopleCount: peopleDays.length,
    people: insights.people,
  };

  // ---- 🌱 sessions ----
  const plantSame = [], plantNext = [];
  for (const d of journal) {
    const count = d.activities.filter((a) => a.flags.plant).length;
    if (d.score !== null) plantSame.push([count, d.score]);
    const next = jByDate.get(addDays(d.date, 1));
    if (next && next.score !== null) plantNext.push([count, next.score]);
  }
  const plantActs = allActs.filter((a) => a.flags.plant);
  const sessions = {
    total: plantActs.length,
    soloShare: insights.plant.soloShare,
    avgRatingSolo: r1(mean(plantActs.filter((a) => !a.people.length).map((a) => a.rating))),
    avgRatingSocial: r1(mean(plantActs.filter((a) => a.people.length).map((a) => a.rating))),
    corrCountVsSameDayScore: pearson(plantSame),
    corrCountVsNextDayScore: pearson(plantNext),
    avgScoreOnLightDays: insights.plant.avgScoreLowUse,
    lightDayCount: insights.plant.nLow,
    avgScoreOnHeavyDays: insights.plant.avgScoreHighUse,
    heavyDayCount: insights.plant.nHigh,
  };

  // ---- time of day ----
  const timeOfDay = TIME_BUCKETS.map(([bucket, lo, hi]) => {
    const inBucket = ratedActs.filter((a) => a.minutesOfDay !== null && a.minutesOfDay >= lo && a.minutesOfDay < hi);
    return { bucket, activities: inBucket.length, avgRating: r1(mean(inBucket.map((a) => a.rating))) };
  }).filter((b) => b.activities > 0);

  // ---- standout moments ----
  const byRating = [...ratedActs].sort((a, b) => b.rating - a.rating);
  const fmt = (a) => ({
    date: a.date, time: a.time, title: a.title, location: a.location, rating: a.rating,
    withPeople: a.people,
  });
  const standouts = {
    highestRated: byRating.slice(0, 8).map(fmt),
    lowestRated: byRating.filter((a) => !a.flags.sleep && !a.flags.wake).slice(-8).reverse().map(fmt),
    recurringActivities: insights.activities.filter((a) => a.n >= 2),
  };

  // ---- trends: first vs second half, and last 7 vs prior 7 ----
  function windowStats(days) {
    const s = days.filter((d) => d.score !== null).map((d) => d.score);
    const beds = days.map((d) => d.bedtimeMin).filter((x) => x !== null);
    const comp = days.map((d) => hByDate.get(d.date)).filter(Boolean).map((h) => h.completion);
    const sess = days.map((d) => d.activities.filter((a) => a.flags.plant).length);
    const soc = days.map((d) => new Set(d.activities.flatMap((a) => a.people)).size);
    return {
      days: days.length,
      avgDayScore: r1(mean(s)),
      avgHabitCompletion: comp.length ? r1(mean(comp) * 100) : null,
      avgBedtimeMinutes: r1(mean(beds)),
      avgSessionsPerDay: r1(mean(sess)),
      avgUniquePeoplePerDay: r1(mean(soc)),
    };
  }
  const half = Math.floor(journal.length / 2);
  const trends = {
    firstHalf: half >= 2 ? windowStats(journal.slice(0, half)) : null,
    secondHalf: half >= 2 ? windowStats(journal.slice(half)) : null,
    last7Days: journal.length >= 8 ? windowStats(journal.slice(-7)) : null,
    prior7Days: journal.length >= 14 ? windowStats(journal.slice(-14, -7)) : null,
    habitStreaks: insights.perHabit
      .map((h) => ({ habit: h.name, current: h.currentStreak, best: h.bestStreak, rate: r2(h.rate) }))
      .sort((a, b) => b.current - a.current)
      .slice(0, 8),
  };

  // ---- logging completeness (feeds the blind-spots section) ----
  const completeness = {
    journalDaysMissingScore: journal.filter((d) => d.score === null).length,
    journalDaysMissingCity: journal.filter((d) => !d.city).length,
    activitiesMissingRating: allActs.length - ratedActs.length,
    activitiesMissingLocation: allActs.filter((a) => !a.location).length,
    daysWithoutBedtime: journal.filter((d) => d.bedtimeMin === null).length,
    datesInJournalNotInSheet: journal.filter((d) => !hByDate.has(d.date)).map((d) => d.date),
    datesInSheetNotInJournal: habits.days.filter((d) => !jByDate.has(d.date)).map((d) => d.date),
    gapsInLogging: (() => {
      const gaps = [];
      for (let i = 1; i < allDates.length; i++) {
        const diff = Math.round((new Date(allDates[i]) - new Date(allDates[i - 1])) / 864e5);
        if (diff > 1) gaps.push({ after: allDates[i - 1], before: allDates[i], missingDays: diff - 1 });
      }
      return gaps;
    })(),
  };

  // Standout notes the user wrote between days (highlights/bold in their doc,
  // or bare event lines) — big life stuff the numbers can't see.
  const bigEvents = journal.flatMap((d) =>
    (d.milestones || []).map((m) => ({ date: d.date, text: m.text, emphasized: !!m.emphasized })));

  // Consent-gated free-text notes from the habit sheet (already stripped
  // upstream when the user hasn't opted in)
  const sheetNotes = habits.days
    .filter((d) => d.note)
    .slice(-60)
    .map((d) => ({ date: d.date, text: d.note.slice(0, 300) }));

  return {
    period, dayScore, habitCorrelations, completionVsScore,
    locations, sleep, social, sessions, timeOfDay, standouts, bigEvents, sheetNotes,
    weekdayPattern: insights.weekdays, trends, completeness,
  };
}

module.exports = { buildReportStats };
