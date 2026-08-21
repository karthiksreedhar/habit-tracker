# Life Dashboard — iOS test app

A small native shell around the deployed dashboard (`https://habit-tracker-tau-puce.vercel.app`),
meant for private sharing with a handful of friends. **Not intended for the App Store.**

## What the app actually is

`LifeDash` is one screen: a `WKWebView` pointed at the dashboard, plus a native
sign-in hop. That's on purpose — every feature, fix, and privacy control you ship
to the website reaches the app the same day, with no rebuild and no second copy
of your data living on anyone's phone.

Native bits that a plain "add to home screen" bookmark can't do:

- **Google sign-in that Google allows.** Google blocks OAuth inside embedded
  webviews (`disallowed_useragent`). When the webview tries to open
  `/auth/google`, the app cancels that navigation and opens
  `/auth/google?app=1` in `ASWebAuthenticationSession` (the system browser
  sheet) instead. The server's callback deep-links back to
  `lifedash://auth?token=…`, and the app loads `/auth/app-complete?token=…`
  inside the webview, which sets the ordinary `hd_session` cookie.
- Pull-to-refresh, swipe-back, a real app icon, and an offline error screen with
  a retry button.
- External links (your Sheet, your Doc) open in Safari rather than trapping you
  in the shell.

## Privacy posture

- **No SDKs at all.** No analytics, no crash reporter, no ad framework. The only
  network traffic the app itself makes is to your dashboard's own domain.
- **No permissions requested.** No location, camera, microphone, contacts,
  notifications, or photo access — the Info.plist contains no usage strings
  because nothing asks.
- **The app never touches your Google password or Google tokens.** Sign-in runs
  in Apple's auth session, isolated from the app; the app only ever sees a
  short-lived token minted by *your* server.
- **The handoff token is narrow**: HMAC-signed with `SESSION_SECRET + ':app'`,
  valid 5 minutes, carries only an email + expiry, marked single-use server-side
  so a leaked link cannot be replayed.
- **On-device storage is just the webview's session cookie and cache.** Signing
  out or deleting the app clears it. Account deletion still happens on the
  website (Data → delete account), which wipes the Mongo record.
- `PrivacyInfo.xcprivacy` declares `NSPrivacyTracking = false`, no tracking
  domains, and no collected data types.

Optional hardening, if you ever widen the circle: custom URL schemes can in
principle be claimed by another installed app. Switching the callback to a
Universal Link (`https://…/auth/app-return`) removes that class of risk — it
needs an `apple-app-site-association` file served from the Vercel domain with
your Team ID, plus an Associated Domains entitlement. Not worth it for a few
friends; worth it if this grows.

## Building it

You need **Xcode** (this machine currently has only the Command Line Tools) and,
for sharing, an **Apple Developer Program** membership ($99/yr).

1. Install Xcode from the Mac App Store, then:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```
2. Regenerate and open the project (the `.xcodeproj` is generated, and is
   committed for convenience — regenerate after editing `project.yml`):
   ```bash
   cd ios && xcodegen generate && open LifeDash.xcodeproj
   ```
3. Select the `LifeDash` target → **Signing & Capabilities** → check *Automatically
   manage signing* and pick your Team. If the bundle id
   `com.karthiksreedhar.lifedash` is taken, change it in `project.yml` and
   regenerate.
4. Pick a simulator or your iPhone and hit ▶.

Sign-in requires the deployed site (Google won't redirect to localhost from a
device), so the app talks to production even in debug. To point it elsewhere,
change `dashboardURL` in `LifeDash/ContentView.swift`.

## Sharing with friends, without the App Store

**TestFlight** is the right channel — Apple's own beta distribution, no public
listing, up to 100 internal testers and 10,000 external ones.

1. In [App Store Connect](https://appstoreconnect.apple.com) → **Apps** → **+** →
   New App. Platform iOS, bundle id `com.karthiksreedhar.lifedash`, SKU anything.
   Creating the record does **not** publish anything.
2. In Xcode: **Product → Archive** → **Distribute App** → **TestFlight & App Store**
   → Upload.
3. In App Store Connect → your app → **TestFlight**, answer the export-compliance
   question (**no** — the app uses only standard HTTPS; `ITSAppUsesNonExemptEncryption`
   is already set to `false`, so this should be automatic).
4. Fill the **App Privacy** questionnaire. Truthful answers for this build:
   - *Data collected by this app:* Contact Info → Email Address, and User Content
     (the habit/journal data), both **linked to identity**, used for **App
     Functionality** only, **not** used for tracking.
   - *Third-party advertising / analytics / data brokers:* none.
5. Add testers:
   - **Internal** (up to 100, must be App Store Connect users on your team) — no
     review, builds go live in minutes.
   - **External** (friends by email or a public-ish invite link) — needs a short
     **Beta App Review** on the first build; later builds usually skip it. Fill
     in "What to Test" and a beta description.
6. Friends install the **TestFlight** app and tap your invite. Builds expire
   after 90 days; upload a new one to keep the group running.

Alternatives if you'd rather skip TestFlight entirely: **Ad Hoc** distribution
(each friend's device UDID registered, max 100/year, re-signed IPA sideloaded —
clunky), or just having them **Add to Home Screen** from Safari, which gets a
near-identical experience minus the native sign-in polish.

## Files

| Path | What it is |
| --- | --- |
| `project.yml` | xcodegen spec — bundle id, URL scheme, target settings |
| `LifeDash/LifeDashApp.swift` | App entry point |
| `LifeDash/ContentView.swift` | Webview shell, auth hop, refresh/error handling |
| `LifeDash/PrivacyInfo.xcprivacy` | Privacy manifest (no tracking, no collection) |
| `LifeDash/Assets.xcassets` | App icon |

Server side, the flow lives in `server.js`: `/auth/google?app=1` (adds
`state=app`), the `state === 'app'` branch of `/oauth2callback`, and
`/auth/app-complete`.
