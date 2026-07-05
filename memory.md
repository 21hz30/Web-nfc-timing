# Working Memory and Operating Rules

This file is an internal notebook for future assistant/dev sessions working on this repo. It is not product-facing.

## Project Focus

- The project is a HYROX simulation race timing prototype.
- Current goal: prove NFC card scan -> timing event upload -> stored raw event -> live leaderboard.
- The user is building toward a real race with around 100 participants.
- The target setup is:
  - iPhone with NFC Tools for writing simple NFC tag codes.
  - Android/Huawei Mate40 Pro or Android industrial terminals for station timing.
  - Web NFC first, native Android app later only if needed for reliability.
  - Cloud backend and managed database for production.

## User Preferences

- Be direct and correct assumptions. Do not just agree with the user.
- Explain architecture in concrete operational terms.
- Keep NFC tag data minimal and privacy-safe.
- Favor a stable race-day workflow over a flashy demo.
- UI should be clean, operational, and not too colorful.
- Leaderboard should be simple and F1-like, with row update flash, theme toggle, and Chinese/English switching.

## NFC Rules

- Do not write participant personal data into NFC tags.
- NFC tag content should be a simple stable code, preferably uppercase:
  - `SIM-001`
  - `SIM-002`
  - `SIM-003`
- Personal data stays in the backend:
  - name
  - phone
  - gender
  - division
  - bib number
  - check-in status
- Normalize card codes to uppercase in frontend and backend.
- Treat the NFC tag code as an identifier, not as the athlete record itself.

## Data Safety Rules

- Always store raw timing events. Do not only store calculated results.
- Do not mutate or delete raw timing events unless the user explicitly asks for reset/cleanup.
- Race-day mistakes should be corrected by admin workflows later, not by losing original raw data.
- SQLite is only for local prototyping. Do not use SQLite as production storage.
- Production should use managed PostgreSQL or MySQL.
- Function/serverless local disk is not persistent enough for race timing data.

## Current Local Commands

Run local server:

```bash
python3 server.py
```

Open local entry:

```text
http://localhost:8787/
```

Useful pages:

```text
http://localhost:8787/admin.html
http://localhost:8787/web-nfc-timing-test.html
http://localhost:8787/leaderboard.html
http://localhost:8787/leaderboard-chart.html
http://localhost:8787/local-dashboard.html
```

Temporary HTTPS tunnel for phone testing:

```bash
cloudflared tunnel --url http://localhost:8787
```

The `trycloudflare.com` URL is temporary and changes when the tunnel restarts.

## Git Commit Standard

- Treat this as a company project: commit messages must be clear to teammates reading history later.
- Prefer small, focused commits. Split security fixes, lint cleanup, docs, UX, and database work when they are separable.
- Use Conventional Commit style:
  - `security(api): restrict class mutation routes`
  - `fix(lint): satisfy React purity rules`
  - `docs(memory): record workflow standards`
  - `chore(db): baseline dev migration history`
- Commit subject should explain the intent, not just the files changed.
- For larger commits, include a body with:
  - what changed;
  - why it changed;
  - how it was verified.
- Before pushing, report the exact commit subject and verification results to the user.
- Avoid force-pushing or rewriting pushed `main` history unless the user explicitly approves it.
- If a pushed commit message is unclear, prefer a follow-up clarifying commit/PR description over rewriting public history.
- Push to `origin/main` after successful verification when requested or after user-facing progress.
- Do not commit local SQLite data. `data/` is gitignored.
- Avoid destructive git/database operations unless explicitly requested.

## Current Implementation Notes

- Backend is `server.py`, using Python standard library HTTP server plus SQLite.
- Static pages are plain HTML/CSS/JS.
- `admin.html` is the race admin/check-in/card binding page.
- `web-nfc-timing-test.html` is the Android Web NFC station timing page.
- `leaderboard.html` is the live timing board.
- `leaderboard-chart.html` is the separate animated leaderboard chart page.
- `local-dashboard.html` is an older debug page.
- `index.html` is a local hub for the main pages.

## Current Known Test Data

- Local SQLite may contain old test records:
  - multiple Peter bindings
  - `SIM-001`
  - `SIM-099`
  - old `HYROX-B001` / `Hyrox-Peter-b001`
- These are local prototype records only.
- Add a proper reset/cleanup admin action before serious testing.

## Active Follow-up Priorities

1. Remove race ID input from the public leaderboard and read `raceId` from URL query/default config.
2. Add reset/delete tools for test data, with clear confirmation.
3. Add station/device management:
   - device ID
   - station ID
   - station role
4. Improve admin workflow:
   - search participant
   - edit participant
   - unbind/rebind NFC card
   - import participant CSV
5. Move production backend from SQLite to managed PostgreSQL/MySQL.
6. Prepare deployment for China network conditions:
   - TOS or similar static hosting
   - Function Service/ECS API
   - custom HTTPS domain
7. Add authentication before real participant data is hosted publicly.
