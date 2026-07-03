from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "timing.sqlite3"
DUPLICATE_WINDOW_SECONDS = 3


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS participants (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              race_id TEXT NOT NULL,
              card_code TEXT NOT NULL,
              athlete_name TEXT NOT NULL,
              bib_number TEXT,
              division TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (race_id, card_code)
            );

            CREATE TABLE IF NOT EXISTS timing_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id TEXT NOT NULL UNIQUE,
              race_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              station_id TEXT NOT NULL,
              station_label TEXT,
              station_number INTEGER,
              checkpoint_type TEXT,
              card_code TEXT NOT NULL,
              serial_number TEXT,
              event_time TEXT NOT NULL,
              received_at TEXT NOT NULL,
              source TEXT,
              status TEXT NOT NULL,
              participant_id INTEGER,
              raw_json TEXT NOT NULL,
              FOREIGN KEY (participant_id) REFERENCES participants(id)
            );

            CREATE INDEX IF NOT EXISTS idx_participants_race
              ON participants (race_id, card_code);

            CREATE INDEX IF NOT EXISTS idx_timing_events_race_received
              ON timing_events (race_id, received_at DESC);

            CREATE INDEX IF NOT EXISTS idx_timing_events_card_station
              ON timing_events (race_id, card_code, station_id, event_time DESC);
            """
        )


def row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


def normalize_card_code(value: object) -> str:
    return str(value or "").strip().upper()


class TimingHandler(SimpleHTTPRequestHandler):
    server_version = "HyroxTimingTest/0.1"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        relative = parsed.path.lstrip("/") or "index.html"
        return str(ROOT / relative)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "dbPath": str(DB_PATH), "time": utc_now()})
            return

        if parsed.path == "/api/timing-events":
            self.handle_get_timing_events(parsed.query)
            return

        if parsed.path == "/api/participants":
            self.handle_get_participants(parsed.query)
            return

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/timing-events":
            self.handle_post_timing_event()
            return

        if parsed.path == "/api/participants":
            self.handle_post_participant()
            return

        self.send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def read_json_body(self) -> dict:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("Missing JSON body")
        if content_length > 1024 * 1024:
            raise ValueError("JSON body too large")

        body = self.rfile.read(content_length).decode("utf-8")
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def handle_get_timing_events(self, query: str) -> None:
        params = parse_qs(query)
        race_id = params.get("raceId", ["hyrox-sim-001"])[0]
        limit_raw = params.get("limit", ["100"])[0]
        try:
            limit = max(1, min(int(limit_raw), 500))
        except ValueError:
            limit = 100

        with connect_db() as db:
            rows = db.execute(
                """
                SELECT
                  timing_events.*,
                  participants.athlete_name,
                  participants.bib_number,
                  participants.division
                FROM timing_events
                LEFT JOIN participants ON participants.id = timing_events.participant_id
                WHERE timing_events.race_id = ?
                ORDER BY timing_events.received_at DESC, timing_events.id DESC
                LIMIT ?
                """,
                (race_id, limit),
            ).fetchall()

        self.send_json({"ok": True, "events": [row_to_dict(row) for row in rows]})

    def handle_get_participants(self, query: str) -> None:
        params = parse_qs(query)
        race_id = params.get("raceId", ["hyrox-sim-001"])[0]
        with connect_db() as db:
            rows = db.execute(
                """
                SELECT *
                FROM participants
                WHERE race_id = ?
                ORDER BY bib_number IS NULL, bib_number, athlete_name
                """,
                (race_id,),
            ).fetchall()

        self.send_json({"ok": True, "participants": [row_to_dict(row) for row in rows]})

    def handle_post_participant(self) -> None:
        try:
            payload = self.read_json_body()
            race_id = str(payload.get("raceId") or "hyrox-sim-001").strip()
            card_code = normalize_card_code(payload.get("cardCode"))
            athlete_name = str(payload.get("athleteName") or "").strip()
            bib_number = str(payload.get("bibNumber") or "").strip() or None
            division = str(payload.get("division") or "").strip() or None
            if not race_id or not card_code or not athlete_name:
                raise ValueError("raceId, cardCode and athleteName are required")

            now = utc_now()
            with connect_db() as db:
                db.execute(
                    """
                    INSERT INTO participants (
                      race_id, card_code, athlete_name, bib_number, division, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (race_id, card_code) DO UPDATE SET
                      athlete_name = excluded.athlete_name,
                      bib_number = excluded.bib_number,
                      division = excluded.division,
                      updated_at = excluded.updated_at
                    """,
                    (race_id, card_code, athlete_name, bib_number, division, now, now),
                )
                row = db.execute(
                    "SELECT * FROM participants WHERE race_id = ? AND card_code = ?",
                    (race_id, card_code),
                ).fetchone()

            self.send_json({"ok": True, "participant": row_to_dict(row)})
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def handle_post_timing_event(self) -> None:
        try:
            payload = self.read_json_body()
            normalized = self.normalize_timing_payload(payload)
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return

        with connect_db() as db:
            existing = db.execute(
                "SELECT * FROM timing_events WHERE event_id = ?",
                (normalized["event_id"],),
            ).fetchone()
            if existing:
                self.send_json(
                    {
                        "ok": True,
                        "status": "duplicate_event_id",
                        "serverEventId": existing["id"],
                        "event": row_to_dict(existing),
                    }
                )
                return

            participant = db.execute(
                "SELECT * FROM participants WHERE race_id = ? AND card_code = ?",
                (normalized["race_id"], normalized["card_code"]),
            ).fetchone()

            status = "accepted" if participant else "unbound_card"
            previous = db.execute(
                """
                SELECT *
                FROM timing_events
                WHERE race_id = ? AND card_code = ? AND station_id = ?
                ORDER BY event_time DESC, id DESC
                LIMIT 1
                """,
                (normalized["race_id"], normalized["card_code"], normalized["station_id"]),
            ).fetchone()
            if previous and self.is_duplicate_tap(previous["event_time"], normalized["event_time"]):
                status = "duplicate_tap"

            cursor = db.execute(
                """
                INSERT INTO timing_events (
                  event_id,
                  race_id,
                  device_id,
                  station_id,
                  station_label,
                  station_number,
                  checkpoint_type,
                  card_code,
                  serial_number,
                  event_time,
                  received_at,
                  source,
                  status,
                  participant_id,
                  raw_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    normalized["event_id"],
                    normalized["race_id"],
                    normalized["device_id"],
                    normalized["station_id"],
                    normalized["station_label"],
                    normalized["station_number"],
                    normalized["checkpoint_type"],
                    normalized["card_code"],
                    normalized["serial_number"],
                    normalized["event_time"],
                    normalized["received_at"],
                    normalized["source"],
                    status,
                    participant["id"] if participant else None,
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            event_id = cursor.lastrowid
            event = db.execute(
                """
                SELECT
                  timing_events.*,
                  participants.athlete_name,
                  participants.bib_number,
                  participants.division
                FROM timing_events
                LEFT JOIN participants ON participants.id = timing_events.participant_id
                WHERE timing_events.id = ?
                """,
                (event_id,),
            ).fetchone()

        self.send_json(
            {
                "ok": True,
                "status": status,
                "serverEventId": event_id,
                "cardCode": normalized["card_code"],
                "stationId": normalized["station_id"],
                "receivedAt": normalized["received_at"],
                "event": row_to_dict(event),
            },
            HTTPStatus.CREATED,
        )

    def normalize_timing_payload(self, payload: dict) -> dict:
        race_id = str(payload.get("raceId") or "").strip()
        device_id = str(payload.get("deviceId") or "").strip()
        station_id = str(payload.get("stationId") or "").strip()
        card_code = normalize_card_code(payload.get("cardCode"))
        event_time = str(payload.get("eventTime") or "").strip()

        if not race_id:
            raise ValueError("raceId is required")
        if not device_id:
            raise ValueError("deviceId is required")
        if not station_id:
            raise ValueError("stationId is required")
        if not card_code:
            raise ValueError("cardCode is required")
        if not event_time:
            raise ValueError("eventTime is required")

        parsed_event_time = parse_iso(event_time)
        if not parsed_event_time:
            raise ValueError("eventTime must be ISO-8601")

        event_id = str(payload.get("eventId") or uuid.uuid4()).strip()
        station_number = payload.get("stationNumber")
        if station_number in ("", None):
            station_number = None
        elif isinstance(station_number, int):
            pass
        else:
            station_number = int(station_number)

        return {
            "event_id": event_id,
            "race_id": race_id,
            "device_id": device_id,
            "station_id": station_id,
            "station_label": str(payload.get("stationLabel") or station_id).strip(),
            "station_number": station_number,
            "checkpoint_type": str(payload.get("checkpointType") or "").strip(),
            "card_code": card_code,
            "serial_number": str(payload.get("serialNumber") or "").strip(),
            "event_time": event_time,
            "received_at": utc_now(),
            "source": str(payload.get("source") or "unknown").strip(),
        }

    def is_duplicate_tap(self, previous_event_time: str, event_time: str) -> bool:
        previous = parse_iso(previous_event_time)
        current = parse_iso(event_time)
        if not previous or not current:
            return False
        return abs((current - previous).total_seconds()) <= DUPLICATE_WINDOW_SECONDS


def main() -> None:
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", 8787), TimingHandler)
    print("HYROX timing test server")
    print(f"Database: {DB_PATH}")
    print("Local:    http://localhost:8787")
    print("API:      http://localhost:8787/api/timing-events")
    server.serve_forever()


if __name__ == "__main__":
    main()
