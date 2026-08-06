# Life Dashboard

A multi-user dashboard built from a habit-tracker Google Sheet and a
daily-journal Google Doc, with a Claude-powered Daily + Weekly Coach.
Runs locally at **http://localhost:5757** or hosted on Vercel.

## How it works

- Users sign in with Google (read-only Sheets + Docs scopes).
- Each user pastes their own Sheet + Doc links (⚙︎ Widgets → Data sources).
- Every page load re-fetches both, so the dashboard is always current.
- Per-user state (OAuth tokens, links, coach cards + checklists) lives in
  MongoDB. The Anthropic API powers the coach cards.

## Local dev

```bash
npm install
npm start
```

With no Google OAuth configured it runs in **local demo mode** (no login,
`seed-habits.csv` + `seed-journal.txt`, coach state in Mongo under a demo user).

`.env` (git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
MONGODB_URI=mongodb+srv://...
MONGODB_DB=habit_dashboard
SESSION_SECRET=<long random string>
# optional locally — enables real Google sign-in:
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

## Google OAuth setup (one-time)

1. https://console.cloud.google.com → create/pick a project.
2. Enable **Google Sheets API** and **Google Docs API**.
3. OAuth consent screen: External. While in "Testing" status only listed test
   users can sign in — add yourself and friends, or publish the app.
4. Credentials → Create credentials → **OAuth client ID → Web application**.
   Authorized redirect URIs (add both):
   - `http://localhost:5757/oauth2callback`
   - `https://YOUR-APP.vercel.app/oauth2callback` (add your real domain after
     the first deploy; add any custom domain too)
5. Copy the client ID + secret into `.env` and into Vercel env vars.

## Deploying to Vercel

```bash
npm i -g vercel
cd ~/habit-dashboard
vercel login
vercel            # first deploy (creates the project)
```

Then set the environment variables (dashboard → Project → Settings →
Environment Variables, or CLI):

```bash
vercel env add ANTHROPIC_API_KEY
vercel env add MONGODB_URI
vercel env add MONGODB_DB          # habit_dashboard
vercel env add SESSION_SECRET
vercel env add GOOGLE_CLIENT_ID
vercel env add GOOGLE_CLIENT_SECRET
vercel --prod     # production deploy
```

Notes:
- MongoDB Atlas → Network Access must allow `0.0.0.0/0` (Vercel has no fixed IPs).
- `vercel.json` sets `maxDuration: 300` for coach generation (Claude can take
  ~1-2 min). This needs Fluid Compute (default on new Vercel projects); if your
  plan rejects it, lower to 60 and coach generation may occasionally time out —
  a retry usually lands.
- After the first deploy, add the real `https://.../oauth2callback` redirect
  URI in the Google console (step 4 above) or sign-in will fail.
- The seed files are only used in local demo mode; they contain personal data,
  so keep the repo private (Vercel CLI deploys don't require a public repo).

## Data formats

**Habit sheet** — header row with `DAY`, `DATE`, then one column per habit
(TRUE/FALSE), then `Daily Completion %`. Rows dated in the future, and
trailing unfilled days, are ignored automatically.

**Journal doc** — one block per day:

```
07/24/26 | 8 | Cambridge

* 10:30 | Call with Lydia | Home | 8
* 3:00 | Softball w/ Cory | Field | 9
```

`date | day score (0–10) | city`, then `time | title | location (optional) |
vibe rating (0–10)` per activity. Bullets optional; `(?)` after times is fine.
🌱/🍃 marks a session; `Sleep`/`Slept` entries drive the bedtime chart
(7:00–11:59 reads as PM, 12:00–6:59 as after midnight).

## The Coach

- **Daily**: headline + insight + exactly 3 habit-only to-dos (✓ to check off,
  ✗ to declare failed and get a replacement), keep/ease/try columns,
  follow-through recognition. Cached per user per day.
- **Weekly**: recap bullets + 3 countable weekly goals (✓/✗ same semantics) +
  one experiment. Cached per user per ISO week.
- Both remember history (checks, fails) and feed it into future cards.

## Widgets

- **Suggested mode**: the Daily Coach picks which widgets matter today
  (core set always included); you can still toggle anything on top.
- **Custom mode**: full manual control.
- Every widget: drag ⠿ to reorder (width stays fixed), ✕ to hide.
  Layout preferences persist in the browser.

## Files

- `server.js` — Express app: Google OAuth, sessions, per-user Sheets/Docs fetch
- `api/index.js` + `vercel.json` — Vercel serverless wrapper
- `lib/db.js` — Mongo (users, coach_cache)
- `lib/parse.js` / `lib/analytics.js` — parsers + insights
- `lib/coach.js` — Daily/Weekly coach engine (Claude Opus 5, structured output)
- `public/` — the dashboard UI
