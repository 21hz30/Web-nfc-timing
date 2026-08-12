import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(secret, role) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    aud: "authenticated",
    exp: now + (10 * 365 * 24 * 60 * 60),
    iat: now - 60,
    iss: "src-timing-aliyun",
    role,
  });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const jwtSecret = randomBytes(48).toString("base64url");
const postgresPassword = randomBytes(24).toString("base64url");
const authenticatorPassword = randomBytes(24).toString("base64url");
const publicKey = process.env.TIMING_PUBLIC_KEY || "replace-with-browser-public-key";
const lines = [
  `POSTGRES_PASSWORD=${postgresPassword}`,
  `AUTHENTICATOR_PASSWORD=${authenticatorPassword}`,
  `PGRST_JWT_SECRET=${jwtSecret}`,
  `DATABASE_REST_SERVICE_KEY=${signJwt(jwtSecret, "service_role")}`,
  `TIMING_PUBLIC_KEY=${publicKey}`,
  `LEADERBOARD_CLEAR_CODE=${randomBytes(18).toString("base64url")}`,
  `TARGET_DATABASE_URL=postgresql://postgres:${postgresPassword}@postgres:5432/timing`,
  `PGRST_DB_URI=postgresql://timing_authenticator:${authenticatorPassword}@postgres:5432/timing`,
  "SOURCE_DATABASE_URL=",
  "",
];
const output = lines.join("\n");
const outputFlagIndex = process.argv.indexOf("--output");

if (outputFlagIndex >= 0 && process.argv[outputFlagIndex + 1]) {
  writeFileSync(process.argv[outputFlagIndex + 1], output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
