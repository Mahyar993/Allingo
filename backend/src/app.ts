import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { Server } from "socket.io";
import { z } from "zod";
import pino from "pino";
import {
  ApiError,
  username,
  id,
  participant,
  type Auth,
  type Store,
  type Push,
} from "./core.js";
import { type Config, iceConfig } from "./config.js";
import { Users } from "./users.js";
import { Calls } from "./calls.js";
export function createApp(
  config: Config,
  deps: { auth: Auth; store: Store; push: Push },
) {
  const log = pino({ level: config.NODE_ENV === "test" ? "silent" : "info" });
  const app = express();
  app.set("trust proxy", config.TRUST_PROXY);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "32kb" }));
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  const http = createServer(app);
  const io = new Server(http, {
    maxHttpBufferSize: 32768,
    transports: ["websocket"],
    serveClient: false,
  });
  const users = new Users(deps.store),
    calls = new Calls(deps.store, deps.push, config.CALL_RING_TIMEOUT_SECONDS);
  calls.onUpdate = (c) => {
    io.to(c.caller).to(c.callee).emit("call:update", c);
  };
  app.get("/health", (_q, r) => r.json({ status: "ok", service: "allingo", callHeartbeat: true }));
  const token = async (value: unknown) => {
    if (typeof value !== "string" || value.length > 8192)
      throw new ApiError(401, "unauthorized");
    try {
      return await deps.auth.verify(value);
    } catch {
      throw new ApiError(401, "unauthorized");
    }
  };
  app.use("/api", async (q, r, n) => {
    try {
      const h = q.header("authorization");
      if (!h?.startsWith("Bearer ")) throw new ApiError(401, "unauthorized");
      r.locals.uid = (await token(h.slice(7))).uid;
      n();
    } catch (e) {
      n(e);
    }
  });
  const userLimit = rateLimit({
    windowMs: 60000,
    limit: 25,
    keyGenerator: (_q, r) => r.locals.uid,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.get("/api/config/ice", (_q, r) => {
    r.set("Cache-Control", "no-store").json(iceConfig());
  });
  app.get("/api/users/me", async (_q, r) =>
    r.json((await deps.store.get(`users/${r.locals.uid}`)) ?? null),
  );
  app.post("/api/users/username", userLimit, async (q, r) => {
    const b = z
      .object({ username, displayName: z.string().trim().max(60).default("") })
      .strict()
      .parse(q.body);
    r.json(await users.claim(r.locals.uid, b.username, b.displayName));
  });
  app.get("/api/users/search", userLimit, async (q, r) =>
    r.json(await users.search(username.parse(q.query.q))),
  );
  app.get("/api/calls/active", async (_q, r) =>
    r.json((await calls.active(r.locals.uid)) ?? null),
  );
  app.get("/api/calls/:id", async (q, r) =>
    r.json(await calls.get(r.locals.uid, id.parse(q.params.id))),
  );
  app.post("/api/calls/start", userLimit, async (q, r) => {
    const b = z
      .object({
        callee: id,
        kind: z.enum(["audio", "video"]),
        requestId: z.uuid(),
      })
      .strict()
      .parse(q.body);
    r.json(await calls.start(r.locals.uid, b.callee, b.kind, b.requestId));
  });
  for (const action of ["accept", "reject", "cancel", "end"])
    app.post(`/api/calls/:id/${action}`, async (q, r) =>
      r.json(await calls.change(r.locals.uid, id.parse(q.params.id), action)),
    );
  app.post("/api/calls/:id/heartbeat", async (q, r) => {
    await calls.heartbeat(r.locals.uid, id.parse(q.params.id));
    r.json({ ok: true });
  });
  app.get("/api/call-history", async (_q, r) => {
    const data = await deps.store.list<{ createdAt: number }>(
      `callHistory/${r.locals.uid}/items`,
      100,
    );
    r.json(data.sort((a, b) => b.createdAt - a.createdAt));
  });
  for (const method of ["post", "delete"] as const)
    app[method]("/api/devices/fcm-token", async (q, r) => {
      const b = z
        .object({ token: z.string().min(20).max(4096) })
        .strict()
        .parse(q.body);
      const p = `deviceTokens/${r.locals.uid}/items/${createHash("sha256").update(b.token).digest("hex")}`;
      await deps.store.transaction(async (tx) => {
        method === "post"
          ? tx.set(p, { token: b.token, updatedAt: Date.now() })
          : tx.delete(p);
      });
      r.json({ ok: true });
    });
  app.post("/api/invites", userLimit, async (_q, r) => {
    const t = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + config.INVITE_EXPIRY_MINUTES * 60000;
    await deps.store.transaction(async (tx) => {
      tx.set(`invites/${t}`, { id: t, uid: r.locals.uid, expiresAt });
    });
    r.json({
      url: `${config.PUBLIC_BASE_URL}/invite/${t}`,
      token: t,
      expiresAt,
    });
  });
  const inviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
  async function resolve(t: unknown) {
    const v = await deps.store.get<{ uid: string; expiresAt: number }>(
      `invites/${inviteToken.parse(t)}`,
    );
    if (!v || v.expiresAt < Date.now())
      throw new ApiError(410, "invite_expired");
    return v;
  }
  app.get("/api/invites/:token", userLimit, async (q, r) => {
    const v = await resolve(q.params.token);
    r.json(await deps.store.get(`users/${v.uid}`));
  });
  app.get("/invite/:token", async (q, r) => {
    await resolve(q.params.token);
    const t = inviteToken.parse(q.params.token);
    r.type("html").send(
      `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Allingo invitation</title><body><h1>Allingo</h1><p>A voice can cross languages.</p><a href="allingo://invite/${t}">Open invitation in Allingo</a><p>Install Allingo from the APK supplied by its owner if it is not installed. This invitation expires.</p></body></html>`,
    );
  });
  io.use(async (socket, next) => {
    try {
      socket.data.identity = await token(socket.handshake.auth.token);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  io.on("connection", (socket) => {
    const identity = socket.data.identity as { uid: string; exp: number };
    const uid = identity.uid;
    void socket.join(uid);
    const expiry = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, identity.exp * 1000 - Date.now()),
    );
    expiry.unref();
    let count = 0;
    const window = setInterval(() => {
      count = 0;
    }, 10000);
    window.unref();
    const seen = new Set<string>();
    socket.on("disconnect", () => {
      clearTimeout(expiry);
      clearInterval(window);
    });
    socket.on("call:heartbeat", async (payload, ack) => {
      try {
        if (++count > 100) throw new ApiError(429, "rate_limited");
        await calls.heartbeat(uid, id.parse(payload?.callId));
        if (typeof ack === "function") ack({ ok: true });
      } catch {
        if (typeof ack === "function") ack({ ok: false });
      }
    });
    socket.on("webrtc:signal", async (payload, ack) => {
      try {
        if (++count > 100) throw new ApiError(429, "rate_limited");
        const b = z
          .object({
            callId: id,
            eventId: z.uuid(),
            kind: z.enum(["offer", "answer", "ice"]),
            sdp: z.string().max(24000).optional(),
            candidate: z.string().max(4096).optional(),
            sdpMid: z.string().max(64).nullable().optional(),
            sdpMLineIndex: z.number().int().min(0).max(20).optional(),
          })
          .strict()
          .parse(payload);
        const c = await calls.get(uid, b.callId);
        participant(c, uid);
        if (c.state !== "connected")
          throw new ApiError(409, "invalid_call_state");
        if (
          (b.kind === "offer" && uid !== c.caller) ||
          (b.kind === "answer" && uid !== c.callee)
        )
          throw new ApiError(403, "invalid_signal_role");
        if (
          b.kind === "ice"
            ? b.candidate === undefined || b.sdpMLineIndex === undefined
            : !b.sdp
        )
          throw new ApiError(400, "invalid_signal");
        if (!seen.has(b.eventId)) {
          if (seen.size >= 2000) throw new ApiError(429, "signal_limit");
          seen.add(b.eventId);
          io.to(uid === c.caller ? c.callee : c.caller).emit(
            "webrtc:signal",
            b,
          );
        }
        if (typeof ack === "function") ack({ ok: true });
      } catch (e) {
        if (typeof ack === "function")
          ack({
            ok: false,
            error: e instanceof ApiError ? e.code : "invalid_payload",
          });
      }
    });
  });
  app.use((e: unknown, _q: Request, r: Response, _n: NextFunction) => {
    const status =
      e instanceof ApiError
        ? e.status
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? 400
          : typeof e === "object" &&
              e !== null &&
              "status" in e &&
              e.status === 413
            ? 413
            : 500;
    if (status === 500) log.error({ event: "request_failed" });
    r.status(status).json({
      error:
        e instanceof ApiError
          ? e.code
          : status === 400
            ? "invalid_payload"
            : status === 413
              ? "payload_too_large"
              : "internal_error",
    });
  });
  const cleanup = setInterval(() => {
    void (async () => {
      for (const collection of ["invites", "requests"]) {
        const records = await deps.store.list<{
          id: string;
          expiresAt: number;
        }>(collection, 500);
        for (const record of records)
          if (record.id && record.expiresAt < Date.now())
            await deps.store.transaction(async (tx) => {
              tx.delete(`${collection}/${record.id}`);
            });
      }
    })().catch(() => log.error({ event: "cleanup_failed" }));
  }, 60000);
  cleanup.unref();
  const sweep = setInterval(() => {
    void calls.sweep().catch(() => log.error({ event: "sweep_failed" }));
  }, 5000);
  sweep.unref();
  return {
    app,
    http,
    io,
    calls,
    async close() {
      clearInterval(sweep);
      clearInterval(cleanup);
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
    log,
  };
}
