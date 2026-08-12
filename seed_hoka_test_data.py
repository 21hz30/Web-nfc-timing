from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import server


RACE_ID = "nfc-test-001"
CHECKPOINTS = server.build_station_checkpoints(5)
TEAM_NAMES = [
    "飞跃一队",
    "逐风小队",
    "向上小队",
    "破风一队",
    "凌云小队",
    "远山一队",
    "新程小队",
    "晨光一队",
    "跃动小队",
    "启程小队",
    "疾行一队",
    "峰行小队",
    "追光一队",
    "勇进小队",
    "超越一队",
    "锐跑小队",
    "云端一队",
    "竞速小队",
    "无界一队",
    "征途小队",
]
MEMBER_NAMES = [
    ("林晨", "周宇", "陈悦", "沈航"),
    ("王拓", "李佳", "顾言", "许宁"),
    ("高越", "苏晴", "邵一", "白露"),
    ("陆川", "韩雪", "江禾", "方哲"),
    ("何凡", "袁心", "陶然", "章驰"),
    ("冯野", "罗一", "唐可", "夏至"),
    ("叶舟", "宋然", "石青", "赵新"),
    ("邱晨", "蒋维", "徐安", "吴桐"),
    ("郑博", "柳星", "潘月", "曹恺"),
    ("程远", "齐朗", "温岚", "贺川"),
    ("纪南", "安澄", "樊星", "孟然"),
    ("乔峰", "余晖", "柯宁", "段一"),
    ("江宁", "钟晴", "魏然", "宋扬"),
    ("梁川", "夏清", "裴轩", "丁一"),
    ("秦越", "卢星", "孙宁", "金晨"),
    ("谢安", "杜衡", "叶青", "莫凡"),
    ("贾航", "黎悦", "任川", "孔明"),
    ("邓宇", "龚雪", "侯森", "崔宁"),
    ("周岩", "项南", "姚可", "万晴"),
    ("施然", "熊伟", "严冬", "俞心"),
]

