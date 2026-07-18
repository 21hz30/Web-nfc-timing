const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function buildLeaderboard(
  participants: DatabaseRow[],
  events: DatabaseRow[],
  profile: DatabaseRow,
): JsonObject[] {
  const checkpoints: string[] = profile.checkpoints;
  const usesStationBoundaries = checkpointLayout(profile) === "station_boundaries";
  const checkpointIndex = new Map(checkpoints.map((checkpoint, index) => [checkpoint, index]));
  const eventsByParticipant = new Map<string, DatabaseRow[]>();
  for (const event of events) {
    const key = String(event.participant_id);
    eventsByParticipant.set(key, [...(eventsByParticipant.get(key) || []), event]);
  }

  const generatedAt = new Date().toISOString();
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
    const status = finishTime ? "finished" : latestCheckpoint ? "racing" : "not_started";
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

    return {
      participantId: participant.id,
      athleteName: participant.athlete_name,
      bibNumber: participant.bib_number,
      cardCode: participant.card_code,
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
      elapsedMs: startTime ? millisecondsBetween(startTime, finishTime || generatedAt) : null,
      checkpointTimes,
      stationSplits,
    };
  });

  const statusOrder: Record<string, number> = { finished: 0, racing: 1, not_started: 2 };
  results.sort((left, right) => {
    const statusDifference = (statusOrder[left.status] ?? 3) - (statusOrder[right.status] ?? 3);
    if (statusDifference) return statusDifference;
    if (left.progressIndex !== right.progressIndex) return right.progressIndex - left.progressIndex;
    const leftElapsed = left.elapsedMs ?? Number.MAX_SAFE_INTEGER;
    const rightElapsed = right.elapsedMs ?? Number.MAX_SAFE_INTEGER;
    if (leftElapsed !== rightElapsed) return leftElapsed - rightElapsed;
    return String(left.bibNumber || "").localeCompare(String(right.bibNumber || ""));
  });

  const leaderElapsed = results[0]?.elapsedMs ?? null;
  return results.map((result, index) => ({
    ...result,
    rank: index + 1,
    gapMs: result.elapsedMs === null || leaderElapsed === null
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
    const [participants, events] = await Promise.all([
      raceParticipants(raceId),
      raceEvents(raceId, { acceptedOnly: true }),
    ]);
    return jsonResponse({
      ok: true,
      raceId,
      race: raceResponse(profile),
      generatedAt: new Date().toISOString(),
      checkpoints: profile.checkpoints,
      leaderboard: buildLeaderboard(participants, events, profile),
    });
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

async function handlePost(route: string, request: Request): Promise<Response> {
  const payload = await readJsonBody(request);

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
    const athleteName = String(payload.athleteName || "").trim();
    const checkInStatus = String(payload.checkInStatus || "checked_in").trim();
    if (!cardCode || !athleteName) {
      throw new Error("raceId, cardCode and athleteName are required");
    }
    if (!new Set(["not_checked_in", "checked_in"]).has(checkInStatus)) {
      throw new Error("checkInStatus must be not_checked_in or checked_in");
    }
    await ensureRaceProfile(raceId);
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
      phone: String(payload.phone || "").trim() || null,
      gender: String(payload.gender || "").trim() || null,
      division: String(payload.division || "").trim() || null,
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

  if (route === "/timing-events") {
    const raceId = requiredRaceId(payload.raceId);
    await ensureRaceProfile(raceId);
    const result = await databaseRequest("rpc/process_timing_event_v2", {
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
