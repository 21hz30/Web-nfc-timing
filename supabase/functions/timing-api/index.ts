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
      order: "bib_number.asc.nullslast,athlete_name.asc",
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
): DatabaseRow[] {
  const segments: DatabaseRow[] = [];
  for (let station = 1; station <= stationCount; station += 1) {
    const enterCheckpoint = `STATION_${station}_ENTER`;
    const exitCheckpoint = station === stationCount ? "END" : `STATION_${station}_EXIT`;
    const runStartCheckpoint = station === 1 ? "START" : `STATION_${station - 1}_EXIT`;
    segments.push({
      type: "run",
      number: station,
      elapsedMs: millisecondsBetween(
        checkpointTimes[runStartCheckpoint] || null,
        checkpointTimes[enterCheckpoint] || null,
      ),
    });
    segments.push({
      type: "station",
      number: station,
      elapsedMs: millisecondsBetween(
        checkpointTimes[enterCheckpoint] || null,
        checkpointTimes[exitCheckpoint] || null,
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

    const startTime = checkpointTimes.START || null;
    const finishTime = checkpointTimes.END || null;
    const status = finishTime
      ? "finished"
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

    const stationSplits: Record<string, number | null> = {};
    const segmentSplits = profile.mode === "station_checkpoints"
      ? []
      : buildSegmentSplits(checkpointTimes, Number(profile.station_count));
    if (profile.mode === "station_checkpoints") {
      const stationCount = Number(profile.station_count);
      if (usesStationBoundaries) {
        for (let station = 1; station <= stationCount; station += 1) {
          const startCheckpoint = station === 1 ? "START" : `STATION_${station}_START`;
          const endCheckpoint = station === stationCount
            ? "END"
            : `STATION_${station + 1}_START`;
          stationSplits[`station${station}Ms`] = millisecondsBetween(
            checkpointTimes[startCheckpoint] || null,
            checkpointTimes[endCheckpoint] || null,
          );
        }
      } else {
        let previous = startTime;
        for (let station = 1; station <= stationCount; station += 1) {
          const current = checkpointTimes[`STATION_${station}_START`] || null;
          stationSplits[`station${station}Ms`] = millisecondsBetween(previous, current);
          previous = current;
        }
      }
    } else {
      for (let station = 1; station <= Number(profile.station_count); station += 1) {
        const enter = checkpointTimes[`STATION_${station}_ENTER`] || null;
        const exit = checkpointTimes[`STATION_${station}_EXIT`]
          || (station === Number(profile.station_count) ? finishTime : null);
        stationSplits[`station${station}Ms`] = millisecondsBetween(enter, exit);
      }
    }

    const participantAdjustments = adjustmentsByParticipant.get(String(participant.id)) || [];
    const adjustmentMs = participantAdjustments.reduce(
      (total, adjustment) => total + Number(adjustment.adjustment_ms || 0),
      0,
    );
    const rawElapsedMs = startTime
      ? millisecondsBetween(startTime, finishTime || generatedAt)
      : null;
    const elapsedMs = finishTime && rawElapsedMs !== null
      ? Math.max(0, rawElapsedMs + adjustmentMs)
      : rawElapsedMs;

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
      elapsedMs,
      rawElapsedMs,
      adjustmentMs,
      adjustments: participantAdjustments.map(resultAdjustmentResponse),
      checkpointTimes,
      stationSplits,
      segmentSplits,
    };
  });

  const statusOrder: Record<string, number> = {
    finished: 0,
    racing: 1,
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
    const [participants, events, adjustments] = await Promise.all([
      raceParticipants(raceId),
      raceEvents(raceId, { acceptedOnly: true }),
      raceAdjustments(raceId),
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
        profile.finalized_at || undefined,
      ),
    });
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

async function handlePost(route: string, request: Request): Promise<Response> {
  const payload = await readJsonBody(request);

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
    const deletedEvents = await databaseRequest("timing_events", {
      method: "DELETE",
      query,
      prefer: "return=representation",
    });
    let deletedAdjustments: DatabaseRow[] = [];
    if (matchedParticipants.length) {
      deletedAdjustments = await databaseRequest("result_adjustments", {
        method: "DELETE",
        query: {
          race_id: `eq.${raceId}`,
          participant_id: `in.(${matchedParticipants.map((row: DatabaseRow) => row.id).join(",")})`,
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
      },
      raceProfilePreserved: true,
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
    const [checkpointEvents, existingAdjustments] = await Promise.all([
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
    ]);
    const checkpointTimes: Record<string, string> = {};
    for (const event of checkpointEvents) {
      if (!checkpointTimes[event.station_id]) checkpointTimes[event.station_id] = event.event_time;
    }
    const rawElapsedMs = millisecondsBetween(
      checkpointTimes.START || null,
      checkpointTimes.END || null,
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
    const existingRows = await databaseRequest("participants", {
      query: {
        select: "created_at",
        race_id: `eq.${raceId}`,
        card_code: `eq.${cardCode}`,
        limit: "1",
      },
    });
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
      created_at: existingRows[0]?.created_at || now,
      updated_at: now,
    };
    const rows = await databaseRequest("participants", {
      method: "POST",
      query: { on_conflict: "race_id,card_code" },
      body: participant,
      prefer: "resolution=merge-duplicates,return=representation",
    });
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
