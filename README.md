# HYROX Web NFC Timing Test

This repo is a minimal timing prototype for a HYROX simulation race.

It contains:

- `web-nfc-timing-test.html`: Android Chrome Web NFC timing gate with automatic race progression.
- `server.py`: local Python API with SQLite storage and a Supabase cloud mirror.
- `admin.html`: race admin page for athlete info, check-in, and NFC card binding.
- `leaderboard.html`: live timing board with rank, current checkpoint, and station splits.
- `local-dashboard.html`: older local debug page for quick card bindings and event checks.

## Live Frontend

The custom HTTPS domain is:

```text
https://timing.hybridtraining.cn/
```

Android Chrome can load the Web NFC page from this domain. The current deployment
serves the static frontend from Vercel and rewrites `/api/*` to the Supabase
`timing-api` Edge Function. The live API uses Supabase as its primary store and the
`process_timing_event_v2` PostgreSQL function serializes timing writes per athlete.

The timing phone page no longer exposes an editable API URL. All scanner and admin
requests use the fixed same-origin `/api/*` routes, so operators only need to select
the race and device role. Use the HTTPS site on Android; opening the HTML as a
`file://` page does not provide a same-origin API route or Web NFC secure context.

Live health check:

```text
https://timing.hybridtraining.cn/api/health
```

## Run Timing API

```bash
python3 server.py
```

Open:

```text
http://localhost:8787/
```

Useful pages:

```text
http://localhost:8787/admin.html
http://localhost:8787/web-nfc-timing-test.html
http://localhost:8787/leaderboard.html
http://localhost:8787/local-dashboard.html
```

The admin page loads all race profiles from the API, keeps the two official races at
the top, and shows participant, check-in, finish, event, and error totals for the
selected race. Its data-board button carries the selected `raceId` into the live
leaderboard. Empty races show explicit empty states in both data tables.

API endpoint:

```text
http://localhost:8787/api/timing-events
```

Leaderboard endpoint:

```text
http://localhost:8787/api/leaderboard?raceId=hyrox-sim-001
```

SQLite database path:

```text
data/timing.sqlite3
```

## Supabase Cloud Storage

The local Python server mirrors participant and timing-event writes to the
`SRC-timing` Supabase project. SQLite remains the local source used by the local
timing logic, so a temporary internet outage does not discard a scan. The deployed
Edge API writes transactionally to Supabase without SQLite. Every API write response
includes storage details such as:

```json
{
  "storage": {
    "localSaved": false,
    "supabaseSaved": true
  },
  "cloudError": null
}
```

At startup, the server upserts all existing SQLite records to Supabase. To run only
that recovery sync:

```bash
python3 server.py --sync-only
```

Set `TIMING_SERVER_PORT` when the default port is already in use, for example
`TIMING_SERVER_PORT=8788 python3 server.py`.

Local-server Supabase access is protected by RLS and a server-only token stored in
`.timing-api-key`. That file is ignored by Git and must never be sent to a browser or
committed. For a deployed server, configure `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, and `TIMING_API_KEY` as environment variables.

The live Edge Function validates the public application key from `timing-api.js` and
uses Supabase-managed server credentials internally. No private Supabase key is
stored in the repository or configured in Vercel.

No `.env` change is needed for the hosted frontend. The Supabase project route and
public application key are already fixed in the tracked deployment configuration.
Do not add a service-role key to `.env` files used by Vercel or to browser code.

The test Edge Function currently runs without JWT verification. Consequently, a
cloud reset/delete action must not be exposed on the public admin page: anyone who
can open the site could invoke it. Add administrator authentication or a protected
server-side reset credential before implementing destructive Supabase cleanup.

## Race Profiles

Race behavior is selected by `raceId`; no code change is needed between race days.
The timing page lists the two official races first in its Race ID dropdown and keeps
older development profiles in a separate group. The admin page can create or update
a profile through the Race Profile section.

Supported modes:

```text
two_reader_auto
  Two phones alternate RUN_OUT and RUN_IN.
  The server assigns START, station transitions, and END.

three_reader_auto
  RUN_OUT and RUN_IN advance the course; only FINISH can assign END.

