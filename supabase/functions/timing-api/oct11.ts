export const OCT11_RACE_ID = "src-race-20261011";
export const OCT11_NAME = "SRC 10·11 八站挑战赛";
export const OCT11_METADATA = {
  eventDate: "2026-10-11", timezone: "Asia/Shanghai", hasRunning: false,
  stationNames: ["滑雪机", "推雪橇", "拉雪橇", "波比跳", "划船机", "农夫行走", "弓箭步", "墙球"],
  plannedEntryCounts: {G: 16, A: 16, B: 16, E: 16, D: 8, C: 12},
  plannedEntries: 84, plannedPeople: 168,
  sessions: [
    {id: "relay", label: "四人接力", start: "14:00", end: "16:00", categories: ["G"], entries: 16, people: 64, waves: 4, entriesPerWave: 4},
    {id: "singles", label: "单人组", start: "17:00", end: "17:45", categories: ["A", "B"], entries: 32, people: 32},
    {id: "doubles", label: "双人组", start: "18:00", end: "21:30", categories: ["E", "D", "C"], entries: 36, people: 72},
  ],
};
