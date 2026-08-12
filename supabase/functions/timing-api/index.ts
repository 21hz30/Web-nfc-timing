const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey",
  "Cache-Control": "no-store",
};

type JsonObject = Record<string, unknown>;
type DatabaseRow = Record<string, any>;

const JUDGE_ROLES = ["start", "station_1", "station_2", "station_3", "station_4", "station_5"];
const JUDGE_ROLE_LABELS: Record<string, string> = {
  start: "开始",
  station_1: "站点 1",
  station_2: "站点 2",
  station_3: "站点 3",
  station_4: "站点 4",
  station_5: "站点 5 / 冲线",
};
const JUDGE_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const JUDGE_PASSWORD_ITERATIONS = 240_000;

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
    Deno.env.get("TIMING_PUBLIC_KEY") || "",
    ...parseKeyMap(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")),
    Deno.env.get("SUPABASE_ANON_KEY") || "",
  ].filter(Boolean);
}

function serviceApiKey(): string {
  const modernKeys = parseKeyMap(Deno.env.get("SUPABASE_SECRET_KEYS"));
  return Deno.env.get("DATABASE_REST_SERVICE_KEY")
    || modernKeys[0]
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || "";
}

function storageProviderName(): string {
  return Deno.env.get("TIMING_STORAGE_PROVIDER") || "supabase";
}

function timingEnvironment(): string {
  return Deno.env.get("TIMING_ENVIRONMENT")
    || (storageProviderName() === "supabase" ? "production" : "development");
}

function databaseResourceUrl(resource: string): URL {
  const configuredRestUrl = Deno.env.get("DATABASE_REST_URL") || "";
  if (configuredRestUrl) {
    const baseUrl = configuredRestUrl.endsWith("/")
      ? configuredRestUrl
      : `${configuredRestUrl}/`;
    return new URL(resource, baseUrl);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (!supabaseUrl) {
    throw new Error("Database REST URL is not configured");
  }
  return new URL(`/rest/v1/${resource}`, supabaseUrl);
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
  const secretKey = serviceApiKey();
  if (!secretKey) {
    throw new Error("Database REST credentials are not configured");
  }

  const url = databaseResourceUrl(resource);
  for (const [key, value] of Object.entries(options.query || {})) {
    url.searchParams.set(key, value);
  }

  const requestInit = {
    method: options.method || "GET",
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, requestInit);
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : null;

    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.details || text;
    } catch {
      // Keep the response text as the error detail.
    }
    const futureJwt = response.status === 401 && /JWT issued at future/i.test(String(detail));
    if (futureJwt && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      continue;
    }
    throw new Error(`Database REST HTTP ${response.status}: ${detail}`);
  }

  throw new Error("Database REST request retry limit reached");
}

function requiredRaceId(value: unknown): string {
  const raceId = String(value || "").trim();
  if (!raceId || raceId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(raceId)) {
    throw new Error("raceId must contain only letters, numbers, hyphens, or underscores");
  }
  return raceId;
}

function requestedStartTime(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("startedAt must be an ISO 8601 timestamp");
  }
  return parsed.toISOString();
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

function base64UrlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signJudgeToken(value: string): Promise<string> {
  const secret = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function issueJudgeToken(raceId: string, role: string, displayName: string): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify({
    raceId,
    role,
    displayName,
    expiresAt: Math.floor(Date.now() / 1000) + JUDGE_TOKEN_TTL_SECONDS,
  }));
  return `${payload}.${await signJudgeToken(payload)}`;
}