station_checkpoints
  Each phone has one fixed checkpoint.
  The server accepts only START -> STATION_n_START -> ... -> END.
```

Official live profiles:

```text
fitmonster-hyrox-single three_reader_auto    8 HYROX stations
hoka-race                station_checkpoints 5 boundary-timed stations
```

Fitmonster phone URLs:

```text
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-out&role=RUN_OUT
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-in&role=RUN_IN
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-finish&role=FINISH
```

Hoka phone URLs:

```text
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-1&checkpoint=START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-2&checkpoint=STATION_2_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-3&checkpoint=STATION_3_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-4&checkpoint=STATION_4_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-5&checkpoint=STATION_5_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-end&checkpoint=END
```

For Hoka, Station 1's phone also starts the race. Each following station tap ends
the previous station and starts the next; the END phone closes Station 5. This uses
six phones total and produces five adjacent station durations.

The scanner loads the profile from `GET /api/race-config?raceId=...` and
automatically selects auto/manual mode and the available checkpoints.

## API Payload

`POST /api/timing-events`

```json
{
  "eventId": "run-out-01-1720000000000-a8f3",
  "raceId": "hyrox-sim-001",
  "deviceId": "run-out-01",
  "timingMode": "auto",
  "gateRole": "RUN_OUT",
  "duplicateWindowSeconds": 10,
  "stationId": "AUTO",
  "cardCode": "SIM-001",
  "serialNumber": "",
  "eventTime": "2026-07-03T10:20:31.123Z",
  "source": "web-nfc-gate"
}
```

In automatic mode, the client sends its fixed physical role. The server assigns the
real checkpoint from that athlete's latest accepted event.

```text
RUN OUT -> START
RUN IN  -> STATION_1_ENTER
RUN OUT -> STATION_1_EXIT
RUN IN  -> STATION_2_ENTER
...
RUN IN  -> STATION_8_ENTER
FINISH  -> END
```

In `three_reader_auto`, a RUN_OUT tap at the final checkpoint is stored as
`wrong_gate`; only the FINISH phone closes the race. Manual checkpoint mode remains
available as an operational fallback.

The API stores every raw event and returns one of:

```text
accepted
unbound_card
duplicate_tap
duplicate_event_id
wrong_gate
wrong_checkpoint
already_finished
invalid_progress
```

Only `accepted` events advance leaderboard progress. Rejected scans are still stored
as raw timing events for later review.

## Reader Setup

- Fitmonster uses `RUN_OUT`, `RUN_IN`, and a dedicated `FINISH` reader.
- Hoka uses Station 1 as START, boundary readers at Stations 2-5, and a final END reader.
- Every athlete must pass the configured readers in checkpoint order.
- A missed tap cannot be inferred safely. The next wrong-role tap is rejected for staff review.
- One generic reader cannot validate direction and is not recommended for race day.
- Individual NFC starts suit staggered starts. A mass or wave start needs a shared-start workflow.

The timing page provides full-screen success/error feedback, sound, vibration, and
screen wake lock. Green success and the bundled Chinese "打卡成功" recording happen
only after the API confirms storage. The fixed WAV asset avoids dependence on Android
or Google speech services; system TTS remains a fallback. Rejected scans and local
read/upload failures use Chinese system TTS to announce the reason and next action.
Duplicate protection defaults to 10 seconds and can be configured from 3 to 60 seconds
on each timing device.

Reader settings can be prefilled through the URL:

```text
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-out&role=RUN_OUT
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-in&role=RUN_IN
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-finish&role=FINISH
```

## Phone Testing Note

Web NFC requires HTTPS on Android Chrome. The custom domain provides HTTPS and its
same-origin `/api/*` routes write directly to Supabase through the Edge Function.
The test Edge Function has JWT verification disabled and the publishable key is
visible in browser source, so do not use real participant data until authentication
is added.

Do not mount a phone with its NFC antenna flat against a wall. Use an angled or offset
holder so the rear upper NFC area remains reachable, then mark the physical tap target.

For real phone testing, use:

```text
timing.hybridtraining.cn -> Supabase Edge Function -> PostgreSQL
```

The local fallback remains:

```text
Cloudflare Quick Tunnel -> local server.py -> SQLite -> Supabase mirror
```