# The value is the latest accepted checkpoint. None means the team has not started.
LATEST_CHECKPOINTS = [
    None,
    None,
    None,
    None,
    None,
    None,
    "START",
    "START",
    "STATION_1_START",
    "STATION_1_START",
    "STATION_2_START",
    "STATION_2_START",
    "STATION_3_START",
    "STATION_3_START",
    "STATION_4_START",
    "STATION_4_START",
    "END",
    "END",
    "STATION_3_START",
    "START",
]


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def seed() -> dict:
    if server.TIMING_ENVIRONMENT != "development":
        raise RuntimeError("HOKA test data can only be seeded in development")

    server.init_db()
    now = datetime.now(timezone.utc)
    profile = server.make_race_profile(
        RACE_ID,
        "HOKA 团队挑战赛 - 测试数据",
        "station_checkpoints",
        5,
        checkpoints=CHECKPOINTS,
        entry_type="team",
    )
    profile["created_at"] = iso(now)
    profile["updated_at"] = iso(now)

    with server.connect_db() as db:
        db.execute("BEGIN IMMEDIATE")
        for table in (
            "timing_events",
            "result_adjustments",
            "manual_results",
            "participant_timing_controls",
            "start_checkins",
            "device_bindings",
            "race_admin_actions",
        ):
            db.execute(f"DELETE FROM {table} WHERE race_id = ?", (RACE_ID,))
        db.execute("DELETE FROM participants WHERE race_id = ?", (RACE_ID,))
        db.execute(
            """
            INSERT INTO race_profiles (
              race_id, name, mode, station_count, start_group_size, checkpoints_json,
              entry_type, status, finalized_at, is_template, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (race_id) DO UPDATE SET
              name = excluded.name,
              mode = excluded.mode,
              station_count = excluded.station_count,
              start_group_size = excluded.start_group_size,
              checkpoints_json = excluded.checkpoints_json,
              entry_type = excluded.entry_type,
              status = excluded.status,
              finalized_at = excluded.finalized_at,
              is_template = excluded.is_template,
              updated_at = excluded.updated_at
            """,
            (
                profile["race_id"],
                profile["name"],
                profile["mode"],
                profile["station_count"],
                1,
                json.dumps(profile["checkpoints"]),
                profile["entry_type"],
                "active",
                None,
                0,
                profile["created_at"],
                profile["updated_at"],
            ),
        )

        participant_ids = []
        for index, (team_name, member_names) in enumerate(
            zip(TEAM_NAMES, MEMBER_NAMES, strict=True), start=1
        ):
            created_at = iso(now - timedelta(minutes=90 - index))
            cursor = db.execute(
                """
                INSERT INTO participants (
                  race_id, card_code, athlete_name, bib_number, division,
                  created_at, updated_at, phone, gender, check_in_status,
                  entry_type, member_names, start_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'team', ?, ?)
                """,
                (
                    RACE_ID,
                    f"HOKA-TEST-{index:03d}",
                    team_name,
                    f"T{index:02d}",
                    "团队挑战赛",
                    created_at,
                    created_at,
                    f"1380000{index:04d}",
                    "mixed",
                    "checked_in" if index >= 4 else "not_checked_in",
                    json.dumps(member_names, ensure_ascii=False),
                    index,
                ),
            )
            participant_ids.append(cursor.lastrowid)

        # Teams 4-6 are ready. Teams 7-20 have started and retain their check-in audit.
        for index in range(4, 21):
            participant_id = participant_ids[index - 1]
            ready_at = now - timedelta(minutes=70 - index)
            started = index >= 7
            started_at = ready_at + timedelta(minutes=2) if started else None
            db.execute(
                """
                INSERT INTO start_checkins (
                  id, race_id, participant_id, device_id, status,
                  confirmed_at, started_at, updated_at
                ) VALUES (?, ?, ?, 'seed-start', ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    RACE_ID,
                    participant_id,
                    "started" if started else "ready",
                    iso(ready_at),
                    iso(started_at) if started_at else None,
                    iso(started_at or ready_at),
                ),
            )

        for index, latest_checkpoint in enumerate(LATEST_CHECKPOINTS, start=1):
            if latest_checkpoint is None:
                continue
            participant_id = participant_ids[index - 1]
            latest_index = CHECKPOINTS.index(latest_checkpoint)
            if latest_checkpoint == "END":
                start_time = now - timedelta(minutes=49 + (index - 17) * 4)
                interval_minutes = 8
            else:
                start_time = now - timedelta(minutes=8 + latest_index * 7 + index % 3)
                interval_minutes = 6
            for checkpoint_index, checkpoint in enumerate(
                CHECKPOINTS[: latest_index + 1]
            ):
                event_time = start_time + timedelta(
                    minutes=checkpoint_index * interval_minutes,
                    seconds=(index * 7 + checkpoint_index * 11) % 45,
                )
                metadata = server.checkpoint_metadata(checkpoint)
                event_id = f"hoka-test-seed:{index:02d}:{checkpoint}"
                raw_payload = {
                    "eventId": event_id,
                    "raceId": RACE_ID,
                    "participantId": participant_id,
                    "stationId": checkpoint,
                    "eventTime": iso(event_time),
                    "deviceId": "seed-data",
                    "source": "hoka-local-test-seed",
                }
                db.execute(
                    """
                    INSERT INTO timing_events (
                      event_id, race_id, device_id, station_id, station_label,
                      station_number, checkpoint_type, card_code, serial_number,
                      event_time, received_at, source, timing_mode, gate_role,
                      duplicate_window_seconds, status, participant_id, raw_json
                    ) VALUES (?, ?, 'seed-data', ?, ?, ?, ?, ?, NULL, ?, ?,
                              'hoka-local-test-seed', 'manual', NULL, 10,
                              'accepted', ?, ?)
                    """,
                    (
                        event_id,
                        RACE_ID,
                        checkpoint,
                        metadata["station_label"],
                        metadata["station_number"],
                        metadata["checkpoint_type"],
                        f"HOKA-TEST-{index:03d}",
                        iso(event_time),
                        iso(event_time),
                        participant_id,
                        json.dumps(raw_payload, ensure_ascii=False),
                    ),
                )

        # Team 19 demonstrates the DNF state without occupying a station queue.
        db.execute(
            """
            INSERT INTO participant_timing_controls (
              race_id, participant_id, action, reason, created_at
            ) VALUES (?, ?, 'dnf', ?, ?)
            """,
            (
                RACE_ID,
                participant_ids[18],
                "测试数据：模拟退赛",
                iso(now - timedelta(minutes=2)),
            ),
        )

    return {
        "raceId": RACE_ID,
        "participants": len(TEAM_NAMES),
        "ready": 3,
        "notReady": 3,
        "finished": 2,
        "dnf": 1,
    }


if __name__ == "__main__":
    print(json.dumps(seed(), ensure_ascii=False, indent=2))
