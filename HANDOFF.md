# Project Status Handoff

## Summary

This repo is a prototype timing system for a HYROX simulation race.

The current proof of concept supports:

- NFC tag scan from Android Chrome Web NFC.
- Timing event upload to a local Python API.
- Raw timing event storage in SQLite.
- Participant/card binding through an admin page.
- Live leaderboard with theme toggle, Chinese/English toggle, and F1-style row update flash.

The current implementation is suitable for prototype testing, not production race-day deployment yet.

## Current Repo

```text
/Users/peterzhang/Documents/src-counting
```

Main branch:

```text
main
```

GitHub repo:

```text
git@github.com:21hz30/Web-nfc-timing.git
https://github.com/21hz30/Web-nfc-timing.git
```

## Local Runtime

Run:

```bash
python3 server.py
```

Local entry:

```text
http://localhost:8787/
```

Main pages:

```text
http://localhost:8787/admin.html
http://localhost:8787/web-nfc-timing-test.html
http://localhost:8787/leaderboard.html
http://localhost:8787/local-dashboard.html
```

SQLite database:

```text
data/timing.sqlite3
```

`data/` is ignored by git.

## Current Features

### Admin

File:

```text
admin.html
```

Purpose:

- Register/check participant details.
- Bind NFC card code to participant.
- Store:
  - race ID
  - card code
  - bib number
  - athlete name
  - phone
  - gender
  - division
  - check-in status
- Show latest timing events.

### Station Timing

File:

```text
web-nfc-timing-test.html
```

Purpose:

- Android Chrome Web NFC station scanner.
- Select race ID, device ID, and station checkpoint.
- Read NDEF text from tag.
- Normalize card code to uppercase.
- Upload timing event to `/api/timing-events`.
- Uses generic station IDs:
  - `START`
  - `STATION_1_ENTER`
  - `STATION_1_EXIT`
  - ...
  - `STATION_8_ENTER`
  - `STATION_8_EXIT`
  - `END`

### Leaderboard

File:

```text
leaderboard.html
```

Purpose:

- Live timing board.
- Shows:
  - rank
  - athlete
  - status
  - current checkpoint
  - elapsed time
  - station 1-8 splits
- Does not show card code.
- Does not show gap column.
- Supports:
  - dark/light theme
  - Chinese/English toggle
  - row flash when rank/status/checkpoint/split changes

### Local Debug Dashboard

File:

```text
local-dashboard.html
```

Purpose:

- Older quick debug page.
- Useful for checking raw bindings and timing events.
- Not the preferred long-term admin UI.

## API

Backend file:

```text
server.py
```

Current API endpoints:

```text
GET  /api/health
GET  /api/participants?raceId=hyrox-sim-001
POST /api/participants
GET  /api/timing-events?raceId=hyrox-sim-001&limit=100
POST /api/timing-events
GET  /api/leaderboard?raceId=hyrox-sim-001
```

Timing event payload example:

```json
{
  "eventId": "mate40-001-1720000000000-a8f3",
  "raceId": "hyrox-sim-001",
  "deviceId": "mate40-001",
  "stationId": "STATION_1_ENTER",
  "stationLabel": "Station 1 Enter",
  "stationNumber": 1,
  "checkpointType": "enter",
  "cardCode": "SIM-001",
  "serialNumber": "",
  "eventTime": "2026-07-03T10:20:31.123Z",
  "source": "web-nfc-test"
}
```

Timing event statuses:

```text
accepted
unbound_card
duplicate_tap
duplicate_event_id
```

## Current Data Model

SQLite tables are created in `server.py`.

Current tables:

```text
participants
timing_events
```

Participant fields include:

```text
race_id
card_code
athlete_name
bib_number
phone
gender
division
check_in_status
created_at
updated_at
```

Timing events include:

```text
event_id
race_id
device_id
station_id
station_label
station_number
checkpoint_type
card_code
serial_number
event_time
received_at
source
status
participant_id
raw_json
```

## Local Phone Testing

Web NFC requires HTTPS in Android Chrome. For local phone testing:

1. Run local API:

```bash
python3 server.py
```

2. Start Cloudflare tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
```

3. Open the generated `https://...trycloudflare.com/` URL on the Android phone.

The Cloudflare tunnel URL is temporary and should not be documented as permanent.

## Current Deployment Status

The static files have been pushed to GitHub.

A Vercel deployment was tested successfully earlier:

```text
https://web-nfc-timing-fjnm.vercel.app/web-nfc-timing-test.html
```

However, Vercel may be unreliable from the user's phone/network in China. For China production deployment, prefer a domestic cloud setup.

## Proposed Production Direction

The likely production stack is:

```text
Frontend static files -> 火山云 TOS or equivalent static hosting
Backend API -> 火山函数服务 / veFaaS or ECS
Database -> 火山云 managed PostgreSQL or MySQL
Custom HTTPS domain -> same origin for frontend and API if possible
```

Important production correction:

- Do not use SQLite in production.
- Do not rely on serverless local disk for timing data.
- Store timing data in managed PostgreSQL/MySQL.
- If using Function Service, refactor `server.py` because the current file starts its own HTTP server and is not function-handler shaped.

## Known Gaps

- No authentication yet.
- No participant search/edit workflow beyond save/upsert.
- No card unbind/rebind flow.
- No reset/cleanup test data action.
- No device registry yet.
- No station configuration UI yet.
- No CSV import for participant list.
- No admin correction workflow for missed/wrong taps.
- No production database adapter.
- No official deployment config for 火山云 yet.
- Leaderboard still has a visible race ID input; public board should probably use URL parameter/default config instead.
- Local database currently contains test records from development.

## Recommended Next Steps

1. Remove or hide the race ID input from `leaderboard.html`; read `raceId` from `?raceId=` or default to `hyrox-sim-001`.
2. Add reset/delete tools for local test data.
3. Add participant search and edit in `admin.html`.
4. Add NFC card unbind/rebind.
5. Add device/station registry.
6. Refactor backend storage behind a small repository layer so SQLite can be replaced by PostgreSQL/MySQL.
7. Prepare deployment variant for 火山云:
   - static frontend on TOS
   - API on Function Service or ECS
   - managed DB
   - HTTPS custom domain
8. Test a full race path:
   - START
   - STATION_1_ENTER
   - STATION_1_EXIT
   - several more stations
   - END
9. Run a 3-5 participant rehearsal before adding more UI.
