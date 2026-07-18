import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class QuietTimingHandler(server.TimingHandler):
    def log_message(self, format, *args):
        pass


class AutoTransitionTests(unittest.TestCase):
    def test_full_hyrox_sequence_uses_two_gate_roles(self):
        latest = None
        expected_checkpoints = ["START"]
        expected_checkpoints.extend(
            checkpoint
            for station_number in range(1, 8)
            for checkpoint in (
                f"STATION_{station_number}_ENTER",
                f"STATION_{station_number}_EXIT",
            )
        )
        expected_checkpoints.extend(["STATION_8_ENTER", "END"])

        for expected_checkpoint in expected_checkpoints:
            expected_role, _ = server.expected_auto_transition(latest)
            result = server.resolve_auto_transition(latest, expected_role)
            self.assertEqual(result["status"], "accepted")
            self.assertEqual(result["assignedCheckpoint"], expected_checkpoint)
            latest = result["assignedCheckpoint"]

        self.assertEqual(latest, "END")
        self.assertEqual(
            server.resolve_auto_transition(latest, "RUN_OUT")["status"],
            "already_finished",
        )

    def test_wrong_gate_does_not_assign_checkpoint(self):
        result = server.resolve_auto_transition("START", "RUN_OUT")
        self.assertEqual(result["status"], "wrong_gate")
        self.assertEqual(result["expectedRole"], "RUN_IN")
        self.assertNotIn("assignedCheckpoint", result)

    def test_three_reader_mode_reserves_end_for_finish_gate(self):
        checkpoints = server.build_two_reader_checkpoints(1)
        run_out = server.resolve_auto_transition(
            "STATION_1_ENTER",
            "RUN_OUT",
            checkpoints,
            "FINISH",
        )
        self.assertEqual(run_out["status"], "wrong_gate")
        self.assertEqual(run_out["expectedRole"], "FINISH")

        finish = server.resolve_auto_transition(
            "STATION_1_ENTER",
            "FINISH",
            checkpoints,
            "FINISH",
        )
        self.assertEqual(finish["status"], "accepted")
        self.assertEqual(finish["assignedCheckpoint"], "END")


class TimingApiTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db_path = server.DB_PATH
        self.original_supabase_sync_enabled = server.SUPABASE_SYNC_ENABLED
        self.original_clear_code = os.environ.get("LEADERBOARD_CLEAR_CODE")
        server.DB_PATH = Path(self.tempdir.name) / "timing.sqlite3"
        server.SUPABASE_SYNC_ENABLED = False
        os.environ["LEADERBOARD_CLEAR_CODE"] = "test-clear-code-1234"
        server.init_db()

        now = server.utc_now()
        with server.connect_db() as db:
            db.execute(
                """
                INSERT INTO participants (
                  race_id,
                  card_code,
                  athlete_name,
                  bib_number,
                  created_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("auto-test", "SIM-001", "Test Athlete", "001", now, now),
            )

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietTimingHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server.DB_PATH = self.original_db_path
        server.SUPABASE_SYNC_ENABLED = self.original_supabase_sync_enabled
        if self.original_clear_code is None:
            os.environ.pop("LEADERBOARD_CLEAR_CODE", None)
        else:
            os.environ["LEADERBOARD_CLEAR_CODE"] = self.original_clear_code
        self.tempdir.cleanup()

    def request_json(self, path, payload=None):
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(f"{self.base_url}{path}", data=data, headers=headers)
        with urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def timing_payload(self, index, role):
        event_time = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(
            seconds=index * 10
        )
        return {
            "eventId": f"event-{index}",
            "raceId": "auto-test",
            "deviceId": f"reader-{role.lower()}",
            "timingMode": "auto",
            "gateRole": role,
            "duplicateWindowSeconds": 10,
            "stationId": "AUTO",
            "cardCode": "SIM-001",
            "eventTime": event_time.isoformat().replace("+00:00", "Z"),
            "source": "unittest",
        }

    def test_api_advances_full_race_and_finishes_station_eight(self):
        latest = None
        for index in range(17):
            role, expected_checkpoint = server.expected_auto_transition(latest)
            response = self.request_json(
                "/api/timing-events",
                self.timing_payload(index, role),
            )
            self.assertEqual(response["status"], "accepted")
            self.assertEqual(response["stationId"], expected_checkpoint)
            latest = expected_checkpoint

        leaderboard = self.request_json("/api/leaderboard?raceId=auto-test")
        result = leaderboard["leaderboard"][0]
        self.assertEqual(result["status"], "finished")
        self.assertEqual(result["latestCheckpoint"], "END")
        self.assertEqual(result["stationSplits"]["station8Ms"], 10000)

    def test_reset_race_requires_admin_code_and_preserves_profile(self):
        event = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_OUT"),
        )
        self.assertEqual(event["status"], "accepted")

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/reset-race",
                {
                    "raceId": "auto-test",
                    "confirmation": "auto-test",
                    "adminCode": "wrong-code",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.FORBIDDEN)
        self.assertEqual(
            len(self.request_json("/api/participants?raceId=auto-test")["participants"]),
            1,
        )

        result = self.request_json(
            "/api/reset-race",
            {
                "raceId": "auto-test",
                "confirmation": "auto-test",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["deleted"], {"timingEvents": 1, "participants": 1})
        self.assertTrue(result["raceProfilePreserved"])
        self.assertEqual(
            self.request_json("/api/leaderboard?raceId=auto-test")["leaderboard"],
            [],
        )
        self.assertEqual(
            self.request_json("/api/race-config?raceId=auto-test")["race"]["raceId"],
            "auto-test",
        )

    def test_wrong_gate_is_stored_without_advancing_progress(self):
        start = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_OUT"),
        )
        self.assertEqual(start["stationId"], "START")

        wrong_gate = self.request_json(
            "/api/timing-events",
            self.timing_payload(2, "RUN_OUT"),
        )
        self.assertEqual(wrong_gate["status"], "wrong_gate")
        self.assertEqual(wrong_gate["expectedRole"], "RUN_IN")

        run_in = self.request_json(
            "/api/timing-events",
            self.timing_payload(3, "RUN_IN"),
        )
        self.assertEqual(run_in["status"], "accepted")
        self.assertEqual(run_in["stationId"], "STATION_1_ENTER")

    def test_duplicate_tap_within_ten_seconds_keeps_checkpoint(self):
        start = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_OUT"),
        )
        self.assertEqual(start["status"], "accepted")
        self.assertEqual(start["stationId"], "START")

        duplicate = self.request_json(
            "/api/timing-events",
            self.timing_payload(1, "RUN_OUT"),
        )
        self.assertEqual(duplicate["status"], "duplicate_tap")
        self.assertEqual(duplicate["stationId"], "START")
        self.assertEqual(duplicate["duplicateWindowSeconds"], 10)

        run_in = self.request_json(
            "/api/timing-events",
            self.timing_payload(2, "RUN_IN"),
        )
        self.assertEqual(run_in["status"], "accepted")
        self.assertEqual(run_in["stationId"], "STATION_1_ENTER")

    def test_manual_checkpoint_mode_remains_compatible(self):
        payload = self.timing_payload(0, "RUN_OUT")
        payload.update(
            {
                "timingMode": "manual",
                "gateRole": "",
                "stationId": "STATION_3_ENTER",
                "stationLabel": "Station 3 Enter",
                "stationNumber": 3,
                "checkpointType": "enter",
            }
        )
        response = self.request_json("/api/timing-events", payload)
        self.assertEqual(response["status"], "accepted")
        self.assertEqual(response["stationId"], "STATION_3_ENTER")
        self.assertEqual(response["timingMode"], "manual")
        self.assertTrue(response["storage"]["localSaved"])
        self.assertFalse(response["storage"]["supabaseSaved"])

    def test_participant_entries_support_individual_doubles_and_team(self):
        doubles = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "PAIR-001",
                "bibNumber": "D01",
                "athleteName": "Fast Pair",
                "entryType": "doubles",
                "memberNames": ["Runner One", "Runner Two"],
                "phone": "13800000000",
                "gender": "mixed",
                "division": "Doubles",
                "checkInStatus": "checked_in",
            },
        )["participant"]
        self.assertEqual(doubles["entry_type"], "doubles")
        self.assertEqual(doubles["member_names"], ["Runner One", "Runner Two"])
        self.assertEqual(doubles["member_count"], 2)
        self.assertIsNone(doubles["phone"])
        self.assertIsNone(doubles["gender"])
        self.assertIsNone(doubles["division"])

        team = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "TEAM-001",
                "bibNumber": "T01",
                "athleteName": "SRC Team",
                "entryType": "team",
                "memberNames": ["A", "B", "C", "D"],
                "checkInStatus": "checked_in",
            },
        )["participant"]
        self.assertEqual(team["entry_type"], "team")
        self.assertEqual(team["member_names"], ["A", "B", "C", "D"])
        self.assertEqual(team["member_count"], 4)

        participants = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"]
        existing = next(row for row in participants if row["card_code"] == "SIM-001")
        self.assertEqual(existing["entry_type"], "individual")
        self.assertEqual(existing["member_names"], ["Test Athlete"])

        leaderboard = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"]
        team_row = next(row for row in leaderboard if row["cardCode"] == "TEAM-001")
        self.assertEqual(team_row["athleteName"], "SRC Team")
        self.assertEqual(team_row["entryType"], "team")
        self.assertEqual(team_row["memberNames"], ["A", "B", "C", "D"])
        self.assertEqual(team_row["memberCount"], 4)

    def test_three_reader_api_requires_finish_role_for_end(self):
        server.save_race_profile(
            server.make_race_profile(
                "auto-test",
                "Three Reader Test",
                "three_reader_auto",
                1,
            )
        )

        start = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_OUT"),
        )
        self.assertEqual(start["stationId"], "START")

        station = self.request_json(
            "/api/timing-events",
            self.timing_payload(2, "RUN_IN"),
        )
        self.assertEqual(station["stationId"], "STATION_1_ENTER")

        wrong_finish = self.request_json(
            "/api/timing-events",
            self.timing_payload(4, "RUN_OUT"),
        )
        self.assertEqual(wrong_finish["status"], "wrong_gate")
        self.assertEqual(wrong_finish["expectedRole"], "FINISH")

        finish = self.request_json(
            "/api/timing-events",
            self.timing_payload(6, "FINISH"),
        )
        self.assertEqual(finish["status"], "accepted")
        self.assertEqual(finish["stationId"], "END")


class SupabaseSerializationTests(unittest.TestCase):
    def test_timing_event_raw_json_is_sent_as_jsonb(self):
        row = {
            column: None for column in server.TIMING_EVENT_COLUMNS
        }
        row["raw_json"] = '{"source":"test","accepted":true}'

        serialized = server.supabase_row(row, server.TIMING_EVENT_COLUMNS)

        self.assertEqual(
            serialized["raw_json"],
            {"source": "test", "accepted": True},
        )


class RaceProfileTests(TimingApiTests):
    def setUp(self):
        super().setUp()
        profile = server.make_race_profile(
            "station-test",
            "Saturday 5 Station Test",
            "station_checkpoints",
            5,
        )
        server.save_race_profile(profile)
        now = server.utc_now()
        with server.connect_db() as db:
            db.execute(
                """
                INSERT INTO participants (
                  race_id, card_code, athlete_name, bib_number,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("station-test", "STATION-001", "Station Athlete", "S001", now, now),
            )

    def station_payload(self, index, station_id):
        event_time = datetime(2026, 1, 2, tzinfo=timezone.utc) + timedelta(
            seconds=index * 10
        )
        return {
            "eventId": f"station-event-{index}",
            "raceId": "station-test",
            "deviceId": f"station-{station_id.lower()}",
            "timingMode": "manual",
            "stationId": station_id,
            "cardCode": "STATION-001",
            "eventTime": event_time.isoformat().replace("+00:00", "Z"),
            "source": "station-test",
        }

    def test_fixed_station_mode_accepts_profile_order_and_rejects_wrong_station(self):
        profile = server.get_race_profile("station-test")
        wrong = self.request_json(
            "/api/timing-events",
            self.station_payload(0, "STATION_2_START"),
        )
        self.assertEqual(wrong["status"], "wrong_checkpoint")
        self.assertEqual(wrong["expectedCheckpoint"], "START")

        for index, checkpoint in enumerate(profile["checkpoints"]):
            response = self.request_json(
                "/api/timing-events",
                self.station_payload(index + 1, checkpoint),
            )
            self.assertEqual(response["status"], "accepted")
            self.assertEqual(response["stationId"], checkpoint)

        finished = self.request_json(
            "/api/timing-events",
            self.station_payload(20, "END"),
        )
        self.assertEqual(finished["status"], "already_finished")

        leaderboard = self.request_json(
            "/api/leaderboard?raceId=station-test"
        )["leaderboard"][0]
        self.assertEqual(leaderboard["stationSplits"]["station1Ms"], 10000)
        self.assertEqual(leaderboard["stationSplits"]["station2Ms"], 10000)

    def test_race_config_endpoint_returns_mode_and_checkpoints(self):
        response = self.request_json("/api/race-config?raceId=station-test")
        self.assertEqual(response["race"]["mode"], "station_checkpoints")
        self.assertEqual(response["race"]["stationCount"], 5)
        self.assertEqual(
            response["race"]["checkpoints"],
            ["START", "STATION_1_START", "STATION_2_START", "STATION_3_START",
             "STATION_4_START", "STATION_5_START", "END"],
        )
        hoka = self.request_json("/api/race-config?raceId=hoka-race")["race"]
        self.assertEqual(hoka["entryType"], "team")

    def test_boundary_station_mode_uses_six_devices_and_adjacent_splits(self):
        race_id = "hoka-boundary-test"
        card_code = "HOKA-BOUNDARY-001"
        profile = server.make_race_profile(
            race_id,
            "Hoka Boundary Test",
            "station_checkpoints",
            5,
            checkpoints=server.build_station_boundary_checkpoints(5),
        )
        server.save_race_profile(profile)
        now = server.utc_now()
        with server.connect_db() as db:
            db.execute(
                """
                INSERT INTO participants (
                  race_id, card_code, athlete_name, bib_number,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (race_id, card_code, "Boundary Athlete", "HB001", now, now),
            )

        expected_checkpoints = [
            "START",
            "STATION_2_START",
            "STATION_3_START",
            "STATION_4_START",
            "STATION_5_START",
            "END",
        ]
        self.assertEqual(profile["checkpoints"], expected_checkpoints)
        offsets = [0, 10, 30, 60, 100, 150]
        base_time = datetime(2026, 1, 3, tzinfo=timezone.utc)
        for index, (checkpoint, offset) in enumerate(
            zip(expected_checkpoints, offsets, strict=True)
        ):
            response = self.request_json(
                "/api/timing-events",
                {
                    "eventId": f"hoka-boundary-{index}",
                    "raceId": race_id,
                    "deviceId": f"hoka-boundary-{checkpoint.lower()}",
                    "timingMode": "manual",
                    "stationId": checkpoint,
                    "cardCode": card_code,
                    "eventTime": (
                        base_time + timedelta(seconds=offset)
                    ).isoformat().replace("+00:00", "Z"),
                    "source": "hoka-boundary-test",
                },
            )
            self.assertEqual(response["status"], "accepted")

        race = self.request_json(
            f"/api/race-config?raceId={race_id}"
        )["race"]
        self.assertEqual(race["checkpointLayout"], "station_boundaries")
        leaderboard = self.request_json(
            f"/api/leaderboard?raceId={race_id}"
        )["leaderboard"][0]
        self.assertEqual(leaderboard["current"], "Finished")
        self.assertEqual(
            leaderboard["stationSplits"],
            {
                "station1Ms": 10000,
                "station2Ms": 20000,
                "station3Ms": 30000,
                "station4Ms": 40000,
                "station5Ms": 50000,
            },
        )


if __name__ == "__main__":
    unittest.main()
