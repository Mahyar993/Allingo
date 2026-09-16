import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
  FIREBASE_PROJECT_ID: z.string().min(1).default("demo-allingo"),
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().min(10).max(120).default(45),
  INVITE_EXPIRY_MINUTES: z.coerce.number().min(1).max(1440).default(15),
  TRUST_PROXY: z.coerce.number().min(0).max(5).default(0),
});
export function loadConfig() {
  const c = schema.parse({
    ...process.env,
    PUBLIC_BASE_URL:
      process.env.PUBLIC_BASE_URL?.trim() ||
      process.env.RENDER_EXTERNAL_URL?.trim() ||
      undefined,
  });
  if (c.NODE_ENV === "production") {
    const problems: string[] = [];
    for (const key of [
      "FIREBASE_AUTH_EMULATOR_HOST",
      "FIRESTORE_EMULATOR_HOST",
    ]) {
      if (process.env[key]) problems.push(`Remove ${key} in production`);
    }
    if (c.FIREBASE_PROJECT_ID.startsWith("demo-"))
      problems.push("Set FIREBASE_PROJECT_ID to your real Firebase project ID");
    if (new URL(c.PUBLIC_BASE_URL).protocol !== "https:")
      problems.push(
        "Set PUBLIC_BASE_URL to an HTTPS URL, or leave it unset on Render to use RENDER_EXTERNAL_URL",
      );
    if (problems.length)
      throw new Error(`Invalid production configuration: ${problems.join("; ")}`);
  }
  return c;
}
export type Config = ReturnType<typeof loadConfig>;
export function iceConfig() {
  const urls = (key: string) =>
    (process.env[key] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const stun = urls("ICE_STUN_URLS");
  const turn = urls("ICE_TURN_URLS");
  if (
    stun.some((s) => !/^stuns?:[^\s]+$/.test(s)) ||
    turn.some((s) => !/^turns?:[^\s]+$/.test(s))
  )
    throw new Error("Invalid ICE URL");
  return {
    iceServers: [
      ...(stun.length ? [{ urls: stun }] : []),
      ...(turn.length &&
      process.env.ICE_TURN_USERNAME &&
      process.env.ICE_TURN_CREDENTIAL
        ? [
            {
              urls: turn,
              username: process.env.ICE_TURN_USERNAME,
              credential: process.env.ICE_TURN_CREDENTIAL,
            },
          ]
        : []),
    ],
    hasTurn: Boolean(turn.length && process.env.ICE_TURN_CREDENTIAL),
  };
}
