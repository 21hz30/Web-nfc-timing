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
serves the static frontend, but the Python API must also be deployed or reverse
proxied on the same origin for `/api/races`, timing writes, and Supabase mirroring to
work. Verify `GET https://timing.hybridtraining.cn/api/races` before a phone test.

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

The server mirrors participant and timing-event writes to the `SRC-timing` Supabase
project. SQLite remains the local source used by the timing logic, so a temporary
internet outage does not discard a scan. Every API write response includes:

```json
{
  "storage": {
    "localSaved": true,
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

Supabase access is protected by RLS and a server-only token stored in
`.timing-api-key`. That file is ignored by Git and must never be sent to a browser or
committed. For a deployed server, configure `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, and `TIMING_API_KEY` as environment variables.

## Race Profiles

Race behavior is selected by `raceId`; no code change is needed between race days.
The admin page can create or update a profile through the Race Profile section.

Supported modes:

```text
two_reader_auto
  Two phones alternate RUN_OUT and RUN_IN.
  The server assigns START, station transitions, and END.

station_checkpoints
  Each phone has one fixed checkpoint.
  The server accepts only START -> STATION_n_START -> ... -> END.
```

Profiles already created for testing:

```text
sunday-sim-20260719   two_reader_auto       8 stations
saturday-sim-20260725 station_checkpoints  5 stations
```

Scanner URL examples:

```text
/web-nfc-timing-test.html?raceId=sunday-sim-20260719&deviceId=run-out-01&role=RUN_OUT
/web-nfc-timing-test.html?raceId=sunday-sim-20260719&deviceId=run-in-01&role=RUN_IN
/web-nfc-timing-test.html?raceId=saturday-sim-20260725&deviceId=station-1&checkpoint=STATION_1_START
/web-nfc-timing-test.html?raceId=saturday-sim-20260725&deviceId=end&checkpoint=END
```

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
RUN OUT -> END
```

The final `END` event also closes the Station 8 split. Manual checkpoint mode remains
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

## Two-Reader Setup

- Reader 1: `RUN_OUT`, where athletes leave the workout zone and enter the run course.
- Reader 2: `RUN_IN`, where athletes finish each run and enter the next workout station.
- Every athlete must pass the same two controlled points in the same order.
- A missed tap cannot be inferred safely. The next wrong-role tap is rejected for staff review.
- One generic reader cannot validate direction and is not recommended for race day.
- Individual NFC starts suit staggered starts. A mass or wave start needs a shared-start workflow.

The timing page provides full-screen success/error feedback, sound, vibration, and
screen wake lock. Green success and the bundled Chinese "打卡成功" recording happen
only after the API confirms storage. The fixed WAV asset avoids dependence on Android
or Google speech services; system TTS remains a fallback. Duplicate protection defaults
to 10 seconds and can be configured from 3 to 60 seconds on each timing device.

Reader settings can be prefilled through the URL:

```text
/web-nfc-timing-test.html?raceId=demo-001&deviceId=run-out-01&role=RUN_OUT
/web-nfc-timing-test.html?raceId=demo-001&deviceId=run-in-01&role=RUN_IN
```

## Phone Testing Note

Web NFC requires HTTPS on Android Chrome. A Vercel static page is HTTPS, but it cannot directly write to local SQLite unless the local API is exposed through a trusted HTTPS URL.

Do not mount a phone with its NFC antenna flat against a wall. Use an angled or offset
holder so the rear upper NFC area remains reachable, then mark the physical tap target.

For real phone testing, use one of these:

```text
Vercel Web NFC page -> HTTPS tunnel -> local server.py -> SQLite
```

or:

```text
Web NFC page hosted on cloud -> cloud API -> cloud database
```

For the first backend proof, test API and database locally from the computer. Then expose/deploy the API for phone scanning.
