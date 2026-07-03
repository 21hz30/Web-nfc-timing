# HYROX Web NFC Timing Test

This repo is a minimal timing prototype for a HYROX simulation race.

It contains:

- `web-nfc-timing-test.html`: Android Chrome Web NFC station scanner.
- `server.py`: local Python + SQLite API for timing events.
- `local-dashboard.html`: local admin page for card bindings and event checks.

## Run Local SQLite API

```bash
python3 server.py
```

Open:

```text
http://localhost:8787/local-dashboard.html
```

API endpoint:

```text
http://localhost:8787/api/timing-events
```

SQLite database path:

```text
data/timing.sqlite3
```

## API Payload

`POST /api/timing-events`

```json
{
  "eventId": "mate40-001-1720000000000-a8f3",
  "raceId": "hyrox-sim-001",
  "deviceId": "mate40-001",
  "stationId": "STATION_1_ENTER",
  "stationLabel": "Station 1 Enter",
  "stationNumber": 1,
  "checkpointType": "enter",
  "cardCode": "HYROX-B001",
  "serialNumber": "",
  "eventTime": "2026-07-03T10:20:31.123Z",
  "source": "web-nfc-test"
}
```

The API stores every raw event and returns one of:

```text
accepted
unbound_card
duplicate_tap
duplicate_event_id
```

## Phone Testing Note

Web NFC requires HTTPS on Android Chrome. A Vercel static page is HTTPS, but it cannot directly write to local SQLite unless the local API is exposed through a trusted HTTPS URL.

For real phone testing, use one of these:

```text
Vercel Web NFC page -> HTTPS tunnel -> local server.py -> SQLite
```

or:

```text
Web NFC page hosted on cloud -> cloud API -> cloud database
```

For the first backend proof, test API and database locally from the computer. Then expose/deploy the API for phone scanning.
