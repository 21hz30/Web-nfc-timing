(function () {
  "use strict";
  const raceId = "src-race-20261011", name = "SRC 10·11 八站挑战赛";
  const stations = ["滑雪机", "推雪橇", "拉雪橇", "波比跳", "划船机", "农夫行走", "弓箭步", "墙球"];
  const codes = ["G", "A", "B", "E", "D", "C"];
  const counts = {G: 16, A: 16, B: 16, E: 16, D: 8, C: 12};
  const sessions = [
    {id: "relay", label: "四人接力", start: "14:00", end: "16:00", codes: ["G"], people: 64, entries: 16, detail: "4 轮出发 · 每轮 4 队"},
    {id: "singles", label: "单人组", start: "17:00", end: "17:45", codes: ["A", "B"], people: 32, entries: 32, detail: "男单 16 人 · 女单 16 人"},
    {id: "doubles", label: "双人组", start: "18:00", end: "21:30", codes: ["E", "D", "C"], people: 72, entries: 36, detail: "混双 16 组 · 女双 8 组 · 男双 12 组"},
  ];
  const checkpoints = ["START", ...Array.from({length: 7}, (_, i) => `STATION_${i + 2}_START`), "END"];
  const isRace = id => id === raceId;
  function checkpointLabel(checkpoint) {
    if (checkpoint === "START") return "起点签到 / 等待发枪";
    if (checkpoint === "END") return "第 8 站 · 墙球完成 / 完赛";
    const match = /^STATION_(\d+)_START$/.exec(checkpoint);
    const index = match ? Number(match[1]) - 2 : -1;
    return index >= 0 && index < 7 ? `第 ${index + 1} 站 · ${stations[index]}完成` : checkpoint;
  }
  function mock() {
    const N = window.Nanxi;
    const leaderboard = codes.flatMap(code => Array.from({length: counts[code]}, (_, i) => {
      const config = N.groups[code], session = sessions.find(item => item.codes.includes(code));
      const bib = `${code}-${String(i + 1).padStart(3, "0")}`;
      const startBatch = code === "G" ? Math.floor(i / 4) + 1 : null;
      const startTime = `2026-10-11T${session.start}:00+08:00`;
      const status = i < Math.ceil(counts[code] * .6) ? "finished" : i < counts[code] - 2 ? "racing" : "not_started";
      const progressIndex = status === "finished" ? 8 : status === "racing" ? 1 + i % 7 : -1;
      const stationSplits = {}, checkpointTimes = {};
      let at = Date.parse(startTime);
      if (progressIndex >= 0) checkpointTimes.START = new Date(at).toISOString();
      for (let j = 0; j < 8; j++) {
        const ms = (90 + i * 9 + j * 13 + (code === "G" ? 0 : 40)) * 1000;
        stationSplits[`station${j + 1}Ms`] = j < progressIndex ? ms : null;
        if (j < progressIndex) {at += ms; checkpointTimes[checkpoints[j + 1]] = new Date(at).toISOString();}
      }
      const elapsedMs = progressIndex < 0 ? null : at - Date.parse(startTime);
      return {participantId: `demo-${bib}`, bibNumber: bib, categoryCode: code, categoryLabel: config.label,
        athleteName: config.size === 1 ? `示例选手 ${i + 1}` : `示例${config.size === 4 ? "接力队" : "搭档"} ${i + 1}`,
        entryType: config.type, memberNames: Array.from({length: config.size}, (_, j) => `成员 ${j + 1}`),
        memberBibNumbers: Array.from({length: config.size}, (_, j) => `${code}${String(i * config.size + j + 1).padStart(3, "0")}`),
        memberCount: config.size, startBatch, status, progressIndex, stationSplits, checkpointTimes,
        startTime: progressIndex < 0 ? null : startTime, finishTime: status === "finished" ? new Date(at).toISOString() : null,
        latestCheckpoint: progressIndex < 0 ? null : checkpoints[progressIndex], elapsedMs, rawElapsedMs: elapsedMs,
        penaltyMs: 0, deductionMs: 0, rank: null, categoryRank: null};
    }));
    for (const code of codes) {
      leaderboard.filter(row => row.categoryCode === code && row.status === "finished")
        .sort((a, b) => a.elapsedMs - b.elapsedMs).forEach((row, index) => {row.rank = row.categoryRank = index + 1;});
    }
    return {ok: true, raceId, race: {raceId, name, brand: "src", stationCount: 8, checkpoints, stationNames: stations,
      checkpointLayout: "station_boundaries", hasRunning: false}, generatedAt: new Date().toISOString(), leaderboard};
  }
  async function fetchResults(signal) {
    const response = await window.timingApiFetch(`/api/leaderboard?raceId=${raceId}`, {signal, cache: "no-store"});
    if (!response.ok) throw new Error(`成绩服务返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.leaderboard) || payload.raceId !== raceId || payload.race?.stationCount !== 8) {
      throw new Error("比赛数据或八站配置尚未就绪");
    }
    return payload;
  }
  window.SrcOct11 = {raceId, name, stations, codes, counts, sessions, checkpoints, isRace, checkpointLabel, mock, fetchResults};
  // Reuse Nanxi's registration/roster interface without giving this event Nanxi branding or scoring.
  const N = window.Nanxi;
  window.RaceEvents = {...N,
    isRace: id => N.isRace(id) || isRace(id),
    dayForRace: id => isRace(id) ? "11" : N.dayForRace(id),
    codes: day => day === "11" ? codes : N.codes(day),
    stationCountForDay: day => day === "11" ? 8 : N.stationCountForDay(day),
  };
})();
