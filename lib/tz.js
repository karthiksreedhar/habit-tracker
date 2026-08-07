// "Today" in the USER'S timezone, not the server's (Vercel runs UTC, so
// without this every evening load rolled into tomorrow's card).
// The browser sends its IANA timezone in an X-TZ header on every request.

function nowInTz(tz) {
  const d = new Date();
  try {
    if (!tz) throw new Error('no tz');
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d).map((p) => [p.type, p.value])
    );
    const hour = parts.hour === '24' ? '00' : parts.hour; // Intl quirk
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    return {
      key,                                                    // YYYY-MM-DD (user-local)
      pretty: `${parts.weekday} ${parts.month}/${parts.day}/${parts.year}`, // for prompts
      hhmm: `${hour}:${parts.minute}`,                        // user-local clock
      date: new Date(`${key}T12:00:00`),                      // day-resolution Date
    };
  } catch {
    return {
      key: d.toISOString().slice(0, 10),
      pretty: d.toDateString(),
      hhmm: d.toTimeString().slice(0, 5),
      date: d,
    };
  }
}

function userTz(req) {
  const tz = String(req.headers['x-tz'] || '').slice(0, 64);
  return /^[A-Za-z0-9_+\-/]+$/.test(tz) ? tz : null;
}

module.exports = { nowInTz, userTz };
