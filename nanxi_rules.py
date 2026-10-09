"""Nanxi registration and scoring rules, shared by the local API's write paths."""
import re
import oct11_rules

RACES = {"nanxi-race-20260919": "ABCDE", "nanxi-race-20260920": "FG", oct11_rules.RACE_ID: oct11_rules.CODES}
CATEGORIES = {
    "A": ("男子单人", "individual", 1, 0),
    "B": ("女子单人", "individual", 1, 1),
    "C": ("男子双人", "doubles", 2, 0),
    "D": ("女子双人", "doubles", 2, 2),
    "E": ("混合双人", "doubles", 2, 1),
    "F": ("双人接力", "doubles", 2, None),
    "G": ("四人接力", "team", 4, None),
}
CONFIRMED_MEN_SINGLES = {f"C-{number:03d}" for number in range(15, 21)}


def registration(payload, entry):
    race_id = payload.get("raceId")
    if race_id not in RACES:
        return {"category_code": None, "female_count": None}
    bib = str(payload.get("bibNumber") or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{0,19}", bib):
        raise ValueError("请填写 1–20 位选手号或队伍查询号（字母、数字、横线）")
    # Legacy clients may omit categoryCode; an explicit selection always wins.
    legacy_category = "A" if payload.get("raceId") == "nanxi-race-20260919" and bib in CONFIRMED_MEN_SINGLES else (
        bib[0] if re.fullmatch(r"[A-G]-[0-9]{3}", bib) else ""
    )
    category = str(payload.get("categoryCode") or legacy_category).upper()
    if category not in CATEGORIES or category not in RACES[race_id]:
        raise ValueError("请选择 10·11 的比赛组别：四人接力、男单、女单、混双、女双、男双" if race_id == oct11_rules.RACE_ID else "请选择该比赛日期的组别：19 日 A–E，20 日 F/G")
    label, entry_type, members, female_count = CATEGORIES[category]
    if entry["entry_type"] != entry_type or len(entry["member_names"]) != members:
        raise ValueError(f"{label}需要 {members} 位成员，参赛类型为 {entry_type}")
    if female_count is None:
        value = payload.get("femaleCount")
        if race_id == oct11_rules.RACE_ID and value is None:
            value = 0  # Composition has no scoring adjustment in the October event.
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= members:
            raise ValueError(f"请确认女性参赛人数（0–{members}）")
        female_count = value
    bibs = payload.get("memberBibNumbers", [])
    if not isinstance(bibs, list) or any(not isinstance(value, str) for value in bibs):
        raise ValueError("成员选手号必须为数组")
    bibs = [value.strip().upper() for value in bibs]
    if bibs and (len(bibs) != members or any(not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{0,19}", value) for value in bibs)):
        raise ValueError(f"请填写全部 {members} 位成员的选手号")
    if len(set(bibs)) != len(bibs):
        raise ValueError("同一组内成员选手号不能重复")
    return {"category_code": category, "female_count": female_count, "member_bib_numbers": bibs}


def result_fields(participant, adjustments):
    category = participant.get("category_code")
    if not category and participant.get("race_id") in RACES:
        category = str(participant.get("bib_number") or "")[:1]
    if participant.get("race_id") not in RACES or category not in CATEGORIES:
        return {}
    female_count = participant.get("female_count")
    deduction = min(int(female_count or 0), 2) * 300000 if category in "FG" and participant.get("race_id") == "nanxi-race-20260920" else 0
    return {
        "categoryCode": category, "categoryLabel": CATEGORIES[category][0],
        "femaleCount": female_count, "deductionMs": deduction,
        "penaltyMs": sum(max(0, row["adjustment_ms"]) for row in adjustments),
    }


def rank_categories(results):
    """Only finished entries have an official rank; equal totals share a rank."""
    for category in CATEGORIES:
        entries = [row for row in results if row.get("categoryCode") == category]
        finished = sorted(
            (row for row in entries if row["status"] == "finished" and row["elapsedMs"] is not None),
            key=lambda row: (row["elapsedMs"], row["bibNumber"]),
        )
        for row in entries:
            row.update(rank=None, categoryRank=None, gapMs=None)
        previous_time, rank = None, 0
        for index, row in enumerate(finished, 1):
            if row["elapsedMs"] != previous_time:
                rank = index
            previous_time = row["elapsedMs"]
            row.update(rank=rank, categoryRank=rank, gapMs=row["elapsedMs"] - finished[0]["elapsedMs"])