async function verifyJudgeToken(token: string, raceId: string): Promise<JsonObject | null> {
  const [encodedPayload, suppliedSignature] = token.split(".", 2);
  if (!encodedPayload || !suppliedSignature) return null;
  const expectedSignature = await signJudgeToken(encodedPayload);
  if (expectedSignature !== suppliedSignature) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as JsonObject;
    const expiresAt = Number(payload.expiresAt || 0);
    if (!JUDGE_ROLES.includes(String(payload.role || "")) && payload.role !== "admin") return null;
    if (![raceId, "*"].includes(String(payload.raceId || "")) || expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function deriveJudgePassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: JUDGE_PASSWORD_ITERATIONS },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function judgeRoleCheckpoints(profile: DatabaseRow, role: string): string[] {
  if (role === "admin") return [];
  if (role === "start") return ["START"];
  const stationNumber = Number(String(role).replace("station_", ""));
  if (!Number.isInteger(stationNumber) || profile.mode !== "station_checkpoints") return [];
  const checkpoints = Array.isArray(profile.checkpoints)
    ? profile.checkpoints.map((checkpoint: unknown) => String(checkpoint))
    : [];
  if (checkpoints.includes("STATION_1_START")) {
    const allowed: string[] = [];
    const directCheckpoint = `STATION_${stationNumber}_START`;
    if (checkpoints.includes(directCheckpoint)) allowed.push(directCheckpoint);
    if (stationNumber >= Number(profile.station_count || 0) && checkpoints.includes("END")) {
      allowed.push("END");
    }
    return allowed;
  }
  const boundaryCheckpoint = stationNumber >= Number(profile.station_count || 0)
    ? "END"
    : `STATION_${stationNumber + 1}_START`;
  return checkpoints.includes(boundaryCheckpoint) ? [boundaryCheckpoint] : [];
}

function judgeRoleCheckpoint(profile: DatabaseRow, role: string): string | null {
  return judgeRoleCheckpoints(profile, role)[0] || null;
}

function nextRaceCheckpoint(
  profile: DatabaseRow,
  recordedCheckpoints: string[],
): { latestCheckpoint: string | null; expectedCheckpoint: string | null } {
  const checkpoints: string[] = Array.isArray(profile.checkpoints)
    ? profile.checkpoints.map((checkpoint: unknown) => String(checkpoint))
    : [];
  const checkpointIndex = new Map<string, number>(
    checkpoints.map((checkpoint, index) => [checkpoint, index] as const),
  );
  let latestCheckpoint: string | null = null;
  let latestIndex = -1;
  for (const checkpoint of recordedCheckpoints) {
    const index = checkpointIndex.get(checkpoint) ?? -1;
    if (index > latestIndex) {
      latestCheckpoint = checkpoint;
      latestIndex = index;
    }
  }
  return {
    latestCheckpoint,
    expectedCheckpoint: latestIndex + 1 < checkpoints.length ? checkpoints[latestIndex + 1] : null,
  };
}

function manualCheckpointStationIds(profile: DatabaseRow, stationId: string): string[] {
  const checkpoints = Array.isArray(profile.checkpoints)
    ? profile.checkpoints.map((checkpoint: unknown) => String(checkpoint))
    : [];
  const finalStation = `STATION_${Number(profile.station_count || 0)}_START`;
  const finalStationIndex = checkpoints.indexOf(finalStation);
  if (
    profile.mode === "station_checkpoints"
    && checkpointLayout(profile) === "station_starts"
    && stationId === finalStation
    && finalStationIndex >= 0
    && checkpoints[finalStationIndex + 1] === "END"
  ) {
    return [stationId, "END"];
  }
  return [stationId];
}

async function judgeAuthorization(payload: JsonObject, raceId: string): Promise<JsonObject | null> {
  const token = await verifyJudgeToken(String(payload.judgeToken || ""), raceId);
  if (token) return token;
  const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
  if (configuredCode.length >= 8 && await secretsMatch(String(payload.adminCode || ""), configuredCode)) {
    return { role: "admin", raceId, displayName: "管理员" };
  }
  return null;
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

function checkpointMetadata(checkpoint: string): JsonObject {
  if (checkpoint === "START") {
    return { stationLabel: "Race Start", stationNumber: null, checkpointType: "start" };
  }
  if (checkpoint === "END") {
    return { stationLabel: "Race Finish", stationNumber: null, checkpointType: "end" };
  }
  const match = checkpoint.match(/^STATION_(\d+)_(ENTER|EXIT|START)$/);
  if (match) {
    const checkpointType = match[2].toLowerCase();
    return {
      stationLabel: `Station ${match[1]} ${checkpointType[0].toUpperCase()}${checkpointType.slice(1)}`,
      stationNumber: Number(match[1]),
      checkpointType,
    };
  }
  return { stationLabel: checkpoint, stationNumber: null, checkpointType: "unknown" };
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
    return {
      participantId,
      athleteName: participant.athlete_name,
      entryType: participant.entry_type || "individual",
      memberNames: Array.isArray(participant.member_names) ? participant.member_names : [],
      cardCode: participant.card_code,
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
    const confirmedAtDifference = String(left.confirmedAt || "").localeCompare(String(right.confirmedAt || ""));
    if (confirmedAtDifference) return confirmedAtDifference;
    return String(left.athleteName || "").localeCompare(String(right.athleteName || ""));
  });

  return {
    entries,
    summary: {
      registered: entries.length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      started: entries.filter((entry) => entry.status === "started").length,
      waiting: entries.filter((entry) => entry.status === "not_ready").length,
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
      environment: timingEnvironment(),
      time: new Date().toISOString(),
      storage: {
        primary: storageProviderName(),
        databaseConfigured: true,
        supabaseConfigured: storageProviderName() === "supabase",
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
      ...buildStartQueue(participants, checkins, startEvents),
    });
  }

  if (route === "/judge-station-accounts") {
    const raceId = requiredRaceId(url.searchParams.get("raceId"));
    const authorization = await judgeAuthorization({
      judgeToken: url.searchParams.get("judgeToken") || "",
      adminCode: url.searchParams.get("adminCode") || "",
    }, raceId);
    if (!authorization || authorization.role !== "admin") {
      return jsonResponse({ ok: false, error: "Administrator authorization is required" }, 403);
    }
    const profile = await ensureRaceProfile(raceId);
    const rows = await databaseRequest("judge_station_accounts", {
      query: {
        select: "id,race_id,role,username,display_name,active,created_at,updated_at",
        race_id: `eq.${raceId}`,
        order: "id.asc",
      },
    });
    return jsonResponse({
      ok: true,
      raceId,
      accounts: rows.map((row: DatabaseRow) => ({
        id: row.id,
        raceId: row.race_id,
        role: row.role,
        roleLabel: JUDGE_ROLE_LABELS[row.role] || row.role,
        username: row.username,
        displayName: row.display_name,
        active: Boolean(row.active),
        allowedCheckpoint: judgeRoleCheckpoint(profile, row.role),
        allowedCheckpoints: judgeRoleCheckpoints(profile, row.role),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
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

  if (route === "/judge-auth") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Judge authorization is not configured" }, 503);
    }
    const raceId = String(payload.raceId || "").trim();
    const username = String(payload.username || "").trim().toLowerCase();
    const password = String(payload.password || "");
    let role = "admin";
    let displayName = "管理员";
    if (username === "admin") {
      if (!await secretsMatch(password, configuredCode)) {
        return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
      }
      role = "admin";
      displayName = "全局管理员";
    } else if (username) {
      if (!raceId) throw new Error("raceId is required for a station account");
      const rows = await databaseRequest("judge_station_accounts", {
        query: { select: "*", race_id: `eq.${raceId}`, username: `eq.${username}`, active: "eq.true", limit: "1" },
      });
      const account = rows[0];
      if (!account) return jsonResponse({ ok: false, error: "Invalid judge account or password" }, 403);
      const digest = await deriveJudgePassword(password, String(account.password_salt || ""));
      if (digest !== String(account.password_hash || "")) {
        return jsonResponse({ ok: false, error: "Invalid judge account or password" }, 403);
      }
      role = String(account.role);
      displayName = String(account.display_name || JUDGE_ROLE_LABELS[role] || role);
    } else if (!await secretsMatch(String(payload.adminCode || ""), configuredCode)) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const profile = raceId ? await ensureRaceProfile(raceId) : null;
    return jsonResponse({
      ok: true,
      authenticated: true,
      role,
      displayName,
      raceId: raceId || "*",
      judgeToken: await issueJudgeToken(
        role === "admin" && username === "admin" ? "*" : raceId || "*",
        role,
        displayName,
      ),
      allowedCheckpoint: profile && role !== "admin" ? judgeRoleCheckpoint(profile, role) : null,
      allowedCheckpoints: profile && role !== "admin" ? judgeRoleCheckpoints(profile, role) : [],
    });
  }

  if (route === "/judge-station-accounts") {
    const raceId = requiredRaceId(payload.raceId);
    const authorization = await judgeAuthorization(payload, raceId);
    if (!authorization || authorization.role !== "admin") {
      return jsonResponse({ ok: false, error: "Administrator authorization is required" }, 403);
    }
    const role = String(payload.role || "").trim().toLowerCase();
    const username = String(payload.username || "").trim().toLowerCase();
    const password = String(payload.password || "");
    const displayName = String(payload.displayName || "").trim();
    const active = payload.active !== false;
    if (!JUDGE_ROLES.includes(role)) throw new Error("role must be one of the six judge station roles");
    if (!/^[a-z0-9._-]{2,50}$/.test(username)) throw new Error("username must contain 2-50 letters, numbers, dots, hyphens, or underscores");
    if (displayName.length > 80) throw new Error("displayName must be 80 characters or fewer");
    const existingRows = await databaseRequest("judge_station_accounts", {
      query: { select: "*", race_id: `eq.${raceId}`, role: `eq.${role}`, limit: "1" },
    });
    const existing = existingRows[0];
    if (!existing && password.length < 8) throw new Error("password is required and must be at least 8 characters when creating an account");
    if (password && (password.length < 8 || password.length > 200)) throw new Error("password must be between 8 and 200 characters");
    const now = new Date().toISOString();
    let passwordSalt = String(existing?.password_salt || "");
    let passwordHash = String(existing?.password_hash || "");
    if (password) {
      passwordSalt = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
      passwordHash = await deriveJudgePassword(password, passwordSalt);
    }
    const record = {
      race_id: raceId,
      role,
      username,
      password_hash: passwordHash,
      password_salt: passwordSalt,
      display_name: displayName || existing?.display_name || JUDGE_ROLE_LABELS[role],
      active,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    const rows = await databaseRequest("judge_station_accounts", {
      method: "POST",
      query: { on_conflict: "race_id,role" },
      body: record,
      prefer: "resolution=merge-duplicates,return=representation",
    });
    const profile = await ensureRaceProfile(raceId);
    return jsonResponse({
      ok: true,
      account: {
        id: rows[0].id,
        raceId,
        role,
        roleLabel: JUDGE_ROLE_LABELS[role],
        username,
        displayName: record.display_name,
        active,
        allowedCheckpoint: judgeRoleCheckpoint(profile, role),
        allowedCheckpoints: judgeRoleCheckpoints(profile, role),
        createdAt: rows[0].created_at,
        updatedAt: rows[0].updated_at,
      },
    }, 201);
  }

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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
    if (!Number.isSafeInteger(participantId) || participantId <= 0) {
      return jsonResponse({ ok: false, error: "participantId is required" }, 400);
    }
    const authorization = await judgeAuthorization(payload, raceId);
    if (!authorization || !["admin", "start"].includes(String(authorization.role))) {
      return jsonResponse({ ok: false, error: "Start judge authorization is required" }, 403);
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
    const authorization = await judgeAuthorization(payload, raceId);
    if (!authorization || !["admin", "start"].includes(String(authorization.role))) {
      return jsonResponse({ ok: false, error: "Start judge authorization is required" }, 403);
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
        query: { select: "id", race_id: `eq.${raceId}`, id: idFilter },
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
    if (startEvents.length || manualResults.length) {
      return jsonResponse({ ok: false, status: "already_started", error: "One or more selected participants have already started" }, 409);
    }
    if (readyCheckins.length !== participantIds.length) {
      return jsonResponse({ ok: false, status: "start_checkin_required", error: "Every selected participant must pass the start check-in first" }, 409);
    }

    const startedAt = requestedStartTime(payload.startedAt);
    const result = await databaseRequest("rpc/start_race_batch", {
      method: "POST",
      body: {
        p_race_id: raceId,
        p_participant_ids: participantIds,
        p_started_at: startedAt,
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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
      cloudError: null,
    }, 201);
  }

  if (route === "/manual-checkpoints") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Manual checkpoint entry is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const participantId = Number(payload.participantId);
    const stationId = String(payload.stationId || "").trim().toUpperCase();
    const eventTimeInput = String(payload.eventTime || "").trim();
    const reason = String(payload.reason || "").trim();
    const auditReason = reason || "现场裁判人工确认";
    const deviceId = String(payload.deviceId || "judge-console").trim();
    if (!Number.isInteger(participantId) || participantId <= 0) {
      throw new Error("participantId is required");
    }
    if (!stationId) throw new Error("stationId is required");
    if (deviceId.length > 100) throw new Error("deviceId must be 100 characters or fewer");
    if (reason.length > 500) throw new Error("reason must be 500 characters or fewer");
    const authorization = await judgeAuthorization(payload, raceId);
    if (!authorization) {
      return jsonResponse({ ok: false, error: "Judge authorization is required" }, 403);
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
    if (!profile.checkpoints.includes(stationId)) {
      throw new Error("stationId is not part of this race profile");
    }
    const allowedCheckpoints = judgeRoleCheckpoints(profile, String(authorization.role || ""));
    if (authorization.role !== "admin" && !allowedCheckpoints.includes(stationId)) {
      return jsonResponse({
        ok: false,
        status: "checkpoint_not_allowed",
        error: "This judge account cannot confirm the selected checkpoint",
        allowedCheckpoint: allowedCheckpoints[0] || null,
        allowedCheckpoints,
      }, 403);
    }
    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(eventTimeInput)) {
      throw new Error("eventTime must be an ISO-8601 timestamp with a timezone");
    }
    const eventTimeMs = Date.parse(eventTimeInput);
    if (!Number.isFinite(eventTimeMs)) throw new Error("eventTime must be ISO-8601");
    const eventTime = new Date(eventTimeMs).toISOString();
    const metadata = checkpointMetadata(stationId);
    const stationIds = manualCheckpointStationIds(profile, stationId);
    const [participants, checkpointEvents] = await Promise.all([
      databaseRequest("participants", {
        query: {
          select: "id,card_code",
          race_id: `eq.${raceId}`,
          id: `eq.${participantId}`,
          limit: "1",
        },
      }),
      databaseRequest("timing_events", {
        query: {
          select: "id,station_id,event_time",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participantId}`,
          status: "eq.accepted",
          order: "event_time.asc,id.asc",
        },
      }),
    ]);
    if (!participants[0]) throw new Error("Participant was not found in this race");
    const { latestCheckpoint, expectedCheckpoint } = nextRaceCheckpoint(
      profile,
      checkpointEvents.map((event) => String(event.station_id || "")),
    );
    if (stationId !== expectedCheckpoint) {
      return jsonResponse({
        ok: false,
        status: "wrong_checkpoint",
        error: "Only the participant's next checkpoint can be confirmed",
        stationId,
        latestCheckpoint,
        expectedCheckpoint,
      }, 409);
    }
    const latestEvent = checkpointEvents.find((event) => event.station_id === latestCheckpoint);
    if (latestEvent && eventTimeMs < Date.parse(String(latestEvent.event_time || ""))) {
      throw new Error("eventTime must not be earlier than the previous checkpoint time");
    }
    const receivedAt = new Date().toISOString();
    const eventRows = stationIds.map((recordedStationId) => {
      const eventId = `judge-manual-checkpoint:${crypto.randomUUID()}`;
      const recordedMetadata = checkpointMetadata(recordedStationId);
      return {
        event_id: eventId,
        race_id: raceId,
        device_id: deviceId,
        station_id: recordedStationId,
        station_label: recordedMetadata.stationLabel,
        station_number: recordedMetadata.stationNumber,
        checkpoint_type: recordedMetadata.checkpointType,
        card_code: participants[0].card_code,
        serial_number: null,
        event_time: eventTime,
        received_at: receivedAt,
        source: "judge-manual-checkpoint",
        timing_mode: "manual",
        gate_role: null,
        duplicate_window_seconds: 10,
        status: "accepted",
        participant_id: participantId,
        raw_json: {
          eventId,
          raceId,
          participantId,
          stationId: recordedStationId,
          confirmedStationId: stationId,
          linkedStationIds: stationIds,
          eventTime,
          reason: auditReason,
          deviceId,
          source: "judge-manual-checkpoint",
        },
      };
    });
    const rows = await databaseRequest("timing_events", {
      method: "POST",
      body: eventRows,
      prefer: "return=representation",
    });
    if (stationId === "START") {
      await databaseRequest("start_checkins", {
        method: "POST",
        query: { on_conflict: "race_id,participant_id" },
        body: {
          id: crypto.randomUUID(),
          race_id: raceId,
          participant_id: participantId,
          device_id: deviceId,
          status: "started",
          confirmed_at: eventTime,
          started_at: eventTime,
          updated_at: new Date().toISOString(),
        },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
    return jsonResponse({
      ok: true,
      status: "accepted",
      raceId,
      participantId,
      stationId,
      stationIds,
      stationLabel: metadata.stationLabel,
      eventTime,
      event: rows[0],
      events: rows,
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
      cloudError: null,
    }, 201);
  }

  if (route === "/rollback-checkpoint") {
    const raceId = requiredRaceId(payload.raceId);
    const participantId = Number(payload.participantId);
    const reason = String(payload.reason || "管理员撤回误触").trim();
    if (!Number.isInteger(participantId) || participantId <= 0) {
      throw new Error("participantId is required");
    }
    if (!reason || reason.length > 500) {
      throw new Error("reason must be between 1 and 500 characters");
    }
    const authorization = await judgeAuthorization(payload, raceId);
    if (!authorization || authorization.role !== "admin") {
      return jsonResponse({ ok: false, error: "Administrator authorization is required" }, 403);
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

    const [participants, checkpointEvents] = await Promise.all([
      databaseRequest("participants", {
        query: {
          select: "id",
          race_id: `eq.${raceId}`,
          id: `eq.${participantId}`,
          limit: "1",
        },
      }),
      databaseRequest("timing_events", {
        query: {
          select: "*",
          race_id: `eq.${raceId}`,
          participant_id: `eq.${participantId}`,
          status: "eq.accepted",
          order: "event_time.asc,id.asc",
        },
      }),
    ]);
    if (!participants[0]) throw new Error("Participant was not found in this race");
    const { latestCheckpoint } = nextRaceCheckpoint(
      profile,
      checkpointEvents.map((event: DatabaseRow) => String(event.station_id || "")),
    );
    if (!latestCheckpoint) {
      return jsonResponse({
        ok: false,
        status: "nothing_to_rollback",
        error: "This participant has no accepted checkpoint to roll back",
      }, 409);
    }

    const latestEvent = checkpointEvents
      .filter((event: DatabaseRow) => event.station_id === latestCheckpoint)
      .sort((left: DatabaseRow, right: DatabaseRow) => (
        String(right.event_time).localeCompare(String(left.event_time))
        || Number(right.id) - Number(left.id)
      ))[0];
    const latestRaw = latestEvent?.raw_json && typeof latestEvent.raw_json === "object"
      ? latestEvent.raw_json
      : {};
    const rawLinked = Array.isArray(latestRaw.linkedStationIds)
      ? latestRaw.linkedStationIds.map((stationId: unknown) => String(stationId))
      : null;
    const linkedStationIds = rawLinked
      && rawLinked.includes(latestCheckpoint)
      && rawLinked.every((stationId: string) => profile.checkpoints.includes(stationId))
      ? rawLinked
      : [latestCheckpoint];
    const confirmedStationId = String(latestRaw.confirmedStationId || latestCheckpoint);
    const eventsToRevert = checkpointEvents.filter((event: DatabaseRow) => {
      if (!linkedStationIds.includes(String(event.station_id))) return false;
      if (linkedStationIds.length === 1) return event.id === latestEvent.id;
      const eventRaw = event.raw_json && typeof event.raw_json === "object" ? event.raw_json : {};
      return event.event_time === latestEvent.event_time
        && JSON.stringify(eventRaw.linkedStationIds || null) === JSON.stringify(rawLinked)
        && String(eventRaw.confirmedStationId || "") === confirmedStationId;
    });
    const revertedAt = new Date().toISOString();
    const revertedEvents = await Promise.all(eventsToRevert.map(async (event: DatabaseRow) => {
      const originalRaw = event.raw_json && typeof event.raw_json === "object"
        ? event.raw_json
        : { originalRawJson: event.raw_json };
      const rows = await databaseRequest("timing_events", {
        method: "PATCH",
        query: { id: `eq.${event.id}` },
        body: {
          status: "reverted",
          raw_json: {
            ...originalRaw,
            rollback: {
              reason,
              revertedAt,
              revertedBy: authorization.displayName || "全局管理员",
            },
          },
        },
        prefer: "return=representation",
      });
      return rows[0];
    }));

    if (linkedStationIds.includes("START")) {
      await databaseRequest("start_checkins", {
        method: "PATCH",
        query: { race_id: `eq.${raceId}`, participant_id: `eq.${participantId}` },
        body: { status: "ready", started_at: null, updated_at: revertedAt },
        prefer: "return=minimal",
      });
    }
    const remainingEvents = await databaseRequest("timing_events", {
      query: {
        select: "station_id",
        race_id: `eq.${raceId}`,
        participant_id: `eq.${participantId}`,
        status: "eq.accepted",
      },
    });
    const { latestCheckpoint: previousCheckpoint } = nextRaceCheckpoint(
      profile,
      remainingEvents.map((event: DatabaseRow) => String(event.station_id || "")),
    );
    return jsonResponse({
      ok: true,
      status: "reverted",
      raceId,
      participantId,
      revertedStationIds: revertedEvents.map((event: DatabaseRow) => event.station_id),
      previousCheckpoint,
      events: revertedEvents,
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
      cloudError: null,
    });
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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
      const releasedBindings = await databaseRequest("device_bindings", {
        method: "DELETE",
        query: { race_id: `eq.${raceId}` },
        prefer: "return=representation",
      });
      return jsonResponse({
        ok: true,
        race: raceResponse(existing),
        releasedDeviceBindings: Array.isArray(releasedBindings) ? releasedBindings.length : 0,
        storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
    const releasedBindings = await databaseRequest("device_bindings", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}` },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      race: raceResponse(rows[0]),
      releasedDeviceBindings: Array.isArray(releasedBindings) ? releasedBindings.length : 0,
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
      storage: { localSaved: false, supabaseSaved: true, primary: storageProviderName() },
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
    if (profile.status === "finalized") {
      return jsonResponse(
        { ok: false, status: "race_finalized", error: "This race has ended" },
        409,
      );
    }
    const existing = await databaseRequest("device_bindings", {
      query: {
        select: "*",
        race_id: `eq.${raceId}`,
        device_id: `eq.${deviceId}`,
        limit: "1",
      },
    });
    if (existing[0]) {
      if (existing[0].assignment === assignment) {
        return jsonResponse({ ok: true, raceId, binding: existing[0] });
      }
      return jsonResponse({
        ok: false,
        status: "device_already_bound",
        error: "This device is already bound; unbind it before choosing another station",
        binding: existing[0],
      }, 409);
    }
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
    try {
      const rows = await databaseRequest("device_bindings", {
        method: "POST",
        body: {
          race_id: raceId,
          device_id: deviceId,
          assignment,
          created_at: now,
          updated_at: now,
        },
        prefer: "return=representation",
      });
      return jsonResponse({ ok: true, raceId, binding: rows[0] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate key value")) throw error;
      return jsonResponse({
        ok: false,
        status: "assignment_already_bound",
        error: "This role is already bound to another device",
      }, 409);
    }
  }

  if (route === "/device-bindings/unbind") {
    const configuredCode = Deno.env.get("LEADERBOARD_CLEAR_CODE") || "";
    if (configuredCode.length < 8) {
      return jsonResponse({ ok: false, error: "Device unbinding is not configured" }, 503);
    }
    const raceId = requiredRaceId(payload.raceId);
    const deviceId = String(payload.deviceId || "").trim();
    const suppliedCode = String(payload.adminCode || "");
    if (!deviceId || deviceId.length > 100) throw new Error("deviceId is required");
    if (!suppliedCode || !(await secretsMatch(suppliedCode, configuredCode))) {
      return jsonResponse({ ok: false, error: "Invalid administrator code" }, 403);
    }
    const removed = await databaseRequest("device_bindings", {
      method: "DELETE",
      query: { race_id: `eq.${raceId}`, device_id: `eq.${deviceId}` },
      prefer: "return=representation",
    });
    return jsonResponse({
      ok: true,
      raceId,
      deviceId,
      removed: Array.isArray(removed) ? removed.length : 0,
    });
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
            storage: { localSaved: false, supabaseSaved: false, primary: storageProviderName() },
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
    const status = message.startsWith("Database REST HTTP")
      || message.startsWith("Supabase HTTP")
      ? 502
      : 400;
    return jsonResponse({ ok: false, error: message }, status);
  }
});
