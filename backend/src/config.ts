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
  const c = schema.parse(process.env);
  if (
    c.NODE_ENV === "production" &&
    (process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.FIRESTORE_EMULATOR_HOST ||
      c.FIREBASE_PROJECT_ID.startsWith("demo-") ||
      !c.PUBLIC_BASE_URL.startsWith("https://"))
  )
    throw new Error(
      "Production requires real Firebase, HTTPS, and no emulator hosts",
    );
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
