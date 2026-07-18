from __future__ import annotations

import hmac
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "timing.sqlite3"
TIMING_API_KEY_PATH = ROOT / ".timing-api-key"
SUPABASE_URL = os.environ.get(
    "SUPABASE_URL",
    "https://lfzvkqwpekgtkcnpzbqj.supabase.co",
).rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get(
    "SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_rEY1bSLnKyW4p84tVi4VJQ_Zkic_clr",
)
SUPABASE_SYNC_ENABLED = os.environ.get("SUPABASE_SYNC_ENABLED", "1") != "0"
SUPABASE_TIMEOUT_SECONDS = 15
PARTICIPANT_COLUMNS = (
    "id",
    "race_id",
    "card_code",
    "athlete_name",
    "bib_number",
    "entry_type",
    "member_names",
    "phone",
    "gender",
    "division",
    "check_in_status",
    "created_at",
    "updated_at",
)
TIMING_EVENT_COLUMNS = (
    "id",
    "event_id",
    "race_id",
    "device_id",
    "station_id",
    "station_label",
    "station_number",
    "checkpoint_type",
    "card_code",
    "serial_number",
    "event_time",
    "received_at",
    "source",
    "timing_mode",
    "gate_role",
    "duplicate_window_seconds",
    "status",
    "participant_id",
    "raw_json",
)
RACE_PROFILE_COLUMNS = (
    "race_id",
    "name",
    "mode",
    "station_count",
    "checkpoints",
    "entry_type",
    "created_at",
    "updated_at",
)
RACE_MODES = {"two_reader_auto", "three_reader_auto", "station_checkpoints"}
ENTRY_TYPES = {"individual", "doubles", "team"}
LAST_SUPABASE_SYNC = {
    "attemptedAt": None,
    "saved": None,
    "error": None,
}
DEFAULT_DUPLICATE_WINDOW_SECONDS = 10
MIN_DUPLICATE_WINDOW_SECONDS = 3
MAX_DUPLICATE_WINDOW_SECONDS = 60
AUTO_GATE_ROLES = {"RUN_OUT", "RUN_IN", "FINISH"}


def build_two_reader_checkpoints(station_count: int) -> list[str]:
    checkpoints = ["START"]
    for station_number in range(1, station_count):
        checkpoints.extend(
            [
                f"STATION_{station_number}_ENTER",
                f"STATION_{station_number}_EXIT",
            ]
        )
    checkpoints.extend([f"STATION_{station_count}_ENTER", "END"])
    return checkpoints


def build_station_checkpoints(station_count: int) -> list[str]:
    return ["START"] + [
        f"STATION_{station_number}_START"
        for station_number in range(1, station_count + 1)
    ] + ["END"]


def build_station_boundary_checkpoints(station_count: int) -> list[str]:
    return ["START"] + [
        f"STATION_{station_number}_START"
        for station_number in range(2, station_count + 1)
    ] + ["END"]


def build_checkpoints(mode: str, station_count: int) -> list[str]:
    if mode == "station_checkpoints":
        return build_station_checkpoints(station_count)
    return build_two_reader_checkpoints(station_count)


