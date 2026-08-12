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
        result = server.resolve_auto_transition("START", "RUN_IN")
        self.assertEqual(result["status"], "wrong_gate")
        self.assertEqual(result["expectedRole"], "RUN_OUT")
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
        self.original_timing_environment = server.TIMING_ENVIRONMENT
        self.original_clear_code = os.environ.get("LEADERBOARD_CLEAR_CODE")
        server.DB_PATH = Path(self.tempdir.name) / "timing.sqlite3"
        server.SUPABASE_SYNC_ENABLED = False
        server.TIMING_ENVIRONMENT = "test"
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
        server.TIMING_ENVIRONMENT = self.original_timing_environment
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

    def timing_payload_for_card(self, index, role, card_code, prefix):
        payload = self.timing_payload(index, role)
        payload["eventId"] = f"{prefix}-event-{index}"
        payload["cardCode"] = card_code
        payload["deviceId"] = f"{prefix}-{role.lower()}"
        return payload

    def assert_post_error(self, path, payload, expected_status):
        with self.assertRaises(HTTPError) as error_context:
            self.request_json(path, payload)
        self.assertEqual(error_context.exception.code, expected_status)
        return json.loads(error_context.exception.read().decode("utf-8"))

    def test_judge_auth_validates_admin_code_without_changing_race_data(self):
        self.assert_post_error(
            "/api/judge-auth",
            {"adminCode": "wrong-code"},
            HTTPStatus.FORBIDDEN,
        )
        authenticated = self.request_json(
            "/api/judge-auth",
            {"adminCode": "test-clear-code-1234"},
        )
        self.assertTrue(authenticated["ok"])
        self.assertTrue(authenticated["authenticated"])

        admin_account = self.request_json(
            "/api/judge-auth",
            {
                "raceId": "auto-test",
                "username": "admin",
                "password": "test-clear-code-1234",
            },
        )
        self.assertEqual(admin_account["role"], "admin")
        self.assertEqual(admin_account["displayName"], "全局管理员")
        self.assertTrue(admin_account["judgeToken"])
        cross_race_accounts = self.request_json(
            "/api/judge-station-accounts?raceId=nfc-test-001&judgeToken="
            + admin_account["judgeToken"]
        )
        self.assertTrue(cross_race_accounts["ok"])

        configured_code = os.environ.pop("LEADERBOARD_CLEAR_CODE")
        try:
            self.assert_post_error(
                "/api/judge-auth",
                {"adminCode": configured_code},
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
        finally:
            os.environ["LEADERBOARD_CLEAR_CODE"] = configured_code

    def test_judge_station_accounts_authenticate_and_enforce_roles(self):
        self.request_json(
            "/api/race-config",
            {
                "raceId": "auto-test",
                "name": "Station Judge Test",
                "mode": "station_checkpoints",
                "stationCount": 5,
                "checkpointLayout": "station_boundaries",
                "entryType": "team",
            },
        )
        for role, username in (("start", "start-judge"), ("station_1", "station-1")):
            account = self.request_json(
                "/api/judge-station-accounts",
                {
                    "raceId": "auto-test",
                    "role": role,
                    "username": username,
                    "password": "test-password-123",
                    "displayName": f"Test {role}",
                    "active": True,
                    "adminCode": "test-clear-code-1234",
                },
            )["account"]
            self.assertEqual(account["role"], role)
            self.assertNotIn("passwordHash", account)

        listing = self.request_json(
            "/api/judge-station-accounts?raceId=auto-test&adminCode=test-clear-code-1234"
        )["accounts"]
        self.assertEqual({account["role"] for account in listing}, {"start", "station_1"})
        self.assertTrue(all("passwordHash" not in account for account in listing))

        start_auth = self.request_json(
            "/api/judge-auth",
            {
                "raceId": "auto-test",
                "username": "START-JUDGE",
                "password": "test-password-123",
            },
        )
        self.assertEqual(start_auth["role"], "start")
        self.assertEqual(start_auth["allowedCheckpoint"], "START")
        self.assertTrue(start_auth["judgeToken"])

        station_auth = self.request_json(
            "/api/judge-auth",
            {
                "raceId": "auto-test",
                "username": "station-1",
                "password": "test-password-123",
            },
        )
        self.assertEqual(station_auth["role"], "station_1")
        self.assertEqual(station_auth["allowedCheckpoint"], "STATION_2_START")

        self.assert_post_error(
            "/api/start-race",
            {
                "raceId": "auto-test",
                "participantIds": [1],
                "judgeToken": station_auth["judgeToken"],
            },
            HTTPStatus.FORBIDDEN,
        )
        self.assert_post_error(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_2_START",
                "eventTime": "2026-01-01T00:00:10Z",
                "reason": "role permission check",
                "judgeToken": start_auth["judgeToken"],
            },
            HTTPStatus.FORBIDDEN,
        )
        manual_start = self.request_json(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "START",
                "eventTime": "2026-01-01T00:00:05Z",
                "reason": "start NFC fallback",
                "judgeToken": start_auth["judgeToken"],
            },
        )
        self.assertEqual(manual_start["stationId"], "START")
        queue_entry = self.request_json("/api/start-queue?raceId=auto-test")["entries"][0]
        self.assertEqual(queue_entry["status"], "started")
        station_checkpoint = self.request_json(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_2_START",
                "eventTime": "2026-01-01T00:00:20Z",
                "judgeToken": station_auth["judgeToken"],
            },
        )
        self.assertEqual(station_checkpoint["stationId"], "STATION_2_START")
        self.assertEqual(
            json.loads(station_checkpoint["event"]["raw_json"])["reason"],
            "现场裁判人工确认",
        )
        self.assert_post_error(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_2_START",
                "eventTime": "2026-01-01T00:00:21Z",
                "reason": "previous station must remain locked",
                "judgeToken": station_auth["judgeToken"],
            },
            HTTPStatus.CONFLICT,
        )
        self.assert_post_error(
            "/api/judge-auth",
            {
                "raceId": "auto-test",
                "username": "station-1",
                "password": "wrong-password",
            },
            HTTPStatus.FORBIDDEN,
        )

        self.request_json(
            "/api/judge-station-accounts",
            {
                "raceId": "auto-test",
                "role": "station_1",
                "username": "station-1",
                "displayName": "Test station_1",
                "active": False,
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assert_post_error(
            "/api/judge-auth",
            {
                "raceId": "auto-test",
                "username": "station-1",
                "password": "test-password-123",
            },
            HTTPStatus.FORBIDDEN,
        )

    def test_admin_can_rollback_latest_checkpoint_and_paired_finish(self):
        self.request_json(
            "/api/race-config",
            {
                "raceId": "auto-test",
                "name": "Checkpoint Rollback Test",
                "mode": "station_checkpoints",
                "stationCount": 5,
                "checkpointLayout": "station_starts",
                "entryType": "team",
            },
        )
        account = self.request_json(
            "/api/judge-station-accounts",
            {
                "raceId": "auto-test",
                "role": "station_1",
                "username": "station-one",
                "password": "test-password-123",
                "active": True,
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertTrue(account["ok"])
        station_auth = self.request_json(
            "/api/judge-auth",
            {
                "raceId": "auto-test",
                "username": "station-one",
                "password": "test-password-123",
            },
        )
        base_payload = {
            "raceId": "auto-test",
            "participantId": 1,
            "adminCode": "test-clear-code-1234",
        }
        for station_id, second in (
            ("START", 10),
            ("STATION_1_START", 20),
            ("STATION_2_START", 30),
        ):
            self.request_json(
                "/api/manual-checkpoints",
                {
                    **base_payload,
                    "stationId": station_id,
                    "eventTime": f"2026-01-01T00:00:{second:02d}Z",
                },
            )

        self.assert_post_error(
            "/api/rollback-checkpoint",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "judgeToken": station_auth["judgeToken"],
            },
            HTTPStatus.FORBIDDEN,
        )
        rollback = self.request_json(
            "/api/rollback-checkpoint",
            base_payload,
        )
        self.assertEqual(rollback["status"], "reverted")
        self.assertEqual(rollback["revertedStationIds"], ["STATION_2_START"])
        self.assertEqual(rollback["previousCheckpoint"], "STATION_1_START")
        leaderboard = self.request_json("/api/leaderboard?raceId=auto-test")["leaderboard"][0]
        self.assertEqual(leaderboard["latestCheckpoint"], "STATION_1_START")
        with server.connect_db() as db:
            reverted = db.execute(
                "SELECT status, raw_json FROM timing_events "
                "WHERE race_id = ? AND participant_id = ? AND station_id = ? "
                "ORDER BY id DESC LIMIT 1",
                ("auto-test", 1, "STATION_2_START"),
            ).fetchone()
        self.assertEqual(reverted["status"], "reverted")
        self.assertEqual(json.loads(reverted["raw_json"])["rollback"]["reason"], "管理员撤回误触")

        for station_id, second in (
            ("STATION_2_START", 31),
            ("STATION_3_START", 40),
            ("STATION_4_START", 50),
            ("STATION_5_START", 59),
        ):
            self.request_json(
                "/api/manual-checkpoints",
                {
                    **base_payload,
                    "stationId": station_id,
                    "eventTime": f"2026-01-01T00:00:{second:02d}Z",
                },
            )
        finish_rollback = self.request_json("/api/rollback-checkpoint", base_payload)
        self.assertEqual(
            finish_rollback["revertedStationIds"],
            ["STATION_5_START", "END"],
        )
        self.assertEqual(finish_rollback["previousCheckpoint"], "STATION_4_START")
        after_finish_rollback = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"][0]
        self.assertEqual(after_finish_rollback["status"], "racing")
        self.assertEqual(after_finish_rollback["latestCheckpoint"], "STATION_4_START")

    def test_station_start_judge_roles_include_station_one_and_finish(self):
        profile = server.make_race_profile(
            "hoka-role-test",
            "HOKA Role Test",
            "station_checkpoints",
            5,
            checkpoints=server.build_station_checkpoints(5),
            entry_type="team",
        )
        self.assertEqual(server.judge_role_checkpoints(profile, "start"), ["START"])
        self.assertEqual(
            server.judge_role_checkpoints(profile, "station_1"),
            ["STATION_1_START"],
        )
        self.assertEqual(
            server.judge_role_checkpoints(profile, "station_5"),
            ["STATION_5_START", "END"],
        )
        self.assertEqual(
            server.manual_checkpoint_station_ids(profile, "STATION_5_START"),
            ["STATION_5_START", "END"],
        )

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
        self.assertEqual(len(result["segmentSplits"]), 16)
        self.assertEqual(result["segmentSplits"][0]["type"], "run")
        self.assertEqual(result["segmentSplits"][0]["number"], 1)
        self.assertEqual(result["segmentSplits"][-1]["type"], "station")
        self.assertEqual(result["segmentSplits"][-1]["number"], 8)

    def test_reset_race_requires_admin_code_and_preserves_profile(self):
        event = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_IN"),
        )
        self.assertEqual(event["status"], "accepted")

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/reset-race",
                {
                    "raceId": "auto-test",
                    "adminCode": "test-clear-code-1234",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.BAD_REQUEST)

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/reset-race",
                {
                    "raceId": "auto-test",
                    "confirmation": "SECOND_CONFIRMATION",
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
                "confirmation": "SECOND_CONFIRMATION",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertTrue(result["ok"])
        self.assertEqual(
            result["deleted"],
            {
                "timingEvents": 1,
                "participants": 1,
                "resultAdjustments": 0,
                "manualResults": 0,
                "timingControls": 0,
                "startCheckins": 0,
            },
        )
        self.assertTrue(result["raceProfilePreserved"])
        self.assertEqual(
            self.request_json("/api/leaderboard?raceId=auto-test")["leaderboard"],
            [],
        )
        self.assertEqual(
            self.request_json("/api/race-config?raceId=auto-test")["race"]["raceId"],
            "auto-test",
        )

    def test_reset_timing_preserves_participants_cards_and_device_bindings(self):
        event = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_IN"),
        )
        self.assertEqual(event["status"], "accepted")
        binding = self.request_json(
            "/api/device-bindings",
            {
                "raceId": "auto-test",
                "deviceId": "reset-test-reader",
                "assignment": "RUN_IN",
            },
        )
        self.assertTrue(binding["ok"])
        with server.connect_db() as db:
            participant_id = db.execute(
                "SELECT id FROM participants WHERE race_id = ? AND card_code = ?",
                ("auto-test", "SIM-001"),
            ).fetchone()[0]
            db.execute(
                """
                INSERT INTO result_adjustments (
                  race_id, participant_id, adjustment_ms, reason, created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                ("auto-test", participant_id, 30000, "Reset timing test", server.utc_now()),
            )

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/reset-timing",
                {
                    "raceId": "auto-test",
                    "adminCode": "test-clear-code-1234",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.BAD_REQUEST)

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/reset-timing",
                {
                    "raceId": "auto-test",
                    "confirmation": "SECOND_CONFIRMATION",
                    "adminCode": "wrong-code",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.FORBIDDEN)

        result = self.request_json(
            "/api/reset-timing",
            {
                "raceId": "auto-test",
                "confirmation": "SECOND_CONFIRMATION",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertTrue(result["ok"])
        self.assertEqual(
            result["deleted"],
            {
                "timingEvents": 1,
                "resultAdjustments": 1,
                "manualResults": 0,
                "timingControls": 0,
                "startCheckins": 0,
            },
        )
        self.assertTrue(result["participantsPreserved"])
        self.assertTrue(result["deviceBindingsPreserved"])

        participants = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"]
        self.assertEqual(len(participants), 1)
        self.assertEqual(participants[0]["card_code"], "SIM-001")
        bindings = self.request_json(
            "/api/device-bindings?raceId=auto-test"
        )["bindings"]
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]["device_id"], "reset-test-reader")
        self.assertEqual(
            self.request_json("/api/result-adjustments?raceId=auto-test")["adjustments"],
            [],
        )
        leaderboard = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"]
        self.assertEqual(len(leaderboard), 1)
        self.assertEqual(leaderboard[0]["status"], "not_started")
        self.assertIsNone(leaderboard[0]["elapsedMs"])

    def test_dated_race_session_preserves_previous_race_history(self):
        source_race_id = "hoka-race-20260720-0900"
        session_race_id = "hoka-race-20260725-0900"
        self.request_json(
            "/api/race-config",
            {
                "raceId": source_race_id,
                "name": "Hoka Race 2026-07-20 09:00",
                "mode": "station_checkpoints",
                "entryType": "team",
                "stationCount": 5,
                "checkpointLayout": "station_boundaries",
            },
        )
        self.request_json(
            "/api/participants",
            {
                "raceId": source_race_id,
                "cardCode": "HISTORY-OLD",
                "athleteName": "Previous Hoka Team",
                "entryType": "team",
                "memberNames": ["Old 1", "Old 2", "Old 3", "Old 4"],
                "checkInStatus": "checked_in",
            },
        )
        session = self.request_json(
            "/api/race-config",
            {
                "raceId": session_race_id,
                "name": "Hoka Race 2026-07-25 09:00",
                "mode": "station_checkpoints",
                "entryType": "team",
                "stationCount": 5,
                "checkpointLayout": "station_boundaries",
            },
        )["race"]
        self.request_json(
            "/api/participants",
            {
                "raceId": session_race_id,
                "cardCode": "HISTORY-NEW",
                "athleteName": "New Hoka Team",
                "entryType": "team",
                "memberNames": ["New 1", "New 2", "New 3", "New 4"],
                "checkInStatus": "checked_in",
            },
        )

        self.assertEqual(session["checkpointLayout"], "station_boundaries")
        self.assertFalse(session["isTemplate"])
        previous_entries = self.request_json(
            f"/api/participants?raceId={source_race_id}"
        )["participants"]
        new_entries = self.request_json(
            f"/api/participants?raceId={session_race_id}"
        )["participants"]
        self.assertEqual(
            [row["athlete_name"] for row in previous_entries],
            ["Previous Hoka Team"],
        )
        self.assertEqual(
            [row["athlete_name"] for row in new_entries],
            ["New Hoka Team"],
        )

        self.request_json(
            "/api/reset-race",
            {
                "raceId": session_race_id,
                "confirmation": "SECOND_CONFIRMATION",
                "adminCode": "test-clear-code-1234",
            },
        )
        previous_entries_after_reset = self.request_json(
            f"/api/participants?raceId={source_race_id}"
        )["participants"]
        new_entries_after_reset = self.request_json(
            f"/api/participants?raceId={session_race_id}"
        )["participants"]
        preserved_profile = self.request_json(
            f"/api/race-config?raceId={session_race_id}"
        )["race"]
        self.assertEqual(len(previous_entries_after_reset), 1)
        self.assertEqual(new_entries_after_reset, [])
        self.assertEqual(preserved_profile["raceId"], session_race_id)

    def test_finalize_race_freezes_leaderboard_and_blocks_new_taps(self):
        first = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_IN"),
        )
        self.assertEqual(first["status"], "accepted")
        self.request_json(
            "/api/device-bindings",
            {
                "raceId": "auto-test",
                "deviceId": "finalize-test-reader",
                "assignment": "RUN_IN",
            },
        )
        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/finalize-race",
                {"raceId": "auto-test", "adminCode": "wrong-code"},
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.FORBIDDEN)

        finalize_payload = self.request_json(
            "/api/finalize-race",
            {"raceId": "auto-test", "adminCode": "test-clear-code-1234"},
        )
        finalized = finalize_payload["race"]
        self.assertEqual(finalized["status"], "finalized")
        self.assertTrue(finalized["finalizedAt"])
        self.assertEqual(finalize_payload["releasedDeviceBindings"], 1)
        self.assertEqual(
            self.request_json("/api/device-bindings?raceId=auto-test")["bindings"],
            [],
        )
        leaderboard = self.request_json("/api/leaderboard?raceId=auto-test")
        self.assertEqual(leaderboard["generatedAt"], finalized["finalizedAt"])

        finalized_again = self.request_json(
            "/api/finalize-race",
            {"raceId": "auto-test", "adminCode": "test-clear-code-1234"},
        )["race"]
        self.assertEqual(finalized_again["finalizedAt"], finalized["finalizedAt"])
        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/timing-events",
                self.timing_payload(1, "RUN_OUT"),
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.CONFLICT)
        self.assert_post_error(
            "/api/update-participant",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "cardCode": "SIM-001-UPDATED",
                "athleteName": "Updated after finish",
                "entryType": "individual",
                "memberNames": ["Updated after finish"],
                "confirmation": "UPDATE_PARTICIPANT",
                "adminCode": "test-clear-code-1234",
            },
            HTTPStatus.CONFLICT,
        )

    def test_reopen_race_requires_reason_confirmation_and_restores_timing(self):
        self.request_json("/api/timing-events", self.timing_payload(0, "RUN_IN"))
        finalized = self.request_json(
            "/api/finalize-race",
            {"raceId": "auto-test", "adminCode": "test-clear-code-1234"},
        )["race"]
        self.assertEqual(finalized["status"], "finalized")

        self.assert_post_error(
            "/api/reopen-race",
            {
                "raceId": "auto-test",
                "confirmation": "SECOND_CONFIRMATION",
                "reason": "Operator selected end by mistake",
                "adminCode": "wrong-code",
            },
            HTTPStatus.FORBIDDEN,
        )
        self.assert_post_error(
            "/api/reopen-race",
            {
                "raceId": "auto-test",
                "reason": "Operator selected end by mistake",
                "adminCode": "test-clear-code-1234",
            },
            HTTPStatus.BAD_REQUEST,
        )
        self.assert_post_error(
            "/api/reopen-race",
            {
                "raceId": "auto-test",
                "confirmation": "SECOND_CONFIRMATION",
                "reason": "x",
                "adminCode": "test-clear-code-1234",
            },
            HTTPStatus.BAD_REQUEST,
        )

        reopened = self.request_json(
            "/api/reopen-race",
            {
                "raceId": "auto-test",
                "confirmation": "SECOND_CONFIRMATION",
                "reason": "Operator selected end by mistake",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertEqual(reopened["race"]["status"], "active")
        self.assertIsNone(reopened["race"]["finalizedAt"])
        resumed = self.request_json(
            "/api/timing-events",
            self.timing_payload(2, "RUN_OUT"),
        )
        self.assertEqual(resumed["status"], "accepted")
        with server.connect_db() as db:
            actions = db.execute(
                "SELECT action, reason FROM race_admin_actions "
                "WHERE race_id = ? ORDER BY id",
                ("auto-test",),
            ).fetchall()
        self.assertEqual([row["action"] for row in actions], ["finalize", "reopen"])
        self.assertEqual(actions[-1]["reason"], "Operator selected end by mistake")

    def test_finalized_race_assigns_finished_dnf_dns_and_freezes_order(self):
        for card_code, athlete_name in (
            ("FIN-001", "Finished Athlete"),
            ("DNS-001", "DNS Athlete"),
        ):
            self.request_json(
                "/api/participants",
                {
                    "raceId": "auto-test",
                    "cardCode": card_code,
                    "athleteName": athlete_name,
                    "entryType": "individual",
                    "memberNames": [athlete_name],
                },
            )

        latest = None
        for index in range(17):
            role, _ = server.expected_auto_transition(latest)
            result = self.request_json(
                "/api/timing-events",
                self.timing_payload_for_card(index, role, "FIN-001", "finished"),
            )
            latest = result["stationId"]

        self.request_json(
            "/api/timing-events",
            self.timing_payload_for_card(30, "RUN_IN", "SIM-001", "dnf"),
        )
        self.request_json(
            "/api/timing-events",
            self.timing_payload_for_card(32, "RUN_OUT", "SIM-001", "dnf"),
        )
        self.request_json(
            "/api/finalize-race",
            {"raceId": "auto-test", "adminCode": "test-clear-code-1234"},
        )

        first = self.request_json("/api/leaderboard?raceId=auto-test")
        second = self.request_json("/api/leaderboard?raceId=auto-test")
        self.assertEqual(
            [row["status"] for row in first["leaderboard"]],
            ["finished", "dnf", "dns"],
        )
        self.assertEqual(
            [row["cardCode"] for row in first["leaderboard"]],
            ["FIN-001", "SIM-001", "DNS-001"],
        )
        dnf_first = first["leaderboard"][1]
        dnf_second = second["leaderboard"][1]
        self.assertEqual(dnf_first["elapsedMs"], dnf_second["elapsedMs"])
        self.assertEqual(dnf_first["latestCheckpoint"], "STATION_1_ENTER")
        self.assertIsNone(first["leaderboard"][2]["elapsedMs"])

    def test_official_templates_reject_operations_and_session_remains_writable(self):
        template_id = "fitmonster-hyrox-single"
        template = self.request_json(
            f"/api/race-config?raceId={template_id}"
        )["race"]
        self.assertTrue(template["isTemplate"])

        operations = [
            (
                "/api/participants",
                {
                    "raceId": template_id,
                    "cardCode": "LOCKED-001",
                    "athleteName": "Locked Athlete",
                    "entryType": "individual",
                    "memberNames": ["Locked Athlete"],
                },
            ),
            (
                "/api/device-bindings",
                {"raceId": template_id, "deviceId": "locked-device", "assignment": "RUN_IN"},
            ),
            (
                "/api/timing-events",
                {
                    **self.timing_payload_for_card(0, "RUN_IN", "LOCKED-001", "locked"),
                    "raceId": template_id,
                },
            ),
            (
                "/api/result-adjustments",
                {
                    "raceId": template_id,
                    "participantId": 1,
                    "adjustmentSeconds": 10,
                    "reason": "Template must remain clean",
                    "adminCode": "test-clear-code-1234",
                },
            ),
            (
                "/api/reset-race",
                {
                    "raceId": template_id,
                    "confirmation": "SECOND_CONFIRMATION",
                    "adminCode": "test-clear-code-1234",
                },
            ),
            (
                "/api/delete-participant",
                {
                    "raceId": template_id,
                    "cardCode": "LOCKED-001",
                    "confirmation": "DELETE_PARTICIPANT",
                    "adminCode": "test-clear-code-1234",
                },
            ),
            (
                "/api/update-participant",
                {
                    "raceId": template_id,
                    "participantId": 1,
                    "cardCode": "LOCKED-002",
                    "athleteName": "Changed template participant",
                    "entryType": "individual",
                    "memberNames": ["Changed template participant"],
                    "confirmation": "UPDATE_PARTICIPANT",
                    "adminCode": "test-clear-code-1234",
                },
            ),
            (
                "/api/finalize-race",
                {"raceId": template_id, "adminCode": "test-clear-code-1234"},
            ),
            (
                "/api/reopen-race",
                {
                    "raceId": template_id,
                    "confirmation": "SECOND_CONFIRMATION",
                    "reason": "Template must remain clean",
                    "adminCode": "test-clear-code-1234",
                },
            ),
            (
                "/api/race-config",
                {
                    "raceId": template_id,
                    "name": "Changed template",
                    "mode": "three_reader_auto",
                    "stationCount": 8,
                },
            ),
        ]
        for path, payload in operations:
            with self.subTest(path=path):
                self.assert_post_error(path, payload, HTTPStatus.CONFLICT)

        session_id = "fitmonster-hyrox-single-20260726-0900"
        session = self.request_json(
            "/api/race-config",
            {
                "raceId": session_id,
                "name": "FitMonster 2026-07-26 09:00",
                "mode": "three_reader_auto",
                "entryType": "individual",
                "stationCount": 8,
            },
        )["race"]
        self.assertFalse(session["isTemplate"])
        participant = self.request_json(
            "/api/participants",
            {
                "raceId": session_id,
                "cardCode": "SESSION-001",
                "athleteName": "Session Athlete",
                "entryType": "individual",
                "memberNames": ["Session Athlete"],
            },
        )["participant"]
        self.assertEqual(participant["card_code"], "SESSION-001")

    def test_result_adjustments_preserve_raw_time_and_record_reasons(self):
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

        participant_id = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"][0]["id"]
        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/result-adjustments",
                {
                    "raceId": "auto-test",
                    "participantId": participant_id,
                    "adjustmentSeconds": 60,
                    "reason": "Missed movement standard",
                    "adminCode": "wrong-code",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.FORBIDDEN)

        penalty = self.request_json(
            "/api/result-adjustments",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "adjustmentSeconds": 60,
                "reason": "Missed movement standard",
                "adminCode": "test-clear-code-1234",
            },
        )
        credit = self.request_json(
            "/api/result-adjustments",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "adjustmentSeconds": -15,
                "reason": "Timing review correction",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertEqual(penalty["totalAdjustmentMs"], 60000)
        self.assertEqual(credit["totalAdjustmentMs"], 45000)

        result = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"][0]
        self.assertEqual(result["rawElapsedMs"], 160000)
        self.assertEqual(result["adjustmentMs"], 45000)
        self.assertEqual(result["elapsedMs"], 205000)
        self.assertEqual(
            [item["adjustmentMs"] for item in result["adjustments"]],
            [60000, -15000],
        )
        self.assertEqual(
            [item["reason"] for item in result["adjustments"]],
            ["Missed movement standard", "Timing review correction"],
        )

        self.request_json(
            "/api/finalize-race",
            {"raceId": "auto-test", "adminCode": "test-clear-code-1234"},
        )
        post_race = self.request_json(
            "/api/result-adjustments",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "adjustmentSeconds": 5,
                "reason": "Post-race video review",
                "adminCode": "test-clear-code-1234",
            },
        )
        refreshed = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"][0]
        self.assertEqual(post_race["totalAdjustmentMs"], 50000)
        self.assertEqual(refreshed["adjustmentMs"], 50000)
        self.assertEqual(refreshed["elapsedMs"], 210000)

    def test_manual_results_override_final_time_without_changing_raw_events(self):
        participant_id = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"][0]["id"]
        total_result = self.request_json(
            "/api/manual-results",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "entryMode": "elapsed",
                "elapsedSeconds": 600,
                "reason": "Backup timer result",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertEqual(total_result["manualResult"]["elapsedMs"], 600000)

        result = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"][0]
        self.assertEqual(result["status"], "finished")
        self.assertIsNone(result["rawElapsedMs"])
        self.assertEqual(result["elapsedMs"], 600000)
        self.assertEqual(result["manualResult"]["entryMode"], "elapsed")

        start = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)
        finish = start + timedelta(minutes=12, seconds=5)
        self.request_json(
            "/api/manual-results",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "entryMode": "start_finish",
                "startTime": start.isoformat().replace("+00:00", "Z"),
                "finishTime": finish.isoformat().replace("+00:00", "Z"),
                "reason": "Corrected start and finish log",
                "adminCode": "test-clear-code-1234",
            },
        )
        result = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"][0]
        self.assertEqual(result["elapsedMs"], 725000)
        self.assertEqual(result["startTime"], start.isoformat().replace("+00:00", "Z"))
        self.assertEqual(len(result["manualResults"]), 2)

    def test_pause_resume_and_dnf_freeze_timing_and_block_taps(self):
        participant_id = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"][0]["id"]
        start_payload = self.timing_payload(0, "RUN_IN")
        start_payload["eventTime"] = (
            datetime.now(timezone.utc) - timedelta(minutes=1)
        ).isoformat().replace("+00:00", "Z")
        self.assertEqual(
            self.request_json("/api/timing-events", start_payload)["status"],
            "accepted",
        )

        self.request_json(
            "/api/participant-timing-controls",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "action": "pause",
                "reason": "Timing review",
                "adminCode": "test-clear-code-1234",
            },
        )
        paused = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"][0]
        self.assertEqual(paused["status"], "paused")
        self.assertFalse(paused["timerRunning"])

        blocked_payload = self.timing_payload(20, "RUN_OUT")
        blocked_payload["eventId"] = "paused-tap"
        blocked_payload["eventTime"] = datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        self.assertEqual(
            self.request_json("/api/timing-events", blocked_payload)["status"],
            "participant_paused",
        )

        self.request_json(
            "/api/participant-timing-controls",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "action": "resume",
                "reason": "Review complete",
                "adminCode": "test-clear-code-1234",
            },
        )
        resumed_payload = dict(blocked_payload)
        resumed_payload["eventId"] = "resumed-tap"
        self.assertEqual(
            self.request_json("/api/timing-events", resumed_payload)["status"],
            "accepted",
        )

        self.request_json(
            "/api/participant-timing-controls",
            {
                "raceId": "auto-test",
                "participantId": participant_id,
                "action": "dnf",
                "reason": "Athlete withdrew",
                "adminCode": "test-clear-code-1234",
            },
        )
        dnf = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"][0]
        self.assertEqual(dnf["status"], "dnf")
        self.assertEqual(dnf["current"], "DNF")
        self.assertFalse(dnf["timerRunning"])

        dnf_payload = self.timing_payload(30, "RUN_IN")
        dnf_payload["eventId"] = "dnf-tap"
        dnf_payload["eventTime"] = datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        self.assertEqual(
            self.request_json("/api/timing-events", dnf_payload)["status"],
            "participant_dnf",
        )

    def test_delete_participant_requires_code_and_only_deletes_selected_card(self):
        event = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_IN"),
        )
        self.assertEqual(event["status"], "accepted")
        other = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "KEEP-001",
                "athleteName": "Keep Athlete",
                "entryType": "individual",
                "memberNames": ["Keep Athlete"],
            },
        )["participant"]

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/delete-participant",
                {
                    "raceId": "auto-test",
                    "cardCode": "SIM-001",
                    "adminCode": "test-clear-code-1234",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.BAD_REQUEST)

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/delete-participant",
                {
                    "raceId": "auto-test",
                    "cardCode": "SIM-001",
                    "confirmation": "DELETE_PARTICIPANT",
                    "adminCode": "wrong-code",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.FORBIDDEN)

        result = self.request_json(
            "/api/delete-participant",
            {
                "raceId": "auto-test",
                "cardCode": "sim-001",
                "confirmation": "DELETE_PARTICIPANT",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertEqual(
            result["deleted"],
            {
                "timingEvents": 1,
                "participants": 1,
                "resultAdjustments": 0,
                "manualResults": 0,
                "timingControls": 0,
            },
        )
        participants = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"]
        self.assertEqual([row["card_code"] for row in participants], [other["card_code"]])
        self.assertEqual(
            self.request_json("/api/race-config?raceId=auto-test")["race"]["raceId"],
            "auto-test",
        )

    def test_admin_can_update_team_card_and_name_without_losing_timing(self):
        team = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "TEAM-EDIT-OLD",
                "athleteName": "Original Team",
                "entryType": "team",
                "memberNames": ["Runner 1", "Runner 2", "Runner 3", "Runner 4"],
                "checkInStatus": "checked_in",
            },
        )["participant"]
        self.assert_post_error(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "TEAM-EDIT-OLD",
                "athleteName": "Unauthorized Rename",
                "entryType": "team",
                "memberNames": ["Wrong 1", "Wrong 2", "Wrong 3", "Wrong 4"],
                "checkInStatus": "checked_in",
            },
            HTTPStatus.CONFLICT,
        )
        original = next(
            row
            for row in self.request_json(
                "/api/participants?raceId=auto-test"
            )["participants"]
            if row["id"] == team["id"]
        )
        self.assertEqual(original["athlete_name"], "Original Team")
        first_event = self.request_json(
            "/api/timing-events",
            self.timing_payload_for_card(0, "RUN_IN", "TEAM-EDIT-OLD", "team-edit"),
        )
        self.assertEqual(first_event["status"], "accepted")

        update_payload = {
            "raceId": "auto-test",
            "participantId": team["id"],
            "cardCode": "TEAM-EDIT-NEW",
            "athleteName": "Updated Team Name",
            "entryType": "team",
            "memberNames": ["Alice", "Bob", "Chris", "Dana"],
            "checkInStatus": "checked_in",
            "confirmation": "UPDATE_PARTICIPANT",
            "adminCode": "test-clear-code-1234",
        }
        missing_confirmation = {**update_payload}
        missing_confirmation.pop("confirmation")
        self.assert_post_error(
            "/api/update-participant",
            missing_confirmation,
            HTTPStatus.BAD_REQUEST,
        )
        self.assert_post_error(
            "/api/update-participant",
            {**update_payload, "adminCode": "wrong-code"},
            HTTPStatus.FORBIDDEN,
        )

        updated = self.request_json(
            "/api/update-participant",
            update_payload,
        )["participant"]
        self.assertEqual(updated["id"], team["id"])
        self.assertEqual(updated["card_code"], "TEAM-EDIT-NEW")
        self.assertEqual(updated["athlete_name"], "Updated Team Name")
        self.assertEqual(updated["member_names"], ["Alice", "Bob", "Chris", "Dana"])

        second_event = self.request_json(
            "/api/timing-events",
            self.timing_payload_for_card(2, "RUN_OUT", "TEAM-EDIT-NEW", "team-edit"),
        )
        self.assertEqual(second_event["status"], "accepted")
        self.assertEqual(second_event["stationId"], "STATION_1_ENTER")

        leaderboard = self.request_json(
            "/api/leaderboard?raceId=auto-test"
        )["leaderboard"]
        result = next(row for row in leaderboard if row["participantId"] == team["id"])
        self.assertEqual(result["athleteName"], "Updated Team Name")
        self.assertEqual(result["cardCode"], "TEAM-EDIT-NEW")
        self.assertEqual(result["latestCheckpoint"], "STATION_1_ENTER")

        self.assert_post_error(
            "/api/update-participant",
            {**update_payload, "cardCode": "SIM-001"},
            HTTPStatus.CONFLICT,
        )
        participants = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"]
        refreshed = next(row for row in participants if row["id"] == team["id"])
        self.assertEqual(refreshed["card_code"], "TEAM-EDIT-NEW")

        deleted = self.request_json(
            "/api/delete-participant",
            {
                "raceId": "auto-test",
                "cardCode": "TEAM-EDIT-NEW",
                "confirmation": "DELETE_PARTICIPANT",
                "adminCode": "test-clear-code-1234",
            },
        )["deleted"]
        self.assertEqual(
            deleted,
            {
                "timingEvents": 2,
                "participants": 1,
                "resultAdjustments": 0,
                "manualResults": 0,
                "timingControls": 0,
            },
        )

    def test_device_binding_requires_explicit_confirmation_and_reserves_assignment(self):
        self.assertEqual(
            self.request_json("/api/device-bindings?raceId=auto-test")["bindings"],
            [],
        )
        binding = self.request_json(
            "/api/device-bindings",
            {
                "raceId": "auto-test",
                "deviceId": "reader-out-01",
                "assignment": "RUN_OUT",
            },
        )["binding"]
        self.assertEqual(binding["assignment"], "RUN_OUT")

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/device-bindings",
                {
                    "raceId": "auto-test",
                    "deviceId": "reader-out-02",
                    "assignment": "RUN_OUT",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.CONFLICT)

        unchanged = self.request_json(
            "/api/device-bindings",
            {
                "raceId": "auto-test",
                "deviceId": "reader-out-01",
                "assignment": "RUN_OUT",
            },
        )["binding"]
        self.assertEqual(unchanged["assignment"], "RUN_OUT")

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/device-bindings",
                {
                    "raceId": "auto-test",
                    "deviceId": "reader-out-01",
                    "assignment": "RUN_IN",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.CONFLICT)

        with self.assertRaises(HTTPError) as error_context:
            self.request_json(
                "/api/device-bindings/unbind",
                {
                    "raceId": "auto-test",
                    "deviceId": "reader-out-01",
                    "adminCode": "wrong-code",
                },
            )
        self.assertEqual(error_context.exception.code, HTTPStatus.FORBIDDEN)

        removed = self.request_json(
            "/api/device-bindings/unbind",
            {
                "raceId": "auto-test",
                "deviceId": "reader-out-01",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertEqual(removed["removed"], 1)
        rebound = self.request_json(
            "/api/device-bindings",
            {
                "raceId": "auto-test",
                "deviceId": "reader-out-02",
                "assignment": "RUN_OUT",
            },
        )["binding"]
        self.assertEqual(rebound["assignment"], "RUN_OUT")

    def test_wrong_gate_is_stored_without_advancing_progress(self):
        start = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_IN"),
        )
        self.assertEqual(start["stationId"], "START")

        wrong_gate = self.request_json(
            "/api/timing-events",
            self.timing_payload(2, "RUN_IN"),
        )
        self.assertEqual(wrong_gate["status"], "wrong_gate")
        self.assertEqual(wrong_gate["expectedRole"], "RUN_OUT")

        run_out = self.request_json(
            "/api/timing-events",
            self.timing_payload(3, "RUN_OUT"),
        )
        self.assertEqual(run_out["status"], "accepted")
        self.assertEqual(run_out["stationId"], "STATION_1_ENTER")

    def test_duplicate_tap_within_ten_seconds_keeps_checkpoint(self):
        start = self.request_json(
            "/api/timing-events",
            self.timing_payload(0, "RUN_IN"),
        )
        self.assertEqual(start["status"], "accepted")
        self.assertEqual(start["stationId"], "START")

        duplicate = self.request_json(
            "/api/timing-events",
            self.timing_payload(1, "RUN_IN"),
        )
        self.assertEqual(duplicate["status"], "duplicate_tap")
        self.assertEqual(duplicate["stationId"], "START")
        self.assertEqual(duplicate["duplicateWindowSeconds"], 10)

        run_out = self.request_json(
            "/api/timing-events",
            self.timing_payload(2, "RUN_OUT"),
        )
        self.assertEqual(run_out["status"], "accepted")
        self.assertEqual(run_out["stationId"], "STATION_1_ENTER")

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

    def test_judge_manual_checkpoint_is_accepted_and_enters_leaderboard(self):
        self.request_json("/api/timing-events", self.timing_payload(0, "RUN_IN"))
        checkpoint_time = datetime(2026, 1, 1, 0, 0, 20, tzinfo=timezone.utc)
        response = self.request_json(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_1_ENTER",
                "eventTime": checkpoint_time.isoformat().replace("+00:00", "Z"),
                "reason": "站点 NFC 打卡失败，现场人工核对",
                "deviceId": "judge-test-01",
                "adminCode": "test-clear-code-1234",
            },
        )
        self.assertEqual(response["status"], "accepted")
        self.assertEqual(response["stationId"], "STATION_1_ENTER")
        self.assertEqual(response["eventTime"], "2026-01-01T00:00:20.000Z")
        self.assertEqual(response["event"]["source"], "judge-manual-checkpoint")

        result = self.request_json("/api/leaderboard?raceId=auto-test")["leaderboard"][0]
        self.assertEqual(result["checkpointTimes"]["STATION_1_ENTER"], "2026-01-01T00:00:20.000Z")
        self.assertEqual(result["latestCheckpoint"], "STATION_1_ENTER")

        self.assert_post_error(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_1_ENTER",
                "eventTime": "2026-01-01T00:00:21Z",
                "reason": "重复人工确认",
                "adminCode": "test-clear-code-1234",
            },
            HTTPStatus.CONFLICT,
        )

    def test_judge_manual_checkpoint_rejects_unstarted_invalid_station_and_bad_code(self):
        self.assert_post_error(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_1_ENTER",
                "eventTime": "2026-01-01T00:00:10Z",
                "reason": "x" * 501,
                "adminCode": "test-clear-code-1234",
            },
            HTTPStatus.BAD_REQUEST,
        )
        self.assert_post_error(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_1_ENTER",
                "eventTime": "2026-01-01T00:00:10Z",
                "reason": "现场核对",
                "adminCode": "test-clear-code-1234",
            },
            HTTPStatus.CONFLICT,
        )
        self.assert_post_error(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "NOT_A_CHECKPOINT",
                "eventTime": "2026-01-01T00:00:10Z",
                "reason": "现场核对",
                "adminCode": "test-clear-code-1234",
            },
            HTTPStatus.BAD_REQUEST,
        )
        self.assert_post_error(
            "/api/manual-checkpoints",
            {
                "raceId": "auto-test",
                "participantId": 1,
                "stationId": "STATION_1_ENTER",
                "eventTime": "2026-01-01T00:00:10Z",
                "reason": "现场核对",
                "adminCode": "wrong-code",
            },
            HTTPStatus.FORBIDDEN,
        )

    def test_manual_checkpoint_only_accepts_the_next_race_checkpoint(self):
        self.request_json(
            "/api/race-config",
            {
                "raceId": "auto-test",
                "name": "Sequential Checkpoint Test",
                "mode": "station_checkpoints",
                "stationCount": 5,
                "checkpointLayout": "station_starts",
                "entryType": "team",
            },
        )
        base_payload = {
            "raceId": "auto-test",
            "participantId": 1,
            "reason": "现场人工确认",
            "adminCode": "test-clear-code-1234",
        }

        before_start = self.assert_post_error(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "STATION_1_START",
                "eventTime": "2026-01-01T00:00:10Z",
            },
            HTTPStatus.CONFLICT,
        )
        self.assertEqual(before_start["status"], "wrong_checkpoint")
        self.assertIsNone(before_start["latestCheckpoint"])
        self.assertEqual(before_start["expectedCheckpoint"], "START")

        self.request_json(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "START",
                "eventTime": "2026-01-01T00:00:10Z",
            },
        )
        skipped_station = self.assert_post_error(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "STATION_2_START",
                "eventTime": "2026-01-01T00:00:30Z",
            },
            HTTPStatus.CONFLICT,
        )
        self.assertEqual(skipped_station["latestCheckpoint"], "START")
        self.assertEqual(skipped_station["expectedCheckpoint"], "STATION_1_START")

        self.request_json(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "STATION_1_START",
                "eventTime": "2026-01-01T00:00:20Z",
            },
        )
        previous_station = self.assert_post_error(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "START",
                "eventTime": "2026-01-01T00:00:25Z",
            },
            HTTPStatus.CONFLICT,
        )
        self.assertEqual(previous_station["latestCheckpoint"], "STATION_1_START")
        self.assertEqual(previous_station["expectedCheckpoint"], "STATION_2_START")

        accepted = self.request_json(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "STATION_2_START",
                "eventTime": "2026-01-01T00:00:30Z",
            },
        )
        self.assertEqual(accepted["stationId"], "STATION_2_START")

        for station_number, second in ((3, 40), (4, 50)):
            self.request_json(
                "/api/manual-checkpoints",
                {
                    **base_payload,
                    "stationId": f"STATION_{station_number}_START",
                    "eventTime": f"2026-01-01T00:00:{second:02d}Z",
                },
            )

        finish = self.request_json(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "STATION_5_START",
                "eventTime": "2026-01-01T00:01:00Z",
            },
        )
        self.assertEqual(finish["stationIds"], ["STATION_5_START", "END"])
        self.assertEqual(
            [event["station_id"] for event in finish["events"]],
            ["STATION_5_START", "END"],
        )
        self.assertEqual(
            {event["event_time"] for event in finish["events"]},
            {"2026-01-01T00:01:00.000Z"},
        )

        result = self.request_json("/api/leaderboard?raceId=auto-test")["leaderboard"][0]
        self.assertEqual(result["status"], "finished")
        self.assertEqual(result["latestCheckpoint"], "END")
        self.assertEqual(
            result["checkpointTimes"]["STATION_5_START"],
            result["checkpointTimes"]["END"],
        )
        already_finished = self.assert_post_error(
            "/api/manual-checkpoints",
            {
                **base_payload,
                "stationId": "END",
                "eventTime": "2026-01-01T00:01:01Z",
            },
            HTTPStatus.CONFLICT,
        )
        self.assertIsNone(already_finished["expectedCheckpoint"])

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

        no_bib = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "NO-BIB-001",
                "athleteName": "No Bib Athlete",
                "entryType": "individual",
                "memberNames": ["No Bib Athlete"],
                "checkInStatus": "checked_in",
            },
        )["participant"]
        self.assertIsNone(no_bib["bib_number"])

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
            self.timing_payload(0, "RUN_IN"),
        )
        self.assertEqual(start["stationId"], "START")

        station = self.request_json(
            "/api/timing-events",
            self.timing_payload(2, "RUN_OUT"),
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


class DefaultRaceProfileTests(unittest.TestCase):
    def test_defaults_are_limited_to_public_series_and_test_data(self):
        with tempfile.TemporaryDirectory() as tempdir:
            original_db_path = server.DB_PATH
            server.DB_PATH = Path(tempdir) / "timing.sqlite3"
            try:
                server.init_db()
                with server.connect_db() as db:
                    race_ids = {
                        row["race_id"]
                        for row in db.execute("SELECT race_id FROM race_profiles")
                    }
                    test_profile = server.race_profile_from_row(
                        db.execute(
                            "SELECT * FROM race_profiles WHERE race_id = ?",
                            ("nfc-test-001",),
                        ).fetchone()
                    )
            finally:
                server.DB_PATH = original_db_path

        self.assertEqual(
            race_ids,
            {
                "hoka-race-sh",
                "hoka-race-hz",
                "hoka-race-final",
                "nfc-test-001",
            },
        )
        self.assertEqual(test_profile["name"], "HOKA 团队挑战赛 - 测试数据")
        self.assertEqual(test_profile["mode"], "station_checkpoints")
        self.assertEqual(test_profile["station_count"], 5)
        self.assertEqual(test_profile["entry_type"], "team")
        self.assertEqual(test_profile["checkpoints"], server.build_station_checkpoints(5))


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
        hoka_sh = self.request_json("/api/race-config?raceId=hoka-race-sh")["race"]
        self.assertEqual(hoka_sh["checkpointLayout"], "station_starts")
        self.assertEqual(
            hoka_sh["checkpoints"],
            ["START", "STATION_1_START", "STATION_2_START", "STATION_3_START",
             "STATION_4_START", "STATION_5_START", "END"],
        )

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

    def test_start_queue_does_not_expose_legacy_orders_or_waves(self):
        race = self.request_json(
            "/api/race-config",
            {
                "raceId": "auto-test",
                "name": "Grouped Start Test",
                "mode": "station_checkpoints",
                "stationCount": 3,
                "startGroupSize": 2,
                "checkpointLayout": "station_starts",
                "entryType": "individual",
            },
        )["race"]
        self.assertEqual(race["startGroupSize"], 2)

        automatic = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "SIM-002",
                "athleteName": "Second Athlete",
                "entryType": "individual",
            },
        )["participant"]
        manual = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "SIM-005",
                "athleteName": "Fifth Athlete",
                "entryType": "individual",
                "startOrder": 5,
            },
        )["participant"]
        self.assertEqual(automatic["start_order"], 2)
        self.assertEqual(manual["start_order"], 5)

        queue = self.request_json("/api/start-queue?raceId=auto-test")
        entries = {entry["cardCode"]: entry for entry in queue["entries"]}
        self.assertNotIn("startGroupSize", queue["summary"])
        self.assertNotIn("startOrder", entries["SIM-001"])
        self.assertNotIn("startWave", entries["SIM-001"])
        self.assertNotIn("startWave", entries["SIM-002"])
        self.assertNotIn("startWave", entries["SIM-005"])

    def test_judge_start_accepts_ready_participants_across_legacy_waves(self):
        self.request_json(
            "/api/race-config",
            {
                "raceId": "auto-test",
                "name": "Judge Start Test",
                "mode": "station_checkpoints",
                "stationCount": 2,
                "startGroupSize": 2,
                "checkpointLayout": "station_starts",
                "entryType": "individual",
            },
        )
        second = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "SIM-002",
                "athleteName": "Second Athlete",
                "entryType": "individual",
            },
        )["participant"]
        third = self.request_json(
            "/api/participants",
            {
                "raceId": "auto-test",
                "cardCode": "SIM-003",
                "athleteName": "Third Athlete",
                "entryType": "individual",
            },
        )["participant"]
        participants = self.request_json(
            "/api/participants?raceId=auto-test"
        )["participants"]
        first = next(row for row in participants if row["card_code"] == "SIM-001")

        for card_code in ("SIM-001", "SIM-002", "SIM-003"):
            checkin = self.request_json(
                "/api/start-checkins",
                {
                    "raceId": "auto-test",
                    "cardCode": card_code,
                    "deviceId": "start-phone-01",
                },
            )
            self.assertEqual(checkin["status"], "start_ready")

        base_payload = {
            "raceId": "auto-test",
            "deviceId": "judge-console-test",
            "adminCode": "test-clear-code-1234",
            "startedAt": "2026-08-10T07:30:45.123Z",
        }
        started = self.request_json(
            "/api/start-race",
            {
                **base_payload,
                "participantIds": [first["id"], second["id"], third["id"]],
            },
        )
        self.assertNotIn("startWave", started)
        self.assertEqual(started["startedAt"], base_payload["startedAt"])
        self.assertEqual(started["startedCount"], 3)
        self.assertEqual(len(started["participants"]), 3)
        self.assertEqual(
            {participant["startedAt"] for participant in started["participants"]},
            {base_payload["startedAt"]},
        )

        queue = self.request_json("/api/start-queue?raceId=auto-test")
        statuses = {
            entry["cardCode"]: entry["status"] for entry in queue["entries"]
        }
        recorded_start_times = {
            entry["startedAt"] for entry in queue["entries"]
            if entry["cardCode"] in {"SIM-001", "SIM-002", "SIM-003"}
        }
        self.assertEqual(statuses["SIM-001"], "started")
        self.assertEqual(statuses["SIM-002"], "started")
        self.assertEqual(statuses["SIM-003"], "started")
        self.assertEqual(recorded_start_times, {base_payload["startedAt"]})


if __name__ == "__main__":
    unittest.main()
