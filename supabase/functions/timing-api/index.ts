const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey",
  "Cache-Control": "no-store",
};

type JsonObject = Record<string, unknown>;
type DatabaseRow = Record<string, any>;

function jsonResponse(payload: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function parseKeyMap(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return Object.values(parsed).filter((key): key is string => typeof key === "string");
    }
  } catch {
    return [];
  }
  return [];
}

function publicApiKeys(): string[] {
  return [
    ...parseKeyMap(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")),
    Deno.env.get("SUPABASE_ANON_KEY") || "",
  ].filter(Boolean);
}

function serviceApiKey(): string {
  const modernKeys = parseKeyMap(Deno.env.get("SUPABASE_SECRET_KEYS"));
  return modernKeys[0] || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

function isAuthorized(request: Request): boolean {
  const suppliedKey = request.headers.get("apikey") || "";
  return suppliedKey !== "" && publicApiKeys().includes(suppliedKey);
}

function apiRoute(requestUrl: string): string {
  const pathname = new URL(requestUrl).pathname;
  const functionMarker = "/timing-api";
  const markerIndex = pathname.indexOf(functionMarker);
  if (markerIndex >= 0) {
    return pathname.slice(markerIndex + functionMarker.length) || "/";
  }
  if (pathname.startsWith("/api/")) {
    return pathname.slice(4);
  }
  return pathname;
}

async function databaseRequest(
  resource: string,
  options: {
    method?: string;
    query?: Record<string, string>;
    body?: unknown;
    prefer?: string;
  } = {},
): Promise<any> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const secretKey = serviceApiKey();
  if (!supabaseUrl || !secretKey) {
    throw new Error("Supabase server credentials are not configured");
  }

  const url = new URL(`/rest/v1/${resource}`, supabaseUrl);
  for (const [key, value] of Object.entries(options.query || {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.details || text;
    } catch {
      // Keep the response text as the error detail.
    }
    throw new Error(`Supabase HTTP ${response.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

function requiredRaceId(value: unknown): string {
  const raceId = String(value || "").trim();
  if (!raceId || raceId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(raceId)) {
    throw new Error("raceId must contain only letters, numbers, hyphens, or underscores");
  }
  return raceId;
}

async function secretsMatch(supplied: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const suppliedBytes = new Uint8Array(suppliedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < suppliedBytes.length; index += 1) {
    difference |= suppliedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

function normalizeEntryType(value: unknown): string {
  const requested = String(value || "individual").trim().toLowerCase();
  const entryType = requested === "single"
    ? "individual"
    : requested === "double"
      ? "doubles"
      : requested;
  if (!new Set(["individual", "doubles", "team"]).has(entryType)) {
    throw new Error("entryType must be individual, doubles, or team");
  }
  return entryType;
}

function normalizeMemberNames(value: unknown, fallbackName = ""): string[] {
  const source = Array.isArray(value) ? value : [];
  const names = source.map((name) => String(name).trim()).filter(Boolean);
  if (!names.length && fallbackName) names.push(fallbackName);
  if (names.some((name) => name.length > 100)) {
    throw new Error("each member name must be 100 characters or fewer");
  }
  return names;
}

function normalizeParticipantEntry(payload: JsonObject): {
  entryType: string;
  displayName: string;
  memberNames: string[];
} {
  const entryType = normalizeEntryType(payload.entryType);
  let displayName = String(payload.athleteName || "").trim();
  const memberNames = normalizeMemberNames(payload.memberNames, displayName);
  if (entryType === "individual") {
    if (memberNames.length !== 1) {
      throw new Error("individual entries require exactly one member name");
    }
    displayName = memberNames[0];
  } else if (entryType === "doubles") {
    if (!displayName) throw new Error("doubles entries require a team name");
    if (memberNames.length !== 2) {
      throw new Error("doubles entries require exactly two member names");
    }
  } else {
    if (!displayName) throw new Error("team entries require a team name");
    if (memberNames.length < 2 || memberNames.length > 12) {
      throw new Error("team entries require between 2 and 12 member names");
    }
  }
  return { entryType, displayName, memberNames };
}

function buildCheckpoints(mode: string, stationCount: number): string[] {
  if (mode === "station_checkpoints") {
    return [
      "START",
      ...Array.from({ length: stationCount }, (_, index) => `STATION_${index + 1}_START`),
      "END",
    ];
  }

  const checkpoints = ["START"];
  for (let station = 1; station < stationCount; station += 1) {
    checkpoints.push(`STATION_${station}_ENTER`, `STATION_${station}_EXIT`);
  }
  checkpoints.push(`STATION_${stationCount}_ENTER`, "END");
  return checkpoints;
}

function buildStationBoundaryCheckpoints(stationCount: number): string[] {
  return [
    "START",
    ...Array.from(
      { length: Math.max(0, stationCount - 1) },
      (_, index) => `STATION_${index + 2}_START`,
    ),
    "END",
  ];
}

function checkpointLayout(profile: DatabaseRow): string | null {
  if (profile.mode !== "station_checkpoints") return null;
  return profile.checkpoints.includes("STATION_1_START")
    ? "station_starts"
    : "station_boundaries";
}

function defaultRaceProfile(raceId: string): DatabaseRow {
  const now = new Date().toISOString();
  return {
    race_id: raceId,
    name: raceId,
    mode: "two_reader_auto",
    station_count: 8,
    start_group_size: 1,
    checkpoints: buildCheckpoints("two_reader_auto", 8),
    entry_type: raceId === "hoka-race" ? "team" : "individual",
    status: "active",
    finalized_at: null,
    is_template: false,
    created_at: now,
    updated_at: now,
  };
}

function raceResponse(profile: DatabaseRow): JsonObject {
  return {
    raceId: profile.race_id,
    name: profile.name,
    mode: profile.mode,
    stationCount: Number(profile.station_count),
    startGroupSize: Number(profile.start_group_size || 1),
    checkpoints: profile.checkpoints,
    checkpointLayout: checkpointLayout(profile),
    entryType: profile.entry_type || "individual",
    status: profile.status || "active",
    finalizedAt: profile.finalized_at || null,
    isTemplate: Boolean(profile.is_template),
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  };
}

async function findRaceProfile(raceId: string): Promise<DatabaseRow | null> {
  const rows = await databaseRequest("race_profiles", {
    query: {
      select: "*",
      race_id: `eq.${raceId}`,
      limit: "1",
    },
  });
  return rows[0] || null;
}

async function ensureRaceProfile(raceId: string): Promise<DatabaseRow> {
  const existing = await findRaceProfile(raceId);
  if (existing) return existing;
  const profile = defaultRaceProfile(raceId);
  const rows = await databaseRequest("race_profiles", {
    method: "POST",
    query: { on_conflict: "race_id" },
    body: profile,
    prefer: "resolution=merge-duplicates,return=representation",
  });
  return rows[0];
}

async function raceParticipants(raceId: string): Promise<DatabaseRow[]> {
  return await databaseRequest("participants", {
    query: {
      select: "*",
      race_id: `eq.${raceId}`,
      order: "start_order.asc,athlete_name.asc,id.asc",
    },
  });
}

async function raceEvents(
  raceId: string,
  options: { acceptedOnly?: boolean; limit?: number } = {},
): Promise<DatabaseRow[]> {
  const query: Record<string, string> = {
    select: "*",
    race_id: `eq.${raceId}`,
    order: options.acceptedOnly ? "event_time.asc,id.asc" : "received_at.desc,id.desc",
  };
  if (options.acceptedOnly) {
    query.status = "eq.accepted";
    query.participant_id = "not.is.null";
  }
  if (options.limit) query.limit = String(options.limit);
  return await databaseRequest("timing_events", { query });
}

async function raceAdjustments(raceId: string): Promise<DatabaseRow[]> {
  return await databaseRequest("result_adjustments", {
    query: {
      select: "*",
      race_id: `eq.${raceId}`,
      order: "created_at.asc,id.asc",
    },
  });
}

async function raceManualResults(raceId: string): Promise<DatabaseRow[]> {
  return await databaseRequest("manual_results", {
    query: {
      select: "*",
      race_id: `eq.${raceId}`,
      order: "created_at.asc,id.asc",
    },
  });
}

async function raceTimingControls(raceId: string): Promise<DatabaseRow[]> {
  return await databaseRequest("participant_timing_controls", {
    query: {
      select: "*",
      race_id: `eq.${raceId}`,
      order: "created_at.asc,id.asc",
    },
  });
}

async function raceStartCheckins(raceId: string): Promise<DatabaseRow[]> {
  return await databaseRequest("start_checkins", {
    query: {
      select: "*",
      race_id: `eq.${raceId}`,
      order: "confirmed_at.desc,participant_id.asc",
    },
  });
}

async function raceStartEvents(raceId: string): Promise<DatabaseRow[]> {
  return await databaseRequest("timing_events", {
    query: {
      select: "id,participant_id,event_time",
      race_id: `eq.${raceId}`,
      station_id: "eq.START",
      status: "eq.accepted",
      participant_id: "not.is.null",
      order: "event_time.asc,id.asc",
    },
  });
}

function buildStartQueue(
  participants: DatabaseRow[],
  checkins: DatabaseRow[],
  startEvents: DatabaseRow[],
  startGroupSize: number,
): JsonObject {
  const checkinByParticipant = new Map(
    checkins.map((checkin) => [Number(checkin.participant_id), checkin]),
  );
  const startByParticipant = new Map<number, DatabaseRow>();
  startEvents.forEach((event) => {
    const participantId = Number(event.participant_id);
    if (!startByParticipant.has(participantId)) startByParticipant.set(participantId, event);
  });

  const entries = participants.map((participant) => {
    const participantId = Number(participant.id);
    const checkin = checkinByParticipant.get(participantId) || null;
    const startEvent = startByParticipant.get(participantId) || null;
    const status = startEvent ? "started" : checkin?.status === "ready" ? "ready" : "not_ready";
    const startOrder = Number(participant.start_order || 1);
    return {
      participantId,
      athleteName: participant.athlete_name,
      entryType: participant.entry_type || "individual",
      memberNames: Array.isArray(participant.member_names) ? participant.member_names : [],
      cardCode: participant.card_code,
      startOrder,
      startWave: Math.floor((startOrder - 1) / startGroupSize) + 1,
      checkInStatus: participant.check_in_status || "not_checked_in",
      status,
      confirmedAt: checkin?.confirmed_at || null,
      confirmedDeviceId: checkin?.device_id || null,
      startedAt: startEvent?.event_time || checkin?.started_at || null,
    };
  }).sort((left, right) => {
    const statusOrder: Record<string, number> = { ready: 0, not_ready: 1, started: 2 };
    const statusDifference = statusOrder[left.status] - statusOrder[right.status];
    if (statusDifference) return statusDifference;
    const startOrderDifference = Number(left.startOrder) - Number(right.startOrder);
    if (startOrderDifference) return startOrderDifference;
    return String(left.athleteName || "").localeCompare(String(right.athleteName || ""));
  });

  return {
    entries,
    summary: {
      registered: entries.length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      started: entries.filter((entry) => entry.status === "started").length,
      waiting: entries.filter((entry) => entry.status === "not_ready").length,
      startGroupSize,
    },
  };
}

function resultAdjustmentResponse(row: DatabaseRow): JsonObject {
  return {
    id: row.id,
    raceId: row.race_id,
    participantId: row.participant_id,
    adjustmentMs: Number(row.adjustment_ms),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function manualResultResponse(row: DatabaseRow): JsonObject {
  return {
    id: row.id,
    raceId: row.race_id,
    participantId: row.participant_id,
    entryMode: row.entry_mode,
    startTime: row.start_time,
    finishTime: row.finish_time,
    elapsedMs: Number(row.elapsed_ms),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function timingControlResponse(row: DatabaseRow): JsonObject {
  return {
    id: row.id,
    raceId: row.race_id,
    participantId: row.participant_id,
    action: row.action,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

type TimingControlSummary = {
  state: "active" | "pause" | "dnf";
  intervals: Array<[number, number]>;
  latest: DatabaseRow | null;
};

function summarizeTimingControls(
  rows: DatabaseRow[],
  horizon: string,
): TimingControlSummary {
  const horizonMs = Date.parse(horizon);
  if (!Number.isFinite(horizonMs)) {
    return { state: "active", intervals: [], latest: null };
  }
  let inactiveAt: number | null = null;
  let state: TimingControlSummary["state"] = "active";
  let latest: DatabaseRow | null = null;
  const intervals: Array<[number, number]> = [];
  const ordered = [...rows].sort((left, right) => {
    const timeDifference = Date.parse(String(left.created_at)) - Date.parse(String(right.created_at));
    return timeDifference || Number(left.id || 0) - Number(right.id || 0);
  });
  for (const row of ordered) {
    const actionMs = Date.parse(String(row.created_at || ""));
    if (!Number.isFinite(actionMs) || actionMs > horizonMs) continue;
    latest = row;
    if (row.action === "pause" || row.action === "dnf") {
      if (inactiveAt === null) inactiveAt = actionMs;
      state = row.action;
    } else if (row.action === "resume" || row.action === "restore") {
      if (inactiveAt !== null) {
        intervals.push([inactiveAt, actionMs]);
        inactiveAt = null;
      }
      state = "active";
    }
  }
  if (inactiveAt !== null) intervals.push([inactiveAt, horizonMs]);
  return { state, intervals, latest };
}

function controlledMillisecondsBetween(
  start: string | null,
  end: string | null,
  controlSummary: TimingControlSummary,
): number | null {
  const baseMs = millisecondsBetween(start, end);
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  if (baseMs === null || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return baseMs;
  const excludedMs = controlSummary.intervals.reduce((total, interval) => {
    const overlapStart = Math.max(startMs, interval[0]);
    const overlapEnd = Math.min(endMs, interval[1]);
    return total + Math.max(0, overlapEnd - overlapStart);
  }, 0);
  return Math.max(0, baseMs - excludedMs);
}

function mergeParticipantDetails(
  events: DatabaseRow[],
  participants: DatabaseRow[],
): DatabaseRow[] {
  const participantsById = new Map(participants.map((row) => [String(row.id), row]));
  return events.map((event) => {
    const participant = participantsById.get(String(event.participant_id)) || {};
    return {
      ...event,
      athlete_name: participant.athlete_name || null,
      bib_number: participant.bib_number || null,
      division: participant.division || null,
      phone: participant.phone || null,
      gender: participant.gender || null,
      entry_type: participant.entry_type || "individual",
      member_names: normalizeMemberNames(
        participant.member_names,
        String(participant.athlete_name || ""),
      ),
      check_in_status: participant.check_in_status || null,
    };
  });
}

function millisecondsBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function buildSegmentSplits(
  checkpointTimes: Record<string, string>,
  stationCount: number,
  controlSummary: TimingControlSummary,
  elapsedEnd: string,
  latestCheckpoint: string | null,
  status: string,
): DatabaseRow[] {
  const segments: DatabaseRow[] = [];
  for (let station = 1; station <= stationCount; station += 1) {
    const enterCheckpoint = `STATION_${station}_ENTER`;
    const exitCheckpoint = station === stationCount ? "END" : `STATION_${station}_EXIT`;
    const runStartCheckpoint = station === 1 ? "START" : `STATION_${station - 1}_EXIT`;
    segments.push({
      type: "run",
      number: station,
      elapsedMs: controlledMillisecondsBetween(
        checkpointTimes[runStartCheckpoint] || null,
        checkpointTimes[enterCheckpoint]
          || (latestCheckpoint === runStartCheckpoint && ["racing", "paused", "dnf"].includes(status)
            ? elapsedEnd
            : null),
        controlSummary,
      ),
    });
    segments.push({
      type: "station",
      number: station,
      elapsedMs: controlledMillisecondsBetween(
        checkpointTimes[enterCheckpoint] || null,
        checkpointTimes[exitCheckpoint]
          || (latestCheckpoint === enterCheckpoint && ["racing", "paused", "dnf"].includes(status)
            ? elapsedEnd
            : null),
        controlSummary,
      ),
    });
  }
  return segments;
}

function buildLeaderboard(
  participants: DatabaseRow[],
  events: DatabaseRow[],
  profile: DatabaseRow,
  adjustments: DatabaseRow[] = [],
  manualResults: DatabaseRow[] = [],
  timingControls: DatabaseRow[] = [],
  frozenAt?: string,
): JsonObject[] {
  const checkpoints: string[] = profile.checkpoints;
  const usesStationBoundaries = checkpointLayout(profile) === "station_boundaries";
  const checkpointIndex = new Map(checkpoints.map((checkpoint, index) => [checkpoint, index]));
  const eventsByParticipant = new Map<string, DatabaseRow[]>();
  for (const event of events) {
    const key = String(event.participant_id);
    eventsByParticipant.set(key, [...(eventsByParticipant.get(key) || []), event]);
  }
  const adjustmentsByParticipant = new Map<string, DatabaseRow[]>();
  for (const adjustment of adjustments) {
    const key = String(adjustment.participant_id);
    adjustmentsByParticipant.set(key, [
      ...(adjustmentsByParticipant.get(key) || []),
      adjustment,
    ]);
  }
  const manualResultsByParticipant = new Map<string, DatabaseRow[]>();
  for (const manualResult of manualResults) {
    const key = String(manualResult.participant_id);
    manualResultsByParticipant.set(key, [
      ...(manualResultsByParticipant.get(key) || []),
      manualResult,
    ]);
  }
  const timingControlsByParticipant = new Map<string, DatabaseRow[]>();
  for (const control of timingControls) {
    const key = String(control.participant_id);
    timingControlsByParticipant.set(key, [
      ...(timingControlsByParticipant.get(key) || []),
      control,
    ]);
  }

  const generatedAt = frozenAt || new Date().toISOString();
  const results = participants.map((participant) => {
    const checkpointTimes: Record<string, string> = {};
    for (const event of eventsByParticipant.get(String(participant.id)) || []) {
      if (checkpointIndex.has(event.station_id) && !checkpointTimes[event.station_id]) {
        checkpointTimes[event.station_id] = event.event_time;
      }
    }

    let latestCheckpoint: string | null = null;
    let progressIndex = -1;
    for (const checkpoint of Object.keys(checkpointTimes)) {
      const index = checkpointIndex.get(checkpoint) ?? -1;
      if (index > progressIndex) {
        progressIndex = index;
        latestCheckpoint = checkpoint;
      }
    }

    const rawStartTime = checkpointTimes.START || null;
    const rawFinishTime = checkpointTimes.END || null;
    const participantManualResults = manualResultsByParticipant.get(String(participant.id)) || [];
    const latestManualResult = participantManualResults.at(-1) || null;
    const startTime = latestManualResult?.start_time || rawStartTime;
    const finishTime = latestManualResult?.finish_time || rawFinishTime;
    const elapsedEnd = finishTime || generatedAt;
    const participantTimingControls = timingControlsByParticipant.get(String(participant.id)) || [];
    const controlSummary = summarizeTimingControls(participantTimingControls, elapsedEnd);
    const status = latestManualResult || rawFinishTime
      ? "finished"
      : controlSummary.state === "dnf"
        ? "dnf"
        : controlSummary.state === "pause"
          ? "paused"
          : profile.status === "finalized"
            ? latestCheckpoint ? "dnf" : "dns"
            : latestCheckpoint ? "racing" : "not_started";
    let current = "Waiting";
    if (latestCheckpoint === "END") current = "Finished";
    else if (latestCheckpoint === "START") {
      current = usesStationBoundaries ? "Station 1" : "Run 1";
    }
    else if (latestCheckpoint) {
      current = latestCheckpoint;
      for (let station = 1; station <= Number(profile.station_count); station += 1) {
        if (latestCheckpoint === `STATION_${station}_START`) current = `Station ${station}`;
        if (latestCheckpoint === `STATION_${station}_ENTER`) current = `Station ${station}`;
        if (latestCheckpoint === `STATION_${station}_EXIT`) {
          current = station === Number(profile.station_count) ? "To END" : `Run ${station + 1}`;
        }
      }
    }
    if (status === "paused") current = "Paused";
    else if (status === "dnf" && controlSummary.state === "dnf") current = "DNF";
    else if (latestManualResult) current = "Finished";

    const stationSplits: Record<string, number | null> = {};
    const segmentSplits = profile.mode === "station_checkpoints"
      ? []
      : buildSegmentSplits(
        checkpointTimes,
        Number(profile.station_count),
        controlSummary,
        elapsedEnd,
        latestCheckpoint,
        status,
      );
    if (profile.mode === "station_checkpoints") {
      const stationCount = Number(profile.station_count);
      if (usesStationBoundaries) {
        for (let station = 1; station <= stationCount; station += 1) {
          const startCheckpoint = station === 1 ? "START" : `STATION_${station}_START`;
          const endCheckpoint = station === stationCount
            ? "END"
            : `STATION_${station + 1}_START`;
          const splitStart = checkpointTimes[startCheckpoint] || null;
          const splitEnd = checkpointTimes[endCheckpoint]
            || (splitStart && latestCheckpoint === startCheckpoint
              && ["racing", "paused", "dnf"].includes(status)
              ? elapsedEnd
              : null);
          stationSplits[`station${station}Ms`] = controlledMillisecondsBetween(
            splitStart,
            splitEnd,
            controlSummary,
          );
        }
      } else {
        let previous = rawStartTime;
        for (let station = 1; station <= stationCount; station += 1) {
          const current = checkpointTimes[`STATION_${station}_START`] || null;
          stationSplits[`station${station}Ms`] = controlledMillisecondsBetween(
            previous,
            current,
            controlSummary,
          );
          previous = current;
        }
      }
    } else {
      for (let station = 1; station <= Number(profile.station_count); station += 1) {
        const enter = checkpointTimes[`STATION_${station}_ENTER`] || null;
        const exitCheckpoint = station === Number(profile.station_count)
          ? "END"
          : `STATION_${station}_EXIT`;
        const exit = checkpointTimes[exitCheckpoint]
          || (enter && latestCheckpoint === `STATION_${station}_ENTER`
            && ["racing", "paused", "dnf"].includes(status)
            ? elapsedEnd
            : null);
        stationSplits[`station${station}Ms`] = controlledMillisecondsBetween(
          enter,
          exit,
          controlSummary,
        );
      }
    }

    const participantAdjustments = adjustmentsByParticipant.get(String(participant.id)) || [];
    const adjustmentMs = participantAdjustments.reduce(
      (total, adjustment) => total + Number(adjustment.adjustment_ms || 0),
      0,
    );
    const rawElapsedMs = rawStartTime
      ? controlledMillisecondsBetween(rawStartTime, rawFinishTime || generatedAt, controlSummary)
      : null;
    const baseElapsedMs = latestManualResult ? Number(latestManualResult.elapsed_ms) : rawElapsedMs;
    const elapsedMs = status === "finished" && baseElapsedMs !== null
      ? Math.max(0, baseElapsedMs + adjustmentMs)
      : baseElapsedMs;

    return {
      participantId: participant.id,
      athleteName: participant.athlete_name,
      bibNumber: participant.bib_number,
      cardCode: participant.card_code,
      entryType: participant.entry_type || "individual",
      memberNames: normalizeMemberNames(
        participant.member_names,
        String(participant.athlete_name || ""),
      ),
      memberCount: normalizeMemberNames(
        participant.member_names,
        String(participant.athlete_name || ""),
      ).length,
      phone: participant.phone,
      gender: participant.gender,
      division: participant.division,
      checkInStatus: participant.check_in_status,
      status,
      current,
      progressIndex,
      latestCheckpoint,
      startTime,
      finishTime,
      rawStartTime,
      rawFinishTime,
      elapsedMs,
      rawElapsedMs,
      baseElapsedMs,
      timerRunning: status === "racing" && profile.status !== "finalized",
      adjustmentMs,
      adjustments: participantAdjustments.map(resultAdjustmentResponse),
      manualResult: latestManualResult ? manualResultResponse(latestManualResult) : null,
      manualResults: participantManualResults.map(manualResultResponse),
      timingControlState: controlSummary.state,
      timingControls: participantTimingControls.map(timingControlResponse),
      checkpointTimes,
      stationSplits,
      segmentSplits,
    };
  });

  const statusOrder: Record<string, number> = {
    finished: 0,
    racing: 1,
    paused: 1,
    dnf: 1,
    not_started: 2,
    dns: 2,
  };
  results.sort((left, right) => {
    const statusDifference = (statusOrder[left.status] ?? 3) - (statusOrder[right.status] ?? 3);
    if (statusDifference) return statusDifference;
    if (left.progressIndex !== right.progressIndex) return right.progressIndex - left.progressIndex;
    const leftElapsed = left.elapsedMs ?? Number.MAX_SAFE_INTEGER;
    const rightElapsed = right.elapsedMs ?? Number.MAX_SAFE_INTEGER;
    if (leftElapsed !== rightElapsed) return leftElapsed - rightElapsed;
    return String(left.bibNumber || "").localeCompare(String(right.bibNumber || ""));
  });

  const leaderElapsed = results.find((result) => (
    result.status === "finished" && result.elapsedMs !== null
  ))?.elapsedMs ?? null;
  return results.map((result, index) => ({
    ...result,
    rank: index + 1,
    gapMs: result.status !== "finished" || result.elapsedMs === null || leaderElapsed === null
      ? null
      : Math.max(0, result.elapsedMs - leaderElapsed),
  }));
}

async function readJsonBody(request: Request): Promise<JsonObject> {
  const payload = await request.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("JSON body must be an object");
  }
  return payload as JsonObject;
}

async function handleGet(route: string, url: URL): Promise<Response> {
  if (route === "/health") {
    const rows = await databaseRequest("race_profiles", {
      query: { select: "race_id", limit: "1" },
    });
    return jsonResponse({
      ok: true,
      time: new Date().toISOString(),
      storage: {
        primary: "supabase",
        supabaseConfigured: true,
        raceProfileProbe: rows.length,
      },
    });
  }

  if (route === "/races") {
    const rows = await databaseRequest("race_profiles", {
      query: { select: "*", order: "updated_at.desc,race_id.asc" },
    });
    return jsonResponse({ ok: true, races: rows.map(raceResponse) });
  }

  if (route === "/race-config") {
    const raceId = requiredRaceId(url.searchParams.get("raceId"));
    const profile = (await findRaceProfile(raceId)) || defaultRaceProfile(raceId);
    return jsonResponse({ ok: true, race: raceResponse(profile) });
  }

  if (route === "/participants") {
    const raceId = requiredRaceId(url.searchParams.get("raceId") || "hyrox-sim-001");
    return jsonResponse({ ok: true, participants: await raceParticipants(raceId) });
  }

  if (route === "/result-adjustments") {
    const raceId = requiredRaceId(url.searchParams.get("raceId"));
    const adjustments = await raceAdjustments(raceId);
    return jsonResponse({
      ok: true,
      raceId,
      adjustments: adjustments.map(resultAdjustmentResponse),
    });
  }

  if (route === "/manual-results") {
    const raceId = requiredRaceId(url.searchParams.get("raceId"));
    const manualResults = await raceManualResults(raceId);
    return jsonResponse({
      ok: true,
      raceId,
      manualResults: manualResults.map(manualResultResponse),
    });
  }

  if (route === "/participant-timing-controls") {
    const raceId = requiredRaceId(url.searchParams.get("raceId"));
    const controls = await raceTimingControls(raceId);
    return jsonResponse({
      ok: true,
      raceId,
      controls: controls.map(timingControlResponse),
    });
  }

  if (route === "/start-queue") {
    const raceId = requiredRaceId(url.searchParams.get("raceId"));
    const profile = await ensureRaceProfile(raceId);
    const [participants, checkins, startEvents] = await Promise.all([
      raceParticipants(raceId),
      raceStartCheckins(raceId),
      raceStartEvents(raceId),
    ]);
    return jsonResponse({
      ok: true,
      raceId,
      race: raceResponse(profile),
      generatedAt: new Date().toISOString(),
      ...buildStartQueue(
        participants,
        checkins,
        startEvents,
        Number(profile.start_group_size || 1),
      ),
    });
  }

  if (route === "/device-bindings") {
    const raceId = requiredRaceId(url.searchParams.get("raceId"));
    const bindings = await databaseRequest("device_bindings", {
      query: {
        select: "race_id,device_id,assignment,created_at,updated_at",
        race_id: `eq.${raceId}`,
        order: "assignment.asc",
      },
    });
    return jsonResponse({ ok: true, raceId, bindings });
  }

  if (route === "/timing-events") {
    const raceId = requiredRaceId(url.searchParams.get("raceId") || "hyrox-sim-001");
    const requestedLimit = Number(url.searchParams.get("limit") || "100");
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 500))
      : 100;
    const [events, participants] = await Promise.all([
      raceEvents(raceId, { limit }),
      raceParticipants(raceId),
    ]);
    return jsonResponse({
      ok: true,
      events: mergeParticipantDetails(events, participants),
    });
  }

  if (route === "/leaderboard") {
    const raceId = requiredRaceId(url.searchParams.get("raceId") || "hyrox-sim-001");
    const profile = (await findRaceProfile(raceId)) || defaultRaceProfile(raceId);
    const [participants, events, adjustments, manualResults, timingControls] = await Promise.all([
      raceParticipants(raceId),
      raceEvents(raceId, { acceptedOnly: true }),
      raceAdjustments(raceId),
      raceManualResults(raceId),
      raceTimingControls(raceId),
    ]);
    return jsonResponse({
      ok: true,
      raceId,
      race: raceResponse(profile),
      generatedAt: profile.finalized_at || new Date().toISOString(),
      checkpoints: profile.checkpoints,
      leaderboard: buildLeaderboard(
        participants,
        events,
        profile,
        adjustments,
        manualResults,
        timingControls,
        profile.finalized_at || undefined,
      ),
    });
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

async function handlePost(route: string, request: Request): Promise<Response> {
  const payload = await readJsonBody(request);

  if (route === "/start-checkins") {
    const raceId = requiredRaceId(payload.raceId);
    const cardCode = String(payload.cardCode || "").trim().toUpperCase();
    const deviceId = String(payload.deviceId || "").trim();
    if (!cardCode || cardCode.length > 100) {
      return jsonResponse({ ok: false, error: "cardCode is required" }, 400);
    }
    if (!deviceId || deviceId.length > 100) {
      return jsonResponse({ ok: false, error: "deviceId must be between 1 and 100 characters" }, 400);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (profile.status === "finalized") {
      return jsonResponse(
        { ok: false, status: "race_finalized", error: "This race has ended" },
        409,
      );
    }

    const participants = await databaseRequest("participants", {
      query: {
        select: "*",
        race_id: `eq.${raceId}`,
        card_code: `eq.${cardCode}`,
        limit: "1",
      },
    });
    const participant = participants[0];
    if (!participant) {
      return jsonResponse({
        ok: true,
        status: "unbound_card",
        cardCode,
        raceId,
        receivedAt: new Date().toISOString(),
      });
    }

    const [startEvents, manualResults] = await Promise.all([
      databaseRequest("timing_events", {
        query: {
          select: "id,event_time",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participant.id}`,
          station_id: "eq.START",
          status: "eq.accepted",
          limit: "1",
        },
      }),
      databaseRequest("manual_results", {
        query: {
          select: "id,created_at",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participant.id}`,
          limit: "1",
        },
      }),
    ]);
    if (startEvents[0] || manualResults[0]) {
      return jsonResponse({
        ok: true,
        status: "already_started",
        raceId,
        cardCode,
        participantId: participant.id,
        athleteName: participant.athlete_name,
        startedAt: startEvents[0]?.event_time || manualResults[0]?.created_at || null,
        receivedAt: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();
    const existing = await databaseRequest("start_checkins", {
      query: {
        select: "id,confirmed_at",
        race_id: `eq.${raceId}`,
        participant_id: `eq.${participant.id}`,
        limit: "1",
      },
    });
    const rows = await databaseRequest("start_checkins", {
      method: "POST",
      query: { on_conflict: "race_id,participant_id" },
      body: {
        ...(existing[0]?.id ? { id: existing[0].id } : {}),
        race_id: raceId,
        participant_id: participant.id,
        device_id: deviceId,
        status: "ready",
        confirmed_at: now,
        started_at: null,
        updated_at: now,
      },
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return jsonResponse({
      ok: true,
      status: "start_ready",
      raceId,
      cardCode,
      participantId: participant.id,
      athleteName: participant.athlete_name,
      entryType: participant.entry_type || "individual",
      memberNames: Array.isArray(participant.member_names) ? participant.member_names : [],
      confirmedAt: rows[0].confirmed_at,
      receivedAt: now,
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    });
  }

  if (route === "/start-checkins/cancel") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Judge authorization is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const participantId = Number(payload.participantId);
    const suppliedCode = String(payload.adminCode || "");
    if (!Number.isSafeInteger(participantId) || participantId <= 0) {
      return jsonResponse({ ok: false, error: "participantId is required" }, 400);
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template || profile.status === "finalized") {
      return jsonResponse({ ok: false, error: "This race cannot be changed" }, 409);
    }
    const started = await databaseRequest("timing_events", {
      query: {
        select: "id",
        race_id: `eq.${raceId}`,
        participant_id: `eq.${participantId}`,
        station_id: "eq.START",
        status: "eq.accepted",
        limit: "1",
      },
    });
    if (started[0]) {
      return jsonResponse({ ok: false, status: "already_started", error: "This participant has already started" }, 409);
    }
    const deleted = await databaseRequest("start_checkins", {
      method: "DELETE",
      query: {
        race_id: `eq.${raceId}`,
        participant_id: `eq.${participantId}`,
        status: "eq.ready",
      },
      prefer: "return=representation",
    });
    return jsonResponse({ ok: true, raceId, participantId, removed: deleted.length > 0 });
  }

  if (route === "/start-race") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Judge authorization is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const suppliedCode = String(payload.adminCode || "");
    const deviceId = String(payload.deviceId || "judge-console").trim();
    const requestedIds = Array.isArray(payload.participantIds) ? payload.participantIds : [];
    if (
      !requestedIds.length
      || requestedIds.length > 50
      || !requestedIds.every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)
    ) {
      return jsonResponse({ ok: false, error: "Select between 1 and 50 participants" }, 400);
    }
    const participantIds = [...new Set(requestedIds.map((value) => Number(value)))];
    if (!deviceId || deviceId.length > 100) {
      return jsonResponse({ ok: false, error: "deviceId must be between 1 and 100 characters" }, 400);
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (profile.status === "finalized") {
      return jsonResponse({ ok: false, status: "race_finalized", error: "This race has ended" }, 409);
    }

    const idFilter = `in.(${participantIds.join(",")})`;
    const [participants, readyCheckins, startEvents, manualResults] = await Promise.all([
      databaseRequest("participants", {
        query: { select: "id,start_order", race_id: `eq.${raceId}`, id: idFilter },
      }),
      databaseRequest("start_checkins", {
        query: {
          select: "participant_id",
          race_id: `eq.${raceId}`,
          participant_id: idFilter,
          status: "eq.ready",
        },
      }),
      databaseRequest("timing_events", {
        query: {
          select: "participant_id",
          race_id: `eq.${raceId}`,
          participant_id: idFilter,
          station_id: "eq.START",
          status: "eq.accepted",
        },
      }),
      databaseRequest("manual_results", {
        query: {
          select: "participant_id",
          race_id: `eq.${raceId}`,
          participant_id: idFilter,
        },
      }),
    ]);
    if (participants.length !== participantIds.length) {
      return jsonResponse({ ok: false, error: "One or more selected participants do not belong to this race" }, 400);
    }
    const startGroupSize = Number(profile.start_group_size || 1);
    if (participants.length > startGroupSize) {
      return jsonResponse({
        ok: false,
        error: `This race allows at most ${startGroupSize} participants per start`,
      }, 400);
    }
    const startWaves = new Set(
      participants.map((participant) => (
        Math.floor((Number(participant.start_order || 1) - 1) / startGroupSize) + 1
      )),
    );
    if (startWaves.size !== 1) {
      return jsonResponse({
        ok: false,
        error: "Selected participants must belong to the same start wave",
      }, 400);
    }
    if (startEvents.length || manualResults.length) {
      return jsonResponse({ ok: false, status: "already_started", error: "One or more selected participants have already started" }, 409);
    }
    if (readyCheckins.length !== participantIds.length) {
      return jsonResponse({ ok: false, status: "start_checkin_required", error: "Every selected participant must pass the start check-in first" }, 409);
    }

    const result = await databaseRequest("rpc/start_race_batch", {
      method: "POST",
      body: {
        p_race_id: raceId,
        p_participant_ids: participantIds,
        p_started_at: new Date().toISOString(),
        p_device_id: deviceId,
      },
    });
    return jsonResponse(result, 201);
  }

  if (route === "/reset-timing") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Timing reset is not configured" }, 503);
    }

    const raceId = requiredRaceId(payload.raceId);
    const confirmation = String(payload.confirmation || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    if (confirmation !== "SECOND_CONFIRMATION") {
      return jsonResponse({ ok: false, error: "Second confirmation is required" }, 400);
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator clear code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (profile.status === "finalized") {
      return jsonResponse({
        ok: false,
        status: "race_finalized",
        error: "Reopen this race before resetting its timing",
      }, 409);
    }

    const deletedEvents = await databaseRequest("timing_events", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedAdjustments = await databaseRequest("result_adjustments", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedManualResults = await databaseRequest("manual_results", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedTimingControls = await databaseRequest("participant_timing_controls", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedStartCheckins = await databaseRequest("start_checkins", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      raceId,
      deleted: {
        timingEvents: deletedEvents.length,
        resultAdjustments: deletedAdjustments.length,
        manualResults: deletedManualResults.length,
        timingControls: deletedTimingControls.length,
        startCheckins: deletedStartCheckins.length,
      },
      participantsPreserved: true,
      deviceBindingsPreserved: true,
      raceProfilePreserved: true,
    });
  }

  if (route === "/reset-race") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Race clearing is not configured" }, 503);
    }

    const raceId = requiredRaceId(payload.raceId);
    const confirmation = String(payload.confirmation || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    if (confirmation !== "SECOND_CONFIRMATION") {
      return jsonResponse({ ok: false, error: "Second confirmation is required" }, 400);
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator clear code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }

    const deletedEvents = await databaseRequest("timing_events", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedAdjustments = await databaseRequest("result_adjustments", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedManualResults = await databaseRequest("manual_results", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedTimingControls = await databaseRequest("participant_timing_controls", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedStartCheckins = await databaseRequest("start_checkins", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    const deletedParticipants = await databaseRequest("participants", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      raceId,
      deleted: {
        timingEvents: deletedEvents.length,
        participants: deletedParticipants.length,
        resultAdjustments: deletedAdjustments.length,
        manualResults: deletedManualResults.length,
        timingControls: deletedTimingControls.length,
        startCheckins: deletedStartCheckins.length,
      },
      raceProfilePreserved: true,
    });
  }

  if (route === "/delete-participant") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Participant deletion is not configured" }, 503);
    }

    const raceId = requiredRaceId(payload.raceId);
    const cardCode = String(payload.cardCode || "").trim().toUpperCase();
    const confirmation = String(payload.confirmation || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    if (!cardCode || cardCode.length > 100) {
      return jsonResponse({ ok: false, error: "cardCode is required" }, 400);
    }
    if (confirmation !== "DELETE_PARTICIPANT") {
      return jsonResponse({ ok: false, error: "Participant deletion confirmation is required" }, 400);
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator clear code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }

    const query = { race_id: `eq.${raceId}`, card_code: `eq.${cardCode}` };
    const matchedParticipants = await databaseRequest("participants", {
      query: { select: "id", ...query },
    });
    let deletedEvents: DatabaseRow[] = [];
    let deletedAdjustments: DatabaseRow[] = [];
    let deletedManualResults: DatabaseRow[] = [];
    let deletedTimingControls: DatabaseRow[] = [];
    if (matchedParticipants.length) {
      const participantIds = matchedParticipants.map((row: DatabaseRow) => row.id).join(",");
      deletedEvents = await databaseRequest("timing_events", {
        method: "DELETE",
        query: {
          race_id: `eq.${raceId}`,
          participant_id: `in.(${participantIds})`,
        },
        prefer: "return=representation",
      });
      deletedAdjustments = await databaseRequest("result_adjustments", {
        method: "DELETE",
        query: {
          race_id: `eq.${raceId}`,
          participant_id: `in.(${participantIds})`,
        },
        prefer: "return=representation",
      });
      deletedManualResults = await databaseRequest("manual_results", {
        method: "DELETE",
        query: {
          race_id: `eq.${raceId}`,
          participant_id: `in.(${participantIds})`,
        },
        prefer: "return=representation",
      });
      deletedTimingControls = await databaseRequest("participant_timing_controls", {
        method: "DELETE",
        query: {
          race_id: `eq.${raceId}`,
          participant_id: `in.(${participantIds})`,
        },
        prefer: "return=representation",
      });
    }
    const deletedParticipants = await databaseRequest("participants", {
      method: "DELETE",
      query,
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      raceId,
      cardCode,
      deleted: {
        timingEvents: deletedEvents.length,
        participants: deletedParticipants.length,
        resultAdjustments: deletedAdjustments.length,
        manualResults: deletedManualResults.length,
        timingControls: deletedTimingControls.length,
      },
      raceProfilePreserved: true,
    });
  }

  if (route === "/update-participant") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Participant editing is not configured" }, 503);
    }

    const raceId = requiredRaceId(payload.raceId);
    const participantId = Number(payload.participantId);
    const cardCode = String(payload.cardCode || "").trim().toUpperCase();
    const confirmation = String(payload.confirmation || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    const entry = normalizeParticipantEntry(payload);
    const checkInStatus = String(payload.checkInStatus || "checked_in").trim();
    const requestedStartOrder = payload.startOrder === undefined || payload.startOrder === ""
      ? null
      : Number(payload.startOrder);
    if (!Number.isInteger(participantId) || participantId <= 0) {
      throw new Error("participantId is required");
    }
    if (!cardCode || cardCode.length > 100) {
      throw new Error("cardCode is required and must be 100 characters or fewer");
    }
    if (confirmation !== "UPDATE_PARTICIPANT") {
      throw new Error("Participant update confirmation is required");
    }
    if (!new Set(["not_checked_in", "checked_in"]).has(checkInStatus)) {
      throw new Error("checkInStatus must be not_checked_in or checked_in");
    }
    if (
      requestedStartOrder !== null
      && (!Number.isInteger(requestedStartOrder) || requestedStartOrder < 1 || requestedStartOrder > 100000)
    ) {
      throw new Error("startOrder must be between 1 and 100000");
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }

    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (profile.status === "finalized") {
      return jsonResponse(
        { ok: false, status: "race_finalized", error: "This race has ended" },
        409,
      );
    }

    const existingRows = await databaseRequest("participants", {
      query: {
        select: "id,start_order",
        race_id: `eq.${raceId}`,
        id: `eq.${participantId}`,
        limit: "1",
      },
    });
    if (!existingRows[0]) {
      return jsonResponse({ ok: false, error: "Participant was not found in this race" }, 404);
    }
    const startOrder = requestedStartOrder ?? Number(existingRows[0].start_order || 1);
    const conflictingOrders = await databaseRequest("participants", {
      query: {
        select: "id",
        race_id: `eq.${raceId}`,
        start_order: `eq.${startOrder}`,
        id: `neq.${participantId}`,
        limit: "1",
      },
    });
    if (conflictingOrders[0]) {
      return jsonResponse({ ok: false, error: "startOrder is already assigned in this race" }, 409);
    }

    let rows: DatabaseRow[];
    try {
      rows = await databaseRequest("participants", {
        method: "PATCH",
        query: {
          race_id: `eq.${raceId}`,
          id: `eq.${participantId}`,
        },
        body: {
          card_code: cardCode,
          athlete_name: entry.displayName,
          bib_number: String(payload.bibNumber || "").trim() || null,
          entry_type: entry.entryType,
          member_names: entry.memberNames,
          phone: entry.entryType === "individual"
            ? String(payload.phone || "").trim() || null
            : null,
          gender: entry.entryType === "individual"
            ? String(payload.gender || "").trim() || null
            : null,
          division: entry.entryType === "individual"
            ? String(payload.division || "").trim() || null
            : null,
          check_in_status: checkInStatus,
          start_order: startOrder,
          updated_at: new Date().toISOString(),
        },
        prefer: "return=representation",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("participants_race_card_key") || message.includes("duplicate key value")) {
        return jsonResponse({
          ok: false,
          error: "This Card Code is already bound to another participant in this race",
        }, 409);
      }
      throw error;
    }
    if (!rows[0]) {
      return jsonResponse({ ok: false, error: "Participant was not found in this race" }, 404);
    }
    return jsonResponse({
      ok: true,
      participant: rows[0],
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    });
  }

  if (route === "/result-adjustments") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Result adjustment is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const participantId = Number(payload.participantId);
    const adjustmentSeconds = Number(payload.adjustmentSeconds);
    const reason = String(payload.reason || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    if (!Number.isInteger(participantId) || participantId <= 0) {
      throw new Error("participantId is required");
    }
    if (
      !Number.isInteger(adjustmentSeconds)
      || adjustmentSeconds === 0
      || Math.abs(adjustmentSeconds) > 86400
    ) {
      throw new Error(
        "adjustmentSeconds must be between -86400 and 86400 and cannot be zero",
      );
    }
    if (reason.length < 2 || reason.length > 500) {
      throw new Error("reason must be between 2 and 500 characters");
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }

    const participants = await databaseRequest("participants", {
      query: {
        select: "*",
        race_id: `eq.${raceId}`,
        id: `eq.${participantId}`,
        limit: "1",
      },
    });
    if (!participants[0]) throw new Error("Participant was not found in this race");
    const [checkpointEvents, existingAdjustments, manualResults, timingControls] = await Promise.all([
      databaseRequest("timing_events", {
        query: {
          select: "station_id,event_time",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participantId}`,
          status: "eq.accepted",
          station_id: "in.(START,END)",
          order: "event_time.asc,id.asc",
        },
      }),
      databaseRequest("result_adjustments", {
        query: {
          select: "adjustment_ms",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participantId}`,
        },
      }),
      databaseRequest("manual_results", {
        query: {
          select: "*",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participantId}`,
          order: "created_at.desc,id.desc",
          limit: "1",
        },
      }),
      databaseRequest("participant_timing_controls", {
        query: {
          select: "*",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participantId}`,
          order: "created_at.asc,id.asc",
        },
      }),
    ]);
    const checkpointTimes: Record<string, string> = {};
    for (const event of checkpointEvents) {
      if (!checkpointTimes[event.station_id]) checkpointTimes[event.station_id] = event.event_time;
    }
    const controlSummary = summarizeTimingControls(
      timingControls,
      checkpointTimes.END || new Date().toISOString(),
    );
    const rawElapsedMs = manualResults[0]
      ? Number(manualResults[0].elapsed_ms)
      : controlledMillisecondsBetween(
        checkpointTimes.START || null,
        checkpointTimes.END || null,
        controlSummary,
      );
    if (rawElapsedMs === null) {
      throw new Error("Only finished participants can receive a result adjustment");
    }
    const existingTotalMs = existingAdjustments.reduce(
      (total: number, adjustment: DatabaseRow) => total + Number(adjustment.adjustment_ms || 0),
      0,
    );
    const adjustmentMs = adjustmentSeconds * 1000;
    if (rawElapsedMs + existingTotalMs + adjustmentMs < 0) {
      throw new Error("The adjusted final time cannot be below zero");
    }
    const rows = await databaseRequest("result_adjustments", {
      method: "POST",
      body: {
        race_id: raceId,
        participant_id: participantId,
        adjustment_ms: adjustmentMs,
        reason,
        created_at: new Date().toISOString(),
      },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      adjustment: resultAdjustmentResponse(rows[0]),
      totalAdjustmentMs: existingTotalMs + adjustmentMs,
      finalElapsedMs: rawElapsedMs + existingTotalMs + adjustmentMs,
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    }, 201);
  }

  if (route === "/manual-results") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Manual result entry is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const participantId = Number(payload.participantId);
    const entryMode = String(payload.entryMode || "").trim();
    const reason = String(payload.reason || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    if (!Number.isInteger(participantId) || participantId <= 0) {
      throw new Error("participantId is required");
    }
    if (!new Set(["start_finish", "elapsed"]).has(entryMode)) {
      throw new Error("entryMode must be start_finish or elapsed");
    }
    if (reason.length < 2 || reason.length > 500) {
      throw new Error("reason must be between 2 and 500 characters");
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    const participants = await databaseRequest("participants", {
      query: {
        select: "id",
        race_id: `eq.${raceId}`,
        id: `eq.${participantId}`,
        limit: "1",
      },
    });
    if (!participants[0]) throw new Error("Participant was not found in this race");

    let startTime: string | null = null;
    let finishTime: string | null = null;
    let elapsedMs: number;
    if (entryMode === "start_finish") {
      startTime = String(payload.startTime || "").trim();
      finishTime = String(payload.finishTime || "").trim();
      const startMs = Date.parse(startTime);
      const finishMs = Date.parse(finishTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) {
        throw new Error("startTime and finishTime must be ISO-8601");
      }
      if (finishMs < startMs) throw new Error("finishTime must not be earlier than startTime");
      elapsedMs = finishMs - startMs;
    } else {
      const elapsedSeconds = Number(payload.elapsedSeconds);
      if (!Number.isInteger(elapsedSeconds) || elapsedSeconds <= 0) {
        throw new Error("elapsedSeconds must be a positive integer");
      }
      elapsedMs = elapsedSeconds * 1000;
    }
    if (elapsedMs > 86400000) throw new Error("Manual result cannot exceed 24 hours");
    const rows = await databaseRequest("manual_results", {
      method: "POST",
      body: {
        race_id: raceId,
        participant_id: participantId,
        entry_mode: entryMode,
        start_time: startTime,
        finish_time: finishTime,
        elapsed_ms: elapsedMs,
        reason,
        created_at: new Date().toISOString(),
      },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      manualResult: manualResultResponse(rows[0]),
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    }, 201);
  }

  if (route === "/participant-timing-controls") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Participant timing control is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const participantId = Number(payload.participantId);
    const action = String(payload.action || "").trim().toLowerCase();
    const reason = String(payload.reason || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    if (!Number.isInteger(participantId) || participantId <= 0) {
      throw new Error("participantId is required");
    }
    if (!new Set(["pause", "resume", "dnf", "restore"]).has(action)) {
      throw new Error("action must be pause, resume, dnf, or restore");
    }
    if (reason.length < 2 || reason.length > 500) {
      throw new Error("reason must be between 2 and 500 characters");
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (profile.status === "finalized") {
      throw new Error("Reopen this race before changing participant timing");
    }
    const [participants, finishEvents, manualResults, controls, startEvents] = await Promise.all([
      databaseRequest("participants", {
        query: { select: "id", race_id: `eq.${raceId}`, id: `eq.${participantId}`, limit: "1" },
      }),
      databaseRequest("timing_events", {
        query: {
          select: "id", race_id: `eq.${raceId}`, participant_id: `eq.${participantId}`,
          status: "eq.accepted", station_id: "eq.END", limit: "1",
        },
      }),
      databaseRequest("manual_results", {
        query: { select: "id", race_id: `eq.${raceId}`, participant_id: `eq.${participantId}`, limit: "1" },
      }),
      databaseRequest("participant_timing_controls", {
        query: {
          select: "*", race_id: `eq.${raceId}`, participant_id: `eq.${participantId}`,
          order: "created_at.asc,id.asc",
        },
      }),
      databaseRequest("timing_events", {
        query: {
          select: "id", race_id: `eq.${raceId}`, participant_id: `eq.${participantId}`,
          status: "eq.accepted", station_id: "eq.START", limit: "1",
        },
      }),
    ]);
    if (!participants[0]) throw new Error("Participant was not found in this race");
    if (finishEvents[0] || manualResults[0]) {
      throw new Error("A finished participant cannot be paused or marked DNF");
    }
    const currentState = summarizeTimingControls(controls, new Date().toISOString()).state;
    if (action === "pause") {
      if (!startEvents[0]) throw new Error("Only a started participant can be paused");
      if (currentState !== "active") throw new Error("Participant timing is not currently running");
    } else if (action === "resume" && currentState !== "pause") {
      throw new Error("Participant timing is not paused");
    } else if (action === "dnf" && currentState === "dnf") {
      throw new Error("Participant is already marked DNF");
    } else if (action === "restore" && currentState !== "dnf") {
      throw new Error("Only a DNF participant can be restored");
    }
    const rows = await databaseRequest("participant_timing_controls", {
      method: "POST",
      body: {
        race_id: raceId,
        participant_id: participantId,
        action,
        reason,
        created_at: new Date().toISOString(),
      },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      control: timingControlResponse(rows[0]),
      state: ["resume", "restore"].includes(action) ? "active" : action,
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    }, 201);
  }

  if (route === "/finalize-race") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Race finalization is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const suppliedCode = String(payload.adminCode || "");
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const existing = await ensureRaceProfile(raceId);
    if (existing.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (existing.status === "finalized" && existing.finalized_at) {
      return jsonResponse({
        ok: true,
        race: raceResponse(existing),
        storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
        cloudError: null,
      });
    }
    const finalizedAt = new Date().toISOString();
    const rows = await databaseRequest("race_profiles", {
      method: "PATCH",
      query: { race_id: `eq.${raceId}` },
      body: { status: "finalized", finalized_at: finalizedAt, updated_at: finalizedAt },
      prefer: "return=representation",
    });
    await databaseRequest("race_admin_actions", {
      method: "POST",
      body: {
        race_id: raceId,
        action: "finalize",
        reason: "Race finalized by administrator",
        created_at: finalizedAt,
      },
      prefer: "return=minimal",
    });
    return jsonResponse({
      ok: true,
      race: raceResponse(rows[0]),
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    });
  }

  if (route === "/reopen-race") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Race reopening is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const suppliedCode = String(payload.adminCode || "");
    const confirmation = String(payload.confirmation || "").trim();
    const reason = String(payload.reason || "").trim();
    if (confirmation !== "SECOND_CONFIRMATION") {
      return jsonResponse({ ok: false, error: "Second confirmation is required" }, 400);
    }
    if (reason.length < 2 || reason.length > 500) {
      return jsonResponse({ ok: false, error: "reason must be between 2 and 500 characters" }, 400);
    }
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const existing = await ensureRaceProfile(raceId);
    if (existing.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (existing.status !== "finalized" || !existing.finalized_at) {
      return jsonResponse({ ok: false, error: "Only a finalized race can be reopened" }, 409);
    }
    const reopenedAt = new Date().toISOString();
    const rows = await databaseRequest("race_profiles", {
      method: "PATCH",
      query: { race_id: `eq.${raceId}` },
      body: { status: "active", finalized_at: null, updated_at: reopenedAt },
      prefer: "return=representation",
    });
    const actions = await databaseRequest("race_admin_actions", {
      method: "POST",
      body: {
        race_id: raceId,
        action: "reopen",
        reason,
        created_at: reopenedAt,
      },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      race: raceResponse(rows[0]),
      action: actions[0],
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    });
  }

  if (route === "/race-config") {
    const raceId = requiredRaceId(payload.raceId);
    const modeAliases: Record<string, string> = {
      auto: "two_reader_auto",
      manual: "station_checkpoints",
    };
    const requestedMode = String(payload.mode || "two_reader_auto").trim().toLowerCase();
    const mode = modeAliases[requestedMode] || requestedMode;
    if (!new Set(["two_reader_auto", "three_reader_auto", "station_checkpoints"]).has(mode)) {
      throw new Error(
        "mode must be two_reader_auto, three_reader_auto, or station_checkpoints",
      );
    }
    const stationCount = Number(payload.stationCount ?? 8);
    if (!Number.isInteger(stationCount) || stationCount < 1 || stationCount > 20) {
      throw new Error("stationCount must be between 1 and 20");
    }
    const existing = await findRaceProfile(raceId);
    const startGroupSize = Number(
      payload.startGroupSize ?? existing?.start_group_size ?? 1,
    );
    if (!Number.isInteger(startGroupSize) || startGroupSize < 1 || startGroupSize > 50) {
      throw new Error("startGroupSize must be between 1 and 50");
    }
    if (existing?.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    const entryType = normalizeEntryType(payload.entryType || existing?.entry_type);
    const requestedLayout = String(payload.checkpointLayout || "").trim().toLowerCase();
    if (!new Set(["", "station_starts", "station_boundaries"]).has(requestedLayout)) {
      throw new Error("checkpointLayout must be station_starts or station_boundaries");
    }
    let checkpoints: string[];
    if (mode === "station_checkpoints" && requestedLayout === "station_boundaries") {
      checkpoints = buildStationBoundaryCheckpoints(stationCount);
    } else if (mode === "station_checkpoints" && requestedLayout === "station_starts") {
      checkpoints = buildCheckpoints(mode, stationCount);
    } else if (
      existing
      && existing.mode === mode
      && Number(existing.station_count) === stationCount
      && Array.isArray(existing.checkpoints)
    ) {
      checkpoints = existing.checkpoints;
    } else {
      checkpoints = buildCheckpoints(mode, stationCount);
    }
    const now = new Date().toISOString();
    const profile = {
      race_id: raceId,
      name: String(payload.name || raceId).trim() || raceId,
      mode,
      station_count: stationCount,
      start_group_size: startGroupSize,
      checkpoints,
      entry_type: entryType,
      status: existing?.status || "active",
      finalized_at: existing?.finalized_at || null,
      is_template: false,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    const rows = await databaseRequest("race_profiles", {
      method: "POST",
      query: { on_conflict: "race_id" },
      body: profile,
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return jsonResponse({
      ok: true,
      race: raceResponse(rows[0]),
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    });
  }

  if (route === "/participants") {
    const raceId = requiredRaceId(payload.raceId || "hyrox-sim-001");
    const cardCode = String(payload.cardCode || "").trim().toUpperCase();
    const entry = normalizeParticipantEntry(payload);
    const athleteName = entry.displayName;
    const checkInStatus = String(payload.checkInStatus || "checked_in").trim();
    if (!cardCode || !athleteName) {
      throw new Error("raceId, cardCode and athleteName are required");
    }
    if (!new Set(["not_checked_in", "checked_in"]).has(checkInStatus)) {
      throw new Error("checkInStatus must be not_checked_in or checked_in");
    }
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (profile.status === "finalized") {
      return jsonResponse(
        { ok: false, status: "race_finalized", error: "This race has ended" },
        409,
      );
    }
    const requestedStartOrder = payload.startOrder === undefined || payload.startOrder === ""
      ? null
      : Number(payload.startOrder);
    if (
      requestedStartOrder !== null
      && (!Number.isInteger(requestedStartOrder) || requestedStartOrder < 1 || requestedStartOrder > 100000)
    ) {
      throw new Error("startOrder must be between 1 and 100000");
    }
    const startOrderRows = await databaseRequest("participants", {
      query: {
        select: "id,start_order",
        race_id: `eq.${raceId}`,
        ...(requestedStartOrder === null
          ? { order: "start_order.desc", limit: "1" }
          : { start_order: `eq.${requestedStartOrder}`, limit: "1" }),
      },
    });
    if (requestedStartOrder !== null && startOrderRows[0]) {
      return jsonResponse({ ok: false, error: "startOrder is already assigned in this race" }, 409);
    }
    const startOrder = requestedStartOrder
      ?? (Number(startOrderRows[0]?.start_order || 0) + 1);
    const now = new Date().toISOString();
    const participant = {
      race_id: raceId,
      card_code: cardCode,
      athlete_name: athleteName,
      bib_number: String(payload.bibNumber || "").trim() || null,
      entry_type: entry.entryType,
      member_names: entry.memberNames,
      phone: entry.entryType === "individual"
        ? String(payload.phone || "").trim() || null
        : null,
      gender: entry.entryType === "individual"
        ? String(payload.gender || "").trim() || null
        : null,
      division: entry.entryType === "individual"
        ? String(payload.division || "").trim() || null
        : null,
      check_in_status: checkInStatus,
      start_order: startOrder,
      created_at: now,
      updated_at: now,
    };
    let rows: DatabaseRow[];
    try {
      rows = await databaseRequest("participants", {
        method: "POST",
        body: participant,
        prefer: "return=representation",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("participants_race_card_key") || message.includes("duplicate key value")) {
        return jsonResponse({
          ok: false,
          status: "participant_update_requires_admin",
          error: "This Card Code is already bound; use administrator-verified editing",
        }, 409);
      }
      throw error;
    }
    return jsonResponse({
      ok: true,
      participant: rows[0],
      storage: { localSaved: false, supabaseSaved: true, primary: "supabase" },
      cloudError: null,
    });
  }

  if (route === "/device-bindings") {
    const raceId = requiredRaceId(payload.raceId);
    const deviceId = String(payload.deviceId || "").trim();
    const assignment = String(payload.assignment || "").trim().toUpperCase();
    if (!deviceId || deviceId.length > 100) throw new Error("deviceId is required");
    if (!assignment || assignment.length > 100) throw new Error("assignment is required");
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    const existing = await databaseRequest("device_bindings", {
      query: {
        select: "*",
        race_id: `eq.${raceId}`,
        device_id: `eq.${deviceId}`,
        limit: "1",
      },
    });
    const occupied = await databaseRequest("device_bindings", {
      query: {
        select: "device_id,assignment",
        race_id: `eq.${raceId}`,
        assignment: `eq.${assignment}`,
        limit: "1",
      },
    });
    if (occupied[0] && occupied[0].device_id !== deviceId) {
      return jsonResponse({
        ok: false,
        error: "This role is already bound to another device",
        binding: occupied[0],
      }, 409);
    }
    const now = new Date().toISOString();
    const rows = await databaseRequest("device_bindings", {
      method: "POST",
      query: { on_conflict: "race_id,device_id" },
      body: {
        race_id: raceId,
        device_id: deviceId,
        assignment,
        created_at: existing[0]?.created_at || now,
        updated_at: now,
      },
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return jsonResponse({ ok: true, raceId, binding: rows[0] });
  }

  if (route === "/timing-events") {
    const raceId = requiredRaceId(payload.raceId);
    const profile = await ensureRaceProfile(raceId);
    if (profile.is_template) {
      return jsonResponse({
        ok: false,
        status: "race_template_read_only",
        error: "This Race ID is a read-only template; create a dated race session first",
      }, 409);
    }
    if (profile.status === "finalized") {
      return jsonResponse(
        { ok: false, status: "race_finalized", error: "This race has ended" },
        409,
      );
    }
    const cardCode = String(payload.cardCode || "").trim().toUpperCase();
    if (cardCode) {
      const participants = await databaseRequest("participants", {
        query: {
          select: "id,athlete_name",
          race_id: `eq.${raceId}`,
          card_code: `eq.${cardCode}`,
          limit: "1",
        },
      });
      if (participants[0]) {
        const [manualResults, controls] = await Promise.all([
          databaseRequest("manual_results", {
            query: {
              select: "id",
              race_id: `eq.${raceId}`,
              participant_id: `eq.${participants[0].id}`,
              limit: "1",
            },
          }),
          databaseRequest("participant_timing_controls", {
            query: {
              select: "*",
              race_id: `eq.${raceId}`,
              participant_id: `eq.${participants[0].id}`,
              order: "created_at.asc,id.asc",
            },
          }),
        ]);
        const controlState = summarizeTimingControls(controls, new Date().toISOString()).state;
        const blockedStatus = manualResults[0]
          ? "already_finished"
          : controlState === "pause"
            ? "participant_paused"
            : controlState === "dnf"
              ? "participant_dnf"
              : null;
        if (blockedStatus) {
          return jsonResponse({
            ok: true,
            status: blockedStatus,
            cardCode,
            athleteName: participants[0].athlete_name,
            stationId: String(payload.stationId || ""),
            receivedAt: new Date().toISOString(),
            storage: { localSaved: false, supabaseSaved: false, primary: "supabase" },
            cloudError: null,
          });
        }
      }
    }
    const result = await databaseRequest("rpc/process_timing_event_v3", {
      method: "POST",
      body: { p_payload: payload },
    });
    return jsonResponse(result, result.status === "duplicate_event_id" ? 200 : 201);
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (!isAuthorized(request)) {
    return jsonResponse({ ok: false, error: "Unauthorized application" }, 401);
  }

  try {
    const route = apiRoute(request.url);
    const url = new URL(request.url);
    if (request.method === "GET") return await handleGet(route, url);
    if (request.method === "POST") return await handlePost(route, request);
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Supabase HTTP") ? 502 : 400;
    return jsonResponse({ ok: false, error: message }, status);
  }
});