CHECKPOINT_SEQUENCE = build_two_reader_checkpoints(8)
CHECKPOINT_INDEX = {checkpoint: index for index, checkpoint in enumerate(CHECKPOINT_SEQUENCE)}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def init_db() -> None:
    with connect_db() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS participants (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              race_id TEXT NOT NULL,
              card_code TEXT NOT NULL,
              athlete_name TEXT NOT NULL,
              bib_number TEXT,
              entry_type TEXT NOT NULL DEFAULT 'individual',
              member_names TEXT NOT NULL DEFAULT '[]',
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
              timing_mode TEXT NOT NULL DEFAULT 'manual',
              gate_role TEXT,
              duplicate_window_seconds INTEGER NOT NULL DEFAULT 10,
              status TEXT NOT NULL,
              participant_id INTEGER,
              raw_json TEXT NOT NULL,
              FOREIGN KEY (participant_id) REFERENCES participants(id)
            );

            CREATE TABLE IF NOT EXISTS race_profiles (
              race_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              mode TEXT NOT NULL,
              station_count INTEGER NOT NULL,
              checkpoints_json TEXT NOT NULL,
              entry_type TEXT NOT NULL DEFAULT 'individual',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_participants_race
              ON participants (race_id, card_code);

            CREATE INDEX IF NOT EXISTS idx_timing_events_race_received
              ON timing_events (race_id, received_at DESC);

            CREATE INDEX IF NOT EXISTS idx_timing_events_card_station
              ON timing_events (race_id, card_code, station_id, event_time DESC);
            """
        )
        ensure_participant_columns(db)
        ensure_race_profile_columns(db)
        ensure_timing_event_columns(db)
        ensure_default_race_profiles(db)
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_timing_events_auto_progress
              ON timing_events (race_id, participant_id, status, event_time)
            """
        )
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_timing_events_gate_scan
              ON timing_events (race_id, card_code, timing_mode, gate_role, event_time DESC)
            """
        )


def ensure_participant_columns(db: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(participants)").fetchall()
    }
    migrations = {
        "phone": "ALTER TABLE participants ADD COLUMN phone TEXT",
        "gender": "ALTER TABLE participants ADD COLUMN gender TEXT",
        "entry_type": (
            "ALTER TABLE participants "
            "ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'individual'"
        ),
        "member_names": (
            "ALTER TABLE participants "
            "ADD COLUMN member_names TEXT NOT NULL DEFAULT '[]'"
        ),
        "check_in_status": (
            "ALTER TABLE participants "
            "ADD COLUMN check_in_status TEXT NOT NULL DEFAULT 'not_checked_in'"
        ),
    }
    for column_name, statement in migrations.items():
        if column_name not in existing_columns:
            db.execute(statement)
    rows = db.execute(
        "SELECT id, athlete_name, member_names FROM participants"
    ).fetchall()
    for row in rows:
        try:
            member_names = json.loads(row["member_names"] or "[]")
        except json.JSONDecodeError:
            member_names = []
        if not member_names:
            db.execute(
                "UPDATE participants SET member_names = ? WHERE id = ?",
                (json.dumps([row["athlete_name"]], ensure_ascii=False), row["id"]),
            )


def ensure_race_profile_columns(db: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(race_profiles)").fetchall()
    }
    if "entry_type" not in existing_columns:
        db.execute(
            "ALTER TABLE race_profiles "
            "ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'individual'"
        )


def ensure_timing_event_columns(db: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(timing_events)").fetchall()
    }
    migrations = {
        "timing_mode": (
            "ALTER TABLE timing_events "
            "ADD COLUMN timing_mode TEXT NOT NULL DEFAULT 'manual'"
        ),
        "gate_role": "ALTER TABLE timing_events ADD COLUMN gate_role TEXT",
        "duplicate_window_seconds": (
            "ALTER TABLE timing_events "
            "ADD COLUMN duplicate_window_seconds INTEGER NOT NULL DEFAULT 10"
        ),
    }
    for column_name, statement in migrations.items():
        if column_name not in existing_columns:
            db.execute(statement)


def make_race_profile(
    race_id: str,
    name: str,
    mode: str,
    station_count: int,
    created_at: str | None = None,
    updated_at: str | None = None,
    checkpoints: list[str] | None = None,
    entry_type: str = "individual",
) -> dict:
    if mode not in RACE_MODES:
        raise ValueError(
            "mode must be two_reader_auto, three_reader_auto, or station_checkpoints"
        )
    if not 1 <= station_count <= 20:
        raise ValueError("stationCount must be between 1 and 20")
    if entry_type not in ENTRY_TYPES:
        raise ValueError("entryType must be individual, doubles, or team")
    profile_checkpoints = list(checkpoints) if checkpoints is not None else build_checkpoints(
        mode,
        station_count,
    )
    if (
        len(profile_checkpoints) < 2
        or profile_checkpoints[0] != "START"
        or profile_checkpoints[-1] != "END"
        or len(set(profile_checkpoints)) != len(profile_checkpoints)
    ):
        raise ValueError("checkpoints must be unique and run from START to END")
    now = utc_now()
    return {
        "race_id": race_id,
        "name": name or race_id,
        "mode": mode,
        "station_count": station_count,
        "checkpoints": profile_checkpoints,
        "entry_type": entry_type,
        "created_at": created_at or now,
        "updated_at": updated_at or now,
    }


def default_race_profile(race_id: str) -> dict:
    entry_type = "team" if race_id == "hoka-race" else "individual"
    return make_race_profile(
        race_id,
        race_id,
        "two_reader_auto",
        8,
        entry_type=entry_type,
    )


def ensure_default_race_profiles(db: sqlite3.Connection) -> None:
    for race_id, name, mode, station_count, checkpoints, entry_type in (
        ("hyrox-sim-001", "HYROX Simulation", "two_reader_auto", 8, None, "individual"),
        ("nfc-test-001", "NFC Test", "two_reader_auto", 8, None, "individual"),
        (
            "supabase-e2e-20260716",
            "Supabase E2E Test",
            "two_reader_auto",
            8,
            None,
            "individual",
        ),
        (
            "fitmonster-hyrox-single",
            "FitMonster Hyrox Single Simulation Race",
            "three_reader_auto",
            8,
            None,
            "individual",
        ),
        (
            "hoka-race",
            "Hoka Race",
            "station_checkpoints",
            5,
            build_station_boundary_checkpoints(5),
            "team",
        ),
    ):
        profile = make_race_profile(
            race_id,
            name,
            mode,
            station_count,
            checkpoints=checkpoints,
            entry_type=entry_type,
        )
        db.execute(
            """
            INSERT INTO race_profiles (
              race_id, name, mode, station_count, checkpoints_json,
              entry_type, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (race_id) DO NOTHING
            """,
            (
                profile["race_id"],
                profile["name"],
                profile["mode"],
                profile["station_count"],
                json.dumps(profile["checkpoints"]),
                profile["entry_type"],
                profile["created_at"],
                profile["updated_at"],
            ),
        )
        if race_id in {"fitmonster-hyrox-single", "hoka-race"}:
            db.execute(
                """
                UPDATE race_profiles
                SET name = ?, mode = ?, station_count = ?, checkpoints_json = ?,
                    entry_type = ?, updated_at = ?
                WHERE race_id = ?
                """,
                (
                    profile["name"],
                    profile["mode"],
                    profile["station_count"],
                    json.dumps(profile["checkpoints"]),
                    profile["entry_type"],
                    profile["updated_at"],
                    profile["race_id"],
                ),
            )


def race_profile_from_row(row: sqlite3.Row | dict) -> dict:
    source = row_to_dict(row) if isinstance(row, sqlite3.Row) else row
    checkpoints = source.get("checkpoints")
    if checkpoints is None:
        try:
            checkpoints = json.loads(source.get("checkpoints_json") or "[]")
        except json.JSONDecodeError:
            checkpoints = []
    return {
        "race_id": source["race_id"],
        "name": source["name"],
        "mode": source["mode"],
        "station_count": int(source["station_count"]),
        "checkpoints": checkpoints,
        "entry_type": source.get("entry_type") or "individual",
        "created_at": source["created_at"],
        "updated_at": source["updated_at"],
    }


def race_profile_response(profile: dict) -> dict:
    checkpoint_layout = None
    if profile["mode"] == "station_checkpoints":
        checkpoint_layout = (
            "station_starts"
            if "STATION_1_START" in profile["checkpoints"]
            else "station_boundaries"
        )
    return {
        "raceId": profile["race_id"],
        "name": profile["name"],
        "mode": profile["mode"],
        "stationCount": profile["station_count"],
        "checkpoints": profile["checkpoints"],
        "checkpointLayout": checkpoint_layout,
        "entryType": profile.get("entry_type") or "individual",
        "createdAt": profile["created_at"],
        "updatedAt": profile["updated_at"],
    }


def get_race_profile(race_id: str) -> dict:
    with connect_db() as db:
        row = db.execute(
            "SELECT * FROM race_profiles WHERE race_id = ?",
            (race_id,),
        ).fetchone()
    return race_profile_from_row(row) if row else default_race_profile(race_id)


def save_race_profile(profile: dict) -> dict:
    with connect_db() as db:
        db.execute(
            """
            INSERT INTO race_profiles (
              race_id, name, mode, station_count, checkpoints_json,
              entry_type, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (race_id) DO UPDATE SET
              name = excluded.name,
              mode = excluded.mode,
              station_count = excluded.station_count,
              checkpoints_json = excluded.checkpoints_json,
              entry_type = excluded.entry_type,
              updated_at = excluded.updated_at
            """,
            (
                profile["race_id"],
                profile["name"],
                profile["mode"],
                profile["station_count"],
                json.dumps(profile["checkpoints"]),
                profile.get("entry_type") or "individual",
                profile["created_at"],
                profile["updated_at"],
            ),
        )
        row = db.execute(
            "SELECT * FROM race_profiles WHERE race_id = ?",
            (profile["race_id"],),
        ).fetchone()
    return race_profile_from_row(row)


def normalize_race_profile_payload(payload: dict) -> dict:
    race_id = str(payload.get("raceId") or "").strip()
    if not race_id or len(race_id) > 80 or not all(
        character.isalnum() or character in "-_" for character in race_id
    ):
        raise ValueError("raceId must contain only letters, numbers, hyphens, or underscores")
    mode = str(payload.get("mode") or "two_reader_auto").strip().lower()
    mode_aliases = {"auto": "two_reader_auto", "manual": "station_checkpoints"}
    mode = mode_aliases.get(mode, mode)
    name = str(payload.get("name") or race_id).strip()
    try:
        station_count = int(payload.get("stationCount", 8))
    except (TypeError, ValueError):
        raise ValueError("stationCount must be an integer")
    existing = get_race_profile(race_id)
    entry_type = str(
        payload.get("entryType") or existing.get("entry_type") or "individual"
    ).strip().lower()
    checkpoint_layout = str(payload.get("checkpointLayout") or "").strip().lower()
    if checkpoint_layout not in {"", "station_starts", "station_boundaries"}:
        raise ValueError("checkpointLayout must be station_starts or station_boundaries")
    checkpoints = None
    if mode == "station_checkpoints" and checkpoint_layout == "station_boundaries":
        checkpoints = build_station_boundary_checkpoints(station_count)
    elif mode == "station_checkpoints" and checkpoint_layout == "station_starts":
        checkpoints = build_station_checkpoints(station_count)
    elif (
        existing["mode"] == mode
        and existing["station_count"] == station_count
    ):
        checkpoints = existing["checkpoints"]
    return make_race_profile(
        race_id,
        name,
        mode,
        station_count,
        created_at=existing["created_at"],
        updated_at=utc_now(),
        checkpoints=checkpoints,
        entry_type=entry_type,
    )


def row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


def parse_member_names(value, fallback_name: str = "") -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = []
    if not isinstance(value, list):
        value = []
    names = [str(name).strip() for name in value if str(name).strip()]
    if not names and fallback_name:
        names = [fallback_name]
    return names


def normalize_participant_entry(payload: dict) -> dict:
    entry_type = str(payload.get("entryType") or "individual").strip().lower()
    entry_type = {"single": "individual", "double": "doubles"}.get(
        entry_type,
        entry_type,
    )
    if entry_type not in ENTRY_TYPES:
        raise ValueError("entryType must be individual, doubles, or team")

    display_name = str(payload.get("athleteName") or "").strip()
    member_names = parse_member_names(payload.get("memberNames"), display_name)
    if any(len(name) > 100 for name in member_names):
        raise ValueError("each member name must be 100 characters or fewer")
    if entry_type == "individual":
        if len(member_names) != 1:
            raise ValueError("individual entries require exactly one member name")
        display_name = member_names[0]
    elif entry_type == "doubles":
        if not display_name:
            raise ValueError("doubles entries require a team name")
        if len(member_names) != 2:
            raise ValueError("doubles entries require exactly two member names")
    else:
        if not display_name:
            raise ValueError("team entries require a team name")
        if not 2 <= len(member_names) <= 12:
            raise ValueError("team entries require between 2 and 12 member names")

    return {
        "entry_type": entry_type,
        "display_name": display_name,
        "member_names": member_names,
    }


def participant_response(row: sqlite3.Row | dict) -> dict:
    source = row_to_dict(row) if isinstance(row, sqlite3.Row) else dict(row)
    entry_type = source.get("entry_type") or "individual"
    if entry_type not in ENTRY_TYPES:
        entry_type = "individual"
    member_names = parse_member_names(
        source.get("member_names"),
        str(source.get("athlete_name") or "").strip(),
    )
    source["entry_type"] = entry_type
    source["member_names"] = member_names
    source["member_count"] = len(member_names)
    return source


def timing_api_key() -> str:
    environment_key = os.environ.get("TIMING_API_KEY", "").strip()
    if environment_key:
        return environment_key
    try:
        return TIMING_API_KEY_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def leaderboard_clear_code() -> str:
    return os.environ.get("LEADERBOARD_CLEAR_CODE", "").strip()


def supabase_configured() -> bool:
    return bool(
        SUPABASE_SYNC_ENABLED
        and SUPABASE_URL
        and SUPABASE_PUBLISHABLE_KEY
        and timing_api_key()
    )


def supabase_row(row: sqlite3.Row | dict, columns: tuple[str, ...]) -> dict:
    source = row_to_dict(row) if isinstance(row, sqlite3.Row) else row
    result = {column: source.get(column) for column in columns}
    if "raw_json" in result and isinstance(result["raw_json"], str):
        try:
            result["raw_json"] = json.loads(result["raw_json"])
        except json.JSONDecodeError:
            result["raw_json"] = {"unparsed": result["raw_json"]}
    if "member_names" in result and isinstance(result["member_names"], str):
        result["member_names"] = parse_member_names(result["member_names"])
    return result


def supabase_upsert(table: str, records: list[dict]) -> None:
    if not records:
        return
    if table not in {"participants", "timing_events", "race_profiles"}:
        raise ValueError(f"Unsupported Supabase table: {table}")
    if not supabase_configured():
        raise RuntimeError("Supabase sync is not configured")

    conflict_key = "race_id" if table == "race_profiles" else "id"
    query = urlencode({"on_conflict": conflict_key})
    request = Request(
        f"{SUPABASE_URL}/rest/v1/{table}?{query}",
        data=json.dumps(records, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "apikey": SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
            "X-Timing-API-Key": timing_api_key(),
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_TIMEOUT_SECONDS) as response:
            if response.status not in {HTTPStatus.OK, HTTPStatus.CREATED, HTTPStatus.NO_CONTENT}:
                raise RuntimeError(f"Supabase returned HTTP {response.status}")
    except HTTPError as error:
        detail = error.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Supabase network error: {error.reason}") from error
    except TimeoutError as error:
        raise RuntimeError("Supabase request timed out") from error


def sync_supabase_record(table: str, row: sqlite3.Row | dict) -> dict:
    if not supabase_configured():
        return {"configured": False, "saved": False, "error": "not configured"}

    if table == "participants":
        columns = PARTICIPANT_COLUMNS
    elif table == "timing_events":
        columns = TIMING_EVENT_COLUMNS
    else:
        columns = RACE_PROFILE_COLUMNS
    attempted_at = utc_now()
    try:
        supabase_upsert(table, [supabase_row(row, columns)])
    except (RuntimeError, ValueError) as error:
        LAST_SUPABASE_SYNC.update(
            {"attemptedAt": attempted_at, "saved": False, "error": str(error)}
        )
        return {"configured": True, "saved": False, "error": str(error)}

    LAST_SUPABASE_SYNC.update(
        {"attemptedAt": attempted_at, "saved": True, "error": None}
    )
    return {"configured": True, "saved": True, "error": None}


def sync_all_to_supabase() -> dict:
    if not supabase_configured():
        raise RuntimeError(
            f"Supabase sync needs {TIMING_API_KEY_PATH.name} or TIMING_API_KEY"
        )

    with connect_db() as db:
        profile_rows = db.execute(
            "SELECT * FROM race_profiles ORDER BY race_id"
        ).fetchall()
        participant_rows = db.execute(
            "SELECT * FROM participants ORDER BY id"
        ).fetchall()
        event_rows = db.execute(
            "SELECT * FROM timing_events ORDER BY id"
        ).fetchall()

    profiles = [
        supabase_row(race_profile_from_row(row), RACE_PROFILE_COLUMNS)
        for row in profile_rows
    ]
    participants = [
        supabase_row(row, PARTICIPANT_COLUMNS) for row in participant_rows
    ]
    events = [supabase_row(row, TIMING_EVENT_COLUMNS) for row in event_rows]
    supabase_upsert("race_profiles", profiles)
    supabase_upsert("participants", participants)
    supabase_upsert("timing_events", events)
    completed_at = utc_now()
    LAST_SUPABASE_SYNC.update(
        {"attemptedAt": completed_at, "saved": True, "error": None}
    )
    return {
        "ok": True,
        "raceProfiles": len(profiles),
        "participants": len(participants),
        "timingEvents": len(events),
        "syncedAt": completed_at,
    }


def normalize_card_code(value: object) -> str:
    return str(value or "").strip().upper()


def milliseconds_between(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    start_time = parse_iso(start)
    end_time = parse_iso(end)
    if not start_time or not end_time:
        return None
    return max(0, int((end_time - start_time).total_seconds() * 1000))


def checkpoint_metadata(checkpoint: str) -> dict:
    if checkpoint == "START":
        return {
            "station_label": "Race Start",
            "station_number": None,
            "checkpoint_type": "start",
        }
    if checkpoint == "END":
        return {
            "station_label": "Race Finish",
            "station_number": None,
            "checkpoint_type": "end",
        }

    parts = checkpoint.split("_")
    if len(parts) == 3 and parts[0] == "STATION" and parts[1].isdigit():
        station_number = int(parts[1])
        checkpoint_type = parts[2].lower()
        return {
            "station_label": f"Station {station_number} {checkpoint_type.title()}",
            "station_number": station_number,
            "checkpoint_type": checkpoint_type,
        }

    return {
        "station_label": checkpoint,
        "station_number": None,
        "checkpoint_type": "unknown",
    }


def expected_auto_transition(
    latest_checkpoint: str | None,
    checkpoints: list[str] | None = None,
    finish_role: str = "RUN_OUT",
) -> tuple[str, str] | None:
    checkpoints = checkpoints or CHECKPOINT_SEQUENCE
    if latest_checkpoint is None:
        return ("RUN_OUT", checkpoints[0])
    if latest_checkpoint == "END":
        return None
    try:
        next_checkpoint = checkpoints[checkpoints.index(latest_checkpoint) + 1]
    except (ValueError, IndexError):
        return None

    if next_checkpoint == "START":
        return ("RUN_OUT", next_checkpoint)
    if next_checkpoint == "END":
        return (finish_role, next_checkpoint)
    if next_checkpoint.endswith("_ENTER"):
        return ("RUN_IN", next_checkpoint)
    if next_checkpoint.endswith("_EXIT"):
        return ("RUN_OUT", next_checkpoint)
    return None


def resolve_auto_transition(
    latest_checkpoint: str | None,
    gate_role: str,
    checkpoints: list[str] | None = None,
    finish_role: str = "RUN_OUT",
) -> dict:
    if latest_checkpoint == "END":
        return {
            "status": "already_finished",
            "currentCheckpoint": latest_checkpoint,
            "expectedRole": None,
            "expectedCheckpoint": None,
        }

    expected = expected_auto_transition(latest_checkpoint, checkpoints, finish_role)
    if expected is None:
        return {
            "status": "invalid_progress",
            "currentCheckpoint": latest_checkpoint,
            "expectedRole": None,
            "expectedCheckpoint": None,
        }

    expected_role, expected_checkpoint = expected
    if gate_role != expected_role:
        return {
            "status": "wrong_gate",
            "currentCheckpoint": latest_checkpoint,
            "expectedRole": expected_role,
            "expectedCheckpoint": expected_checkpoint,
        }

    return {
        "status": "accepted",
        "currentCheckpoint": latest_checkpoint,
        "expectedRole": expected_role,
        "expectedCheckpoint": expected_checkpoint,
        "assignedCheckpoint": expected_checkpoint,
    }


class TimingHandler(SimpleHTTPRequestHandler):
    server_version = "HyroxTimingTest/0.1"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        relative = parsed.path.lstrip("/") or "index.html"
        return str(ROOT / relative)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, apikey")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json(
                {
                    "ok": True,
                    "dbPath": str(DB_PATH),
                    "time": utc_now(),
                    "storage": {
                        "primary": "sqlite",
                        "cloudMirror": "supabase",
                        "supabaseConfigured": supabase_configured(),
                        "lastSupabaseSync": LAST_SUPABASE_SYNC,
                    },
                }
            )
            return

        if parsed.path == "/api/race-config":
            self.handle_get_race_config(parsed.query)
            return

        if parsed.path == "/api/races":
            self.handle_get_races()
            return

        if parsed.path == "/api/timing-events":
            self.handle_get_timing_events(parsed.query)
            return

        if parsed.path == "/api/participants":
            self.handle_get_participants(parsed.query)
            return

        if parsed.path == "/api/leaderboard":
            self.handle_get_leaderboard(parsed.query)
            return

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/reset-race":
            self.handle_post_reset_race()
            return

        if parsed.path == "/api/delete-participant":
            self.handle_post_delete_participant()
            return

        if parsed.path == "/api/timing-events":
            self.handle_post_timing_event()
            return

        if parsed.path == "/api/race-config":
            self.handle_post_race_config()
            return

        if parsed.path == "/api/participants":
            self.handle_post_participant()
            return

        self.send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def handle_post_reset_race(self) -> None:
        try:
            payload = self.read_json_body()
            race_id = str(payload.get("raceId") or "").strip()
            confirmation = str(payload.get("confirmation") or "").strip()
            supplied_code = str(payload.get("adminCode") or "")
            configured_code = leaderboard_clear_code()
            if len(configured_code) < 8:
                self.send_json(
                    {"ok": False, "error": "Race clearing is not configured"},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            if (
                not race_id
                or len(race_id) > 80
                or not all(character.isalnum() or character in "-_" for character in race_id)
            ):
                raise ValueError(
                    "raceId must contain only letters, numbers, hyphens, or underscores"
                )
            if confirmation != "SECOND_CONFIRMATION":
                raise ValueError("Second confirmation is required")
            if not supplied_code or not hmac.compare_digest(supplied_code, configured_code):
                self.send_json(
                    {"ok": False, "error": "Invalid administrator clear code"},
                    HTTPStatus.FORBIDDEN,
                )
                return

            with connect_db() as db:
                event_count = db.execute(
                    "SELECT COUNT(*) FROM timing_events WHERE race_id = ?",
                    (race_id,),
                ).fetchone()[0]
                participant_count = db.execute(
                    "SELECT COUNT(*) FROM participants WHERE race_id = ?",
                    (race_id,),
                ).fetchone()[0]
                db.execute("DELETE FROM timing_events WHERE race_id = ?", (race_id,))
                db.execute("DELETE FROM participants WHERE race_id = ?", (race_id,))

            self.send_json(
                {
                    "ok": True,
                    "raceId": race_id,
                    "deleted": {
                        "timingEvents": event_count,
                        "participants": participant_count,
                    },
                    "raceProfilePreserved": True,
                }
            )
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def handle_post_delete_participant(self) -> None:
        try:
            payload = self.read_json_body()
            race_id = str(payload.get("raceId") or "").strip()
            card_code = normalize_card_code(payload.get("cardCode"))
            confirmation = str(payload.get("confirmation") or "").strip()
            supplied_code = str(payload.get("adminCode") or "")
            configured_code = leaderboard_clear_code()
            if len(configured_code) < 8:
                self.send_json(
                    {"ok": False, "error": "Participant deletion is not configured"},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            if (
                not race_id
                or len(race_id) > 80
                or not all(character.isalnum() or character in "-_" for character in race_id)
            ):
                raise ValueError(
                    "raceId must contain only letters, numbers, hyphens, or underscores"
                )
            if not card_code:
                raise ValueError("cardCode is required")
            if confirmation != "DELETE_PARTICIPANT":
                raise ValueError("Participant deletion confirmation is required")
            if not supplied_code or not hmac.compare_digest(supplied_code, configured_code):
                self.send_json(
                    {"ok": False, "error": "Invalid administrator clear code"},
                    HTTPStatus.FORBIDDEN,
                )
                return

            with connect_db() as db:
                event_count = db.execute(
                    "SELECT COUNT(*) FROM timing_events WHERE race_id = ? AND card_code = ?",
                    (race_id, card_code),
                ).fetchone()[0]
                participant_count = db.execute(
                    "SELECT COUNT(*) FROM participants WHERE race_id = ? AND card_code = ?",
                    (race_id, card_code),
                ).fetchone()[0]
                db.execute(
                    "DELETE FROM timing_events WHERE race_id = ? AND card_code = ?",
                    (race_id, card_code),
                )
                db.execute(
                    "DELETE FROM participants WHERE race_id = ? AND card_code = ?",
                    (race_id, card_code),
                )

            self.send_json(
                {
                    "ok": True,
                    "raceId": race_id,
                    "cardCode": card_code,
                    "deleted": {
                        "timingEvents": event_count,
                        "participants": participant_count,
                    },
                    "raceProfilePreserved": True,
                }
            )
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

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

    def handle_get_race_config(self, query: str) -> None:
        params = parse_qs(query)
        race_id = params.get("raceId", [""])[0].strip()
        if not race_id:
            self.send_json(
                {"ok": False, "error": "raceId is required"},
                HTTPStatus.BAD_REQUEST,
            )
            return
        self.send_json({"ok": True, "race": race_profile_response(get_race_profile(race_id))})

    def handle_get_races(self) -> None:
        with connect_db() as db:
            rows = db.execute(
                "SELECT * FROM race_profiles ORDER BY updated_at DESC, race_id"
            ).fetchall()
        self.send_json(
            {
                "ok": True,
                "races": [race_profile_response(race_profile_from_row(row)) for row in rows],
            }
        )

    def handle_post_race_config(self) -> None:
        try:
            payload = self.read_json_body()
            profile = save_race_profile(normalize_race_profile_payload(payload))
            cloud = sync_supabase_record("race_profiles", profile)
            self.send_json(
                {
                    "ok": True,
                    "race": race_profile_response(profile),
                    "storage": {
                        "localSaved": True,
                        "supabaseSaved": cloud["saved"],
                    },
                    "cloudError": cloud["error"],
                }
            )
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

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
                  participants.division,
                  participants.phone,
                  participants.gender,
                  participants.check_in_status
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

        self.send_json(
            {
                "ok": True,
                "participants": [participant_response(row) for row in rows],
            }
        )

    def handle_get_leaderboard(self, query: str) -> None:
        params = parse_qs(query)
        race_id = params.get("raceId", ["hyrox-sim-001"])[0]
        profile = get_race_profile(race_id)
        checkpoints = profile["checkpoints"]
        checkpoint_index = {checkpoint: index for index, checkpoint in enumerate(checkpoints)}
        with connect_db() as db:
            participant_rows = db.execute(
                """
                SELECT *
                FROM participants
                WHERE race_id = ?
                ORDER BY bib_number IS NULL, bib_number, athlete_name
                """,
                (race_id,),
            ).fetchall()
            event_rows = db.execute(
                """
                SELECT *
                FROM timing_events
                WHERE race_id = ? AND status = 'accepted' AND participant_id IS NOT NULL
                ORDER BY event_time ASC, id ASC
                """,
                (race_id,),
            ).fetchall()

        leaderboard = self.build_leaderboard(
            participant_rows,
            event_rows,
            checkpoints,
            checkpoint_index,
            profile["station_count"],
            profile["mode"],
        )
        self.send_json(
            {
                "ok": True,
                "raceId": race_id,
                "race": race_profile_response(profile),
                "generatedAt": utc_now(),
                "checkpoints": checkpoints,
                "leaderboard": leaderboard,
            }
        )

    def build_leaderboard(
        self,
        participant_rows: list[sqlite3.Row],
        event_rows: list[sqlite3.Row],
        checkpoint_sequence: list[str],
        checkpoint_index: dict[str, int],
        station_count: int,
        profile_mode: str,
    ) -> list[dict]:
        events_by_participant: dict[int, list[sqlite3.Row]] = {}
        for event in event_rows:
            events_by_participant.setdefault(event["participant_id"], []).append(event)

        generated_at = utc_now()
        results = []
        for participant in participant_rows:
            participant_data = participant_response(participant)
            checkpoint_times = self.build_checkpoint_map(
                events_by_participant.get(participant["id"], []),
                checkpoint_index,
            )
            start_time = checkpoint_times.get("START")
            end_time = checkpoint_times.get("END")
            latest_checkpoint = self.latest_checkpoint(checkpoint_times, checkpoint_index)
            progress_index = checkpoint_index.get(latest_checkpoint, -1)
            status = self.result_status(latest_checkpoint, end_time)
            elapsed_end = end_time if end_time else generated_at
            elapsed_ms = milliseconds_between(start_time, elapsed_end) if start_time else None

            results.append(
                {
                    "participantId": participant["id"],
                    "athleteName": participant["athlete_name"],
                    "bibNumber": participant["bib_number"],
                    "cardCode": participant["card_code"],
                    "entryType": participant_data["entry_type"],
                    "memberNames": participant_data["member_names"],
                    "memberCount": participant_data["member_count"],
                    "phone": participant["phone"],
                    "gender": participant["gender"],
                    "division": participant["division"],
                    "checkInStatus": participant["check_in_status"],
                    "status": status,
                    "current": self.current_label(
                        checkpoint_times,
                        latest_checkpoint,
                        profile_mode,
                        checkpoint_sequence,
                    ),
                    "progressIndex": progress_index,
                    "latestCheckpoint": latest_checkpoint,
                    "startTime": start_time,
                    "finishTime": end_time,
                    "elapsedMs": elapsed_ms,
                    "checkpointTimes": checkpoint_times,
                    "stationSplits": self.station_splits(
                        checkpoint_times,
                        station_count,
                        profile_mode,
                        checkpoint_sequence,
                    ),
                    "segmentSplits": self.segment_splits(
                        checkpoint_times,
                        station_count,
                        profile_mode,
                    ),
                }
            )

        results.sort(key=self.leaderboard_sort_key)
        leader_elapsed = results[0]["elapsedMs"] if results else None
        for index, result in enumerate(results, start=1):
            result["rank"] = index
            if result["elapsedMs"] is None or leader_elapsed is None:
                result["gapMs"] = None
            else:
                result["gapMs"] = max(0, result["elapsedMs"] - leader_elapsed)
        return results

    def build_checkpoint_map(
        self,
        events: list[sqlite3.Row],
        checkpoint_index: dict[str, int],
    ) -> dict[str, str]:
        checkpoints = {}
        for event in events:
            station_id = event["station_id"]
            if station_id in checkpoint_index and station_id not in checkpoints:
                checkpoints[station_id] = event["event_time"]
        return checkpoints

    def latest_checkpoint(
        self,
        checkpoints: dict[str, str],
        checkpoint_index: dict[str, int],
    ) -> str | None:
        latest = None
        latest_index = -1
        for checkpoint in checkpoints:
            current_index = checkpoint_index.get(checkpoint, -1)
            if current_index > latest_index:
                latest = checkpoint
                latest_index = current_index
        return latest

    def result_status(self, latest_checkpoint: str | None, end_time: str | None) -> str:
        if end_time:
            return "finished"
        if latest_checkpoint:
            return "racing"
        return "not_started"

    def current_label(
        self,
        checkpoints: dict[str, str],
        latest_checkpoint: str | None,
        profile_mode: str,
        checkpoint_sequence: list[str],
    ) -> str:
        if latest_checkpoint is None:
            return "Waiting"
        if latest_checkpoint == "END":
            return "Finished"
        if latest_checkpoint == "START":
            if (
                profile_mode == "station_checkpoints"
                and "STATION_1_START" not in checkpoint_sequence
            ):
                return "Station 1"
            return "Run 1"

        for station_number in range(1, 21):
            enter = f"STATION_{station_number}_ENTER"
            exit_ = f"STATION_{station_number}_EXIT"
            station_start = f"STATION_{station_number}_START"
            if latest_checkpoint == station_start:
                return f"Station {station_number}"
            if latest_checkpoint == enter and exit_ not in checkpoints:
                return f"Station {station_number}"
            if latest_checkpoint == exit_:
                return "To END" if station_number == 8 else f"Run {station_number + 1}"
        return latest_checkpoint

    def station_splits(
        self,
        checkpoints: dict[str, str],
        station_count: int,
        profile_mode: str,
        checkpoint_sequence: list[str],
    ) -> dict[str, int | None]:
        splits = {}
        if profile_mode == "station_checkpoints":
            if "STATION_1_START" not in checkpoint_sequence:
                for station_number in range(1, station_count + 1):
                    start_checkpoint = (
                        "START"
                        if station_number == 1
                        else f"STATION_{station_number}_START"
                    )
                    end_checkpoint = (
                        "END"
                        if station_number == station_count
                        else f"STATION_{station_number + 1}_START"
                    )
                    splits[f"station{station_number}Ms"] = milliseconds_between(
                        checkpoints.get(start_checkpoint),
                        checkpoints.get(end_checkpoint),
                    )
                return splits

            previous = checkpoints.get("START")
            for station_number in range(1, station_count + 1):
                current = checkpoints.get(f"STATION_{station_number}_START")
                splits[f"station{station_number}Ms"] = milliseconds_between(
                    previous,
                    current,
                )
                previous = current
            return splits

        for station_number in range(1, station_count + 1):
            enter = checkpoints.get(f"STATION_{station_number}_ENTER")
            exit_ = checkpoints.get(f"STATION_{station_number}_EXIT")
            if station_number == station_count and not exit_:
                exit_ = checkpoints.get("END")
            splits[f"station{station_number}Ms"] = milliseconds_between(enter, exit_)
        return splits

    def segment_splits(
        self,
        checkpoints: dict[str, str],
        station_count: int,
        profile_mode: str,
    ) -> list[dict]:
        if profile_mode == "station_checkpoints":
            return []
        segments = []
        for station_number in range(1, station_count + 1):
            enter_checkpoint = f"STATION_{station_number}_ENTER"
            exit_checkpoint = (
                "END"
                if station_number == station_count
                else f"STATION_{station_number}_EXIT"
            )
            run_start_checkpoint = (
                "START"
                if station_number == 1
                else f"STATION_{station_number - 1}_EXIT"
            )
            segments.append(
                {
                    "type": "run",
                    "number": station_number,
                    "elapsedMs": milliseconds_between(
                        checkpoints.get(run_start_checkpoint),
                        checkpoints.get(enter_checkpoint),
                    ),
                }
            )
            segments.append(
                {
                    "type": "station",
                    "number": station_number,
                    "elapsedMs": milliseconds_between(
                        checkpoints.get(enter_checkpoint),
                        checkpoints.get(exit_checkpoint),
                    ),
                }
            )
        return segments

    def leaderboard_sort_key(self, result: dict) -> tuple:
        status_order = {"finished": 0, "racing": 1, "not_started": 2}
        elapsed = result["elapsedMs"] if result["elapsedMs"] is not None else 10**15
        return (
            status_order.get(result["status"], 3),
            -result["progressIndex"],
            elapsed,
            result["bibNumber"] or "",
            result["athleteName"] or "",
        )

    def handle_post_participant(self) -> None:
        try:
            payload = self.read_json_body()
            race_id = str(payload.get("raceId") or "hyrox-sim-001").strip()
            card_code = normalize_card_code(payload.get("cardCode"))
            entry = normalize_participant_entry(payload)
            athlete_name = entry["display_name"]
            entry_type = entry["entry_type"]
            member_names = entry["member_names"]
            bib_number = str(payload.get("bibNumber") or "").strip() or None
            phone = (
                str(payload.get("phone") or "").strip() or None
                if entry_type == "individual"
                else None
            )
            gender = (
                str(payload.get("gender") or "").strip() or None
                if entry_type == "individual"
                else None
            )
            division = (
                str(payload.get("division") or "").strip() or None
                if entry_type == "individual"
                else None
            )
            check_in_status = str(payload.get("checkInStatus") or "checked_in").strip()
            if not race_id or not card_code or not athlete_name:
                raise ValueError("raceId, cardCode and athleteName are required")
            if check_in_status not in {"not_checked_in", "checked_in"}:
                raise ValueError(
                    "checkInStatus must be not_checked_in or checked_in"
                )

            profile = get_race_profile(race_id)
            save_race_profile(profile)
            now = utc_now()
            with connect_db() as db:
                db.execute(
                    """
                    INSERT INTO participants (
                      race_id,
                      card_code,
                      athlete_name,
                      bib_number,
                      entry_type,
                      member_names,
                      phone,
                      gender,
                      division,
                      check_in_status,
                      created_at,
                      updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (race_id, card_code) DO UPDATE SET
                      athlete_name = excluded.athlete_name,
                      bib_number = excluded.bib_number,
                      entry_type = excluded.entry_type,
                      member_names = excluded.member_names,
                      phone = excluded.phone,
                      gender = excluded.gender,
                      division = excluded.division,
                      check_in_status = excluded.check_in_status,
                      updated_at = excluded.updated_at
                    """,
                    (
                        race_id,
                        card_code,
                        athlete_name,
                        bib_number,
                        entry_type,
                        json.dumps(member_names, ensure_ascii=False),
                        phone,
                        gender,
                        division,
                        check_in_status,
                        now,
                        now,
                    ),
                )
                row = db.execute(
                    "SELECT * FROM participants WHERE race_id = ? AND card_code = ?",
                    (race_id, card_code),
                ).fetchone()

            cloud = sync_supabase_record("participants", row)
            participant = participant_response(row)
            self.send_json(
                {
                    "ok": True,
                    "participant": participant,
                    "storage": {"localSaved": True, "supabaseSaved": cloud["saved"]},
                    "cloudError": cloud["error"],
                }
            )
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def handle_post_timing_event(self) -> None:
        try:
            payload = self.read_json_body()
            race_id = str(payload.get("raceId") or "").strip()
            if not race_id:
                raise ValueError("raceId is required")
            profile = get_race_profile(race_id)
            save_race_profile(profile)
            normalized = self.normalize_timing_payload(payload, profile)
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return

        with connect_db() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT * FROM timing_events WHERE event_id = ?",
                (normalized["event_id"],),
            ).fetchone()
            if existing:
                cloud = sync_supabase_record("timing_events", existing)
                self.send_json(
                    {
                        "ok": True,
                        "status": "duplicate_event_id",
                        "serverEventId": existing["id"],
                        "stationId": existing["station_id"],
                        "timingMode": existing["timing_mode"],
                        "gateRole": existing["gate_role"],
                        "duplicateWindowSeconds": existing[
                            "duplicate_window_seconds"
                        ],
                        "event": row_to_dict(existing),
                        "storage": {
                            "localSaved": True,
                            "supabaseSaved": cloud["saved"],
                        },
                        "cloudError": cloud["error"],
                    }
                )
                return

            participant = db.execute(
                "SELECT * FROM participants WHERE race_id = ? AND card_code = ?",
                (normalized["race_id"], normalized["card_code"]),
            ).fetchone()

            transition = {}
            previous = self.find_previous_scan(db, normalized)
            if not participant:
                status = "unbound_card"
            elif (
                previous
                and previous["status"] != "unbound_card"
                and self.is_duplicate_tap(
                    previous["event_time"],
                    normalized["event_time"],
                    normalized["duplicate_window_seconds"],
                )
            ):
                status = "duplicate_tap"
                if previous["station_id"] in CHECKPOINT_INDEX:
                    self.assign_checkpoint(normalized, previous["station_id"])
            elif profile["mode"] == "station_checkpoints":
                checkpoint_index = {
                    checkpoint: index
                    for index, checkpoint in enumerate(profile["checkpoints"])
                }
                latest_checkpoint = self.latest_accepted_checkpoint(
                    db,
                    normalized["race_id"],
                    participant["id"],
                    checkpoint_index,
                )
                if latest_checkpoint == "END":
                    status = "already_finished"
                    transition = {
                        "expectedCheckpoint": None,
                        "currentCheckpoint": latest_checkpoint,
                    }
                else:
                    expected = (
                        profile["checkpoints"][checkpoint_index[latest_checkpoint] + 1]
                        if latest_checkpoint is not None
                        else profile["checkpoints"][0]
                    )
                    if normalized["station_id"] != expected:
                        status = "wrong_checkpoint"
                        transition = {
                            "expectedCheckpoint": expected,
                            "currentCheckpoint": latest_checkpoint,
                        }
                    else:
                        status = "accepted"
            elif normalized["timing_mode"] == "auto":
                expected_sequence = profile["checkpoints"]
                finish_role = (
                    "FINISH"
                    if profile["mode"] == "three_reader_auto"
                    else "RUN_OUT"
                )
                latest_checkpoint = self.latest_accepted_checkpoint(
                    db,
                    normalized["race_id"],
                    participant["id"],
                    {
                        checkpoint: index
                        for index, checkpoint in enumerate(expected_sequence)
                    },
                )
                transition = resolve_auto_transition(
                    latest_checkpoint,
                    normalized["gate_role"],
                    expected_sequence,
                    finish_role,
                )
                status = transition["status"]
                if status == "accepted":
                    self.assign_checkpoint(
                        normalized,
                        transition["assignedCheckpoint"],
                    )
            else:
                status = "accepted"

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
                  timing_mode,
                  gate_role,
                  duplicate_window_seconds,
                  status,
                  participant_id,
                  raw_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    normalized["timing_mode"],
                    normalized["gate_role"],
                    normalized["duplicate_window_seconds"],
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
                  participants.division,
                  participants.phone,
                  participants.gender,
                  participants.check_in_status
                FROM timing_events
                LEFT JOIN participants ON participants.id = timing_events.participant_id
                WHERE timing_events.id = ?
                """,
                (event_id,),
            ).fetchone()

        next_transition = None
        if status == "wrong_checkpoint":
            next_transition = (None, transition.get("expectedCheckpoint"))
        elif normalized["station_id"] in profile["checkpoints"]:
            if profile["mode"] == "station_checkpoints":
                checkpoint_position = profile["checkpoints"].index(normalized["station_id"])
                next_transition = (
                    None,
                    profile["checkpoints"][checkpoint_position + 1],
                ) if checkpoint_position + 1 < len(profile["checkpoints"]) else None
            else:
                finish_role = (
                    "FINISH"
                    if profile["mode"] == "three_reader_auto"
                    else "RUN_OUT"
                )
                next_transition = expected_auto_transition(
                    normalized["station_id"],
                    profile["checkpoints"],
                    finish_role,
                )

        cloud = sync_supabase_record("timing_events", event)
        self.send_json(
            {
                "ok": True,
                "status": status,
                "serverEventId": event_id,
                "cardCode": normalized["card_code"],
                "stationId": normalized["station_id"],
                "stationLabel": normalized["station_label"],
                "timingMode": normalized["timing_mode"],
                "gateRole": normalized["gate_role"],
                "duplicateWindowSeconds": normalized[
                    "duplicate_window_seconds"
                ],
                "athleteName": event["athlete_name"],
                "bibNumber": event["bib_number"],
                "expectedRole": transition.get("expectedRole"),
                "expectedCheckpoint": transition.get("expectedCheckpoint"),
                "nextExpectedRole": next_transition[0] if next_transition else None,
                "nextCheckpoint": next_transition[1] if next_transition else None,
                "receivedAt": normalized["received_at"],
                "event": row_to_dict(event),
                "storage": {
                    "localSaved": True,
                    "supabaseSaved": cloud["saved"],
                },
                "cloudError": cloud["error"],
            },
            HTTPStatus.CREATED,
        )

    def normalize_timing_payload(self, payload: dict, profile: dict | None = None) -> dict:
        race_id = str(payload.get("raceId") or "").strip()
        device_id = str(payload.get("deviceId") or "").strip()
        timing_mode = str(payload.get("timingMode") or "manual").strip().lower()
        gate_role = str(payload.get("gateRole") or "").strip().upper() or None
        station_id = str(payload.get("stationId") or "").strip().upper()
        card_code = normalize_card_code(payload.get("cardCode"))
        event_time = str(payload.get("eventTime") or "").strip()

        if not race_id:
            raise ValueError("raceId is required")
        if not device_id:
            raise ValueError("deviceId is required")
        if timing_mode not in {"auto", "manual"}:
            raise ValueError("timingMode must be auto or manual")
        if profile and profile["mode"] == "station_checkpoints" and timing_mode == "auto":
            raise ValueError("This race uses fixed station checkpoints")
        if timing_mode == "auto":
            if gate_role not in AUTO_GATE_ROLES:
                raise ValueError(
                    "gateRole must be RUN_OUT, RUN_IN, or FINISH in auto mode"
                )
            station_id = f"AUTO_{gate_role}"
        elif not station_id:
            raise ValueError("stationId is required in manual mode")
        if profile and timing_mode != "auto" and station_id not in profile["checkpoints"]:
            raise ValueError("stationId is not part of this race profile")
        if not card_code:
            raise ValueError("cardCode is required")
        if not event_time:
            raise ValueError("eventTime is required")

        parsed_event_time = parse_iso(event_time)
        if not parsed_event_time:
            raise ValueError("eventTime must be ISO-8601")

        event_id = str(payload.get("eventId") or uuid.uuid4()).strip()
        duplicate_window_raw = payload.get(
            "duplicateWindowSeconds", DEFAULT_DUPLICATE_WINDOW_SECONDS
        )
        try:
            duplicate_window_seconds = int(duplicate_window_raw)
        except (TypeError, ValueError):
            raise ValueError("duplicateWindowSeconds must be an integer")
        if not (
            MIN_DUPLICATE_WINDOW_SECONDS
            <= duplicate_window_seconds
            <= MAX_DUPLICATE_WINDOW_SECONDS
        ):
            raise ValueError("duplicateWindowSeconds must be between 3 and 60")

        station_number = payload.get("stationNumber")
        if station_number in ("", None):
            station_number = None
        elif isinstance(station_number, int):
            pass
        else:
            station_number = int(station_number)

        station_label = str(payload.get("stationLabel") or station_id).strip()
        checkpoint_type = str(payload.get("checkpointType") or "").strip()
        if timing_mode == "auto":
            station_label = {
                "RUN_OUT": "Run Out Gate",
                "RUN_IN": "Run In Gate",
                "FINISH": "Finish Gate",
            }[gate_role]
            station_number = None
            checkpoint_type = "auto"

        return {
            "event_id": event_id,
            "race_id": race_id,
            "device_id": device_id,
            "station_id": station_id,
            "station_label": station_label,
            "station_number": station_number,
            "checkpoint_type": checkpoint_type,
            "card_code": card_code,
            "serial_number": str(payload.get("serialNumber") or "").strip(),
            "event_time": event_time,
            "received_at": utc_now(),
            "source": str(payload.get("source") or "unknown").strip(),
            "timing_mode": timing_mode,
            "gate_role": gate_role,
            "duplicate_window_seconds": duplicate_window_seconds,
        }

    def find_previous_scan(
        self,
        db: sqlite3.Connection,
        normalized: dict,
    ) -> sqlite3.Row | None:
        if normalized["timing_mode"] == "auto":
            return db.execute(
                """
                SELECT *
                FROM timing_events
                WHERE race_id = ?
                  AND card_code = ?
                  AND timing_mode = 'auto'
                  AND gate_role = ?
                ORDER BY event_time DESC, id DESC
                LIMIT 1
                """,
                (
                    normalized["race_id"],
                    normalized["card_code"],
                    normalized["gate_role"],
                ),
            ).fetchone()

        return db.execute(
            """
            SELECT *
            FROM timing_events
            WHERE race_id = ? AND card_code = ? AND station_id = ?
            ORDER BY event_time DESC, id DESC
            LIMIT 1
            """,
            (
                normalized["race_id"],
                normalized["card_code"],
                normalized["station_id"],
            ),
        ).fetchone()

    def latest_accepted_checkpoint(
        self,
        db: sqlite3.Connection,
        race_id: str,
        participant_id: int,
        checkpoint_index: dict[str, int] | None = None,
    ) -> str | None:
        checkpoint_index = checkpoint_index or CHECKPOINT_INDEX
        rows = db.execute(
            """
            SELECT station_id
            FROM timing_events
            WHERE race_id = ? AND participant_id = ? AND status = 'accepted'
            """,
            (race_id, participant_id),
        ).fetchall()
        checkpoints = [
            row["station_id"] for row in rows if row["station_id"] in checkpoint_index
        ]
        if not checkpoints:
            return None
        return max(checkpoints, key=checkpoint_index.get)

    def assign_checkpoint(self, normalized: dict, checkpoint: str) -> None:
        metadata = checkpoint_metadata(checkpoint)
        normalized["station_id"] = checkpoint
        normalized["station_label"] = metadata["station_label"]
        normalized["station_number"] = metadata["station_number"]
        normalized["checkpoint_type"] = metadata["checkpoint_type"]

    def is_duplicate_tap(
        self,
        previous_event_time: str,
        event_time: str,
        duplicate_window_seconds: int,
    ) -> bool:
        previous = parse_iso(previous_event_time)
        current = parse_iso(event_time)
        if not previous or not current:
            return False
        return (
            abs((current - previous).total_seconds())
            <= duplicate_window_seconds
        )


def main() -> int:
    init_db()
    if "--sync-only" in sys.argv:
        try:
            print(json.dumps(sync_all_to_supabase(), indent=2))
            return 0
        except RuntimeError as error:
            print(f"Supabase sync failed: {error}", file=sys.stderr)
            return 1

    try:
        sync_result = sync_all_to_supabase()
        print(
            "Supabase: synced "
            f"{sync_result['participants']} participants and "
            f"{sync_result['timingEvents']} timing events"
        )
    except RuntimeError as error:
        print(f"Supabase: unavailable ({error}); continuing with SQLite")

    try:
        server_port = int(os.environ.get("TIMING_SERVER_PORT", "8787"))
    except ValueError:
        print("TIMING_SERVER_PORT must be an integer", file=sys.stderr)
        return 2
    if not 1 <= server_port <= 65535:
        print("TIMING_SERVER_PORT must be between 1 and 65535", file=sys.stderr)
        return 2

    server = ThreadingHTTPServer(("0.0.0.0", server_port), TimingHandler)
    print("HYROX timing test server")
    print(f"Database: {DB_PATH}")
    print(f"Local:    http://localhost:{server_port}")
    print(f"API:      http://localhost:{server_port}/api/timing-events")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
