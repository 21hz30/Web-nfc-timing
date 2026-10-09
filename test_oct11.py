"""Race-day contracts for the no-running October 11 course."""
import concurrent.futures
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
import unittest

import oct11_rules
import server
import test_server


class Oct11Tests(unittest.TestCase):
    setUp = test_server.TimingApiTests.setUp
    tearDown = test_server.TimingApiTests.tearDown
    request_json = test_server.TimingApiTests.request_json
    assert_post_error = test_server.TimingApiTests.assert_post_error
    start = datetime(2026, 10, 11, 6, tzinfo=timezone.utc)

    def register(self, code="G", number=1, **extra):
        label, entry_type, size, _ = server.nanxi_rules.CATEGORIES[code]
        bib = f"{code}-{number:03d}"
        payload = {"raceId": oct11_rules.RACE_ID, "categoryCode": code, "bibNumber": bib,
                   "cardCode": "BAND-" + bib, "athleteName": label + str(number),
                   "entryType": entry_type, "memberNames": [f"成员{i+1}" for i in range(size)],
                   "memberBibNumbers": [f"{bib}-{i+1}" for i in range(size)]}
        if code == "G":
            payload["startBatch"] = (number - 1) // 4 + 1
        return self.request_json("/api/participants", {**payload, **extra})["participant"]

    def gun_start(self, entries):
        for entry in entries:
            self.request_json("/api/start-checkins", {"raceId": oct11_rules.RACE_ID,
                              "cardCode": entry["card_code"], "deviceId": "start-reader"})
        return self.request_json("/api/start-race", {"raceId": oct11_rules.RACE_ID,
                                 "participantIds": [entry["id"] for entry in entries],
                                 "startedAt": self.start.isoformat(), "adminCode": "test-clear-code-1234"})

    def touch(self, entry, index, manual=False, seconds=None, **extra):
        payload = {"raceId": oct11_rules.RACE_ID, "stationId": server.build_station_boundary_checkpoints(8)[index],
                   "deviceId": "test-reader", "timingMode": "manual",
                   "eventTime": (self.start + timedelta(seconds=seconds if seconds is not None else index * 60)).isoformat()}
        if manual:
            return self.request_json("/api/manual-checkpoints", {**payload, "participantId": entry["id"],
                                     "adminCode": "test-clear-code-1234", **extra})
        return self.request_json("/api/timing-events", {**payload, "cardCode": entry["card_code"],
                                 "eventId": f"oct11-{entry['id']}-{index}-{seconds}-{extra}", **extra})

    def results(self):
        return self.request_json("/api/leaderboard?raceId=" + oct11_rules.RACE_ID)["leaderboard"]

    def test_course_schedule_and_previous_races(self):
        race = self.request_json("/api/race-config?raceId=" + oct11_rules.RACE_ID)["race"]
        self.assertEqual(race["stationCount"], 8)
        self.assertEqual(len(race["checkpoints"]), 9)
        self.assertEqual(race["checkpoints"][-1], "END")
        self.assertEqual(race["stationNames"], oct11_rules.STATIONS)
        self.assertFalse(race["hasRunning"])
        self.assertEqual([r["code"] for r in race["categories"]], list("GABEDC"))
        self.assertEqual(sum(race["plannedEntryCounts"].values()), 84)
        self.assertEqual(sum(r["people"] for r in race["sessions"]), 168)
        self.assertEqual(race["sessions"][0]["waves"], 4)
        for race_id in server.NANXI_RACE_IDS:
            self.assertEqual(server.get_race_profile(race_id)["station_count"], 7)
        self.assertEqual(server.get_race_profile("hoka-race-sh")["station_count"], 5)
        self.assert_post_error("/api/race-config", {"raceId": oct11_rules.RACE_ID, "stationCount": 7,
                               "adminCode": "test-clear-code-1234"}, 400)

    def test_six_divisions_and_no_nanxi_legacy_bib_exception(self):
        for code in oct11_rules.CODES:
            entry = self.register(code)
            self.assertEqual(entry["category_code"], code)
        entry = self.register("C", 15)
        self.assertEqual(entry["entry_type"], "doubles")
        self.assertEqual(entry["category_code"], "C")
        self.assert_post_error("/api/participants", {"raceId": oct11_rules.RACE_ID, "categoryCode": "F",
                               "bibNumber": "F-001", "cardCode": "WRONG", "athleteName": "错误",
                               "entryType": "doubles", "memberNames": ["一", "二"]}, 400)

    def test_nfc_and_manual_start_checkins_only_make_ready_until_gun(self):
        a, b = self.register("A", 1), self.register("A", 2)
        self.request_json("/api/start-checkins", {"raceId": oct11_rules.RACE_ID,
                          "cardCode": a["card_code"], "deviceId": "start-reader"})
        self.request_json("/api/start-checkins", {"raceId": oct11_rules.RACE_ID,
                          "participantId": b["id"], "cardCode": b["card_code"], "deviceId": "start-judge", "source": "judge-manual-checkin",
                          "adminCode": "test-clear-code-1234"})
        for row in self.results():
            self.assertIsNone(row["startTime"])
            self.assertEqual(row["status"], "not_started")
        queue = self.request_json("/api/start-queue?raceId=" + oct11_rules.RACE_ID)
        self.assertEqual(queue["summary"]["ready"], 2)
        self.assert_post_error("/api/timing-events", {"raceId": oct11_rules.RACE_ID, "cardCode": a["card_code"],
                               "eventId": "wrong-start", "deviceId": "start-reader", "stationId": "START",
                               "timingMode": "manual", "eventTime": self.start.isoformat()}, 400)
        self.assert_post_error("/api/manual-checkpoints", {"raceId": oct11_rules.RACE_ID, "participantId": a["id"],
                               "stationId": "START", "eventTime": self.start.isoformat(), "adminCode": "test-clear-code-1234"}, 400)
        self.gun_start([a, b])
        rows = self.results()
        self.assertEqual({row["status"] for row in rows}, {"racing"})
        self.assertEqual(len({row["startTime"] for row in rows}), 1)

    def test_eight_finishes_mixed_inputs_concurrency_no_skips_no_early_finish(self):
        entry = self.register("G", femaleCount=4)
        self.gun_start([entry])
        def confirm(manual):
            try:
                return self.touch(entry, 1, manual)["status"]
            except HTTPError as error:
                return error.code
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            statuses = list(pool.map(confirm, [True, False]))
        self.assertEqual(statuses.count("accepted"), 1)
        self.assertEqual(self.touch(entry, 3)["status"], "wrong_checkpoint")
        self.assertEqual(self.touch(entry, 2, seconds=10)["status"], "invalid_progress")
        for index in range(2, 8):
            self.assertEqual(self.touch(entry, index, manual=index % 2 == 1)["status"], "accepted")
        self.assertEqual(self.results()[0]["status"], "racing")
        self.assertEqual(self.touch(entry, 8, manual=True)["status"], "accepted")
        result = self.results()[0]
        self.assertEqual(result["status"], "finished")
        self.assertEqual(result["elapsedMs"], 480000)
        self.assertEqual(result["deductionMs"], 0)
        self.assertEqual(len(result["stationSplits"]), 8)
        self.assertEqual(set(result["stationSplits"].values()), {60000})
        self.assertFalse(any(segment["type"] == "run" for segment in result["segmentSplits"]))
        self.assertNotEqual(self.touch(entry, 8, seconds=481)["status"], "accepted")

    def test_shared_team_bands_and_category_ranks(self):
        entries = [self.register("G", 1, femaleCount=4), self.register("G", 2), self.register("A", 1)]
        self.gun_start(entries)
        for entry in entries:
            for index in range(1, 9):
                self.assertEqual(self.touch(entry, index, serialNumber=f"member-{index%4}")["status"], "accepted")
        rows = {row["bibNumber"]: row for row in self.results()}
        self.assertEqual([rows[bib]["categoryRank"] for bib in ["G-001", "G-002", "A-001"]], [1, 1, 1])
        self.assertEqual(rows["G-001"]["memberBibNumbers"], entries[0]["member_bib_numbers"])
        self.assertEqual(rows["G-001"]["startBatch"], 1)
        self.assertEqual(rows["G-001"]["elapsedMs"], rows["G-002"]["elapsedMs"])

    def test_station_roles_and_shared_wall_ball_readers(self):
        for number in range(9):
            auth = self.request_json("/api/judge-auth", {"raceId": oct11_rules.RACE_ID,
                                     "username": f"station_{number}", "password": f"station{number}"})
            self.assertEqual(auth["role"], "start" if number == 0 else f"station_{number}")
            expected = "START" if number == 0 else "END" if number == 8 else f"STATION_{number+1}_START"
            self.assertEqual(auth["allowedCheckpoints"], [expected])
        for reader in ["finish-1", "finish-2"]:
            result = self.request_json("/api/device-bindings", {"raceId": oct11_rules.RACE_ID,
                                       "deviceId": reader, "assignment": "END"})
            self.assertTrue(result["ok"])
        entry = self.register("A")
        self.gun_start([entry])
        station_one = self.request_json("/api/judge-auth", {
            "raceId": oct11_rules.RACE_ID,
            "username": "station_1",
            "password": "station1",
        })
        accepted = self.request_json("/api/manual-checkpoints", {
            "raceId": oct11_rules.RACE_ID,
            "participantId": entry["id"],
            "stationId": "STATION_2_START",
            "eventTime": (self.start + timedelta(minutes=1)).isoformat(),
            "deviceId": "judge-console-station-1",
            "judgeToken": station_one["judgeToken"],
        })
        self.assertEqual(accepted["status"], "accepted")
        wrong_judge = self.request_json("/api/judge-auth", {"raceId": oct11_rules.RACE_ID,
                                      "username": "station_2", "password": "station2"})
        self.assert_post_error("/api/manual-checkpoints", {"raceId": oct11_rules.RACE_ID,
                               "participantId": entry["id"], "stationId": "STATION_2_START",
                               "eventTime": (self.start + timedelta(minutes=1)).isoformat(),
                               "judgeToken": wrong_judge["judgeToken"]}, 403)


if __name__ == "__main__":
    unittest.main()
