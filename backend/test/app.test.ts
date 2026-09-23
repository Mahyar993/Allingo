import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { io as client } from "socket.io-client";
import { createApp } from "../src/app.js";
import type { Store, Transaction } from "../src/core.js";
class MemoryStore implements Store {
  data = new Map<string, object>();
  private queue: Promise<unknown> = Promise.resolve();
  async get<T>(p: string) {
    return structuredClone(this.data.get(p)) as T | undefined;
  }
  async list<T>(p: string) {
    return [...this.data]
      .filter(
        ([k]) =>
          k.startsWith(p + "/") && k.slice(p.length + 1).indexOf("/") === -1,
      )
      .map(([, v]) => structuredClone(v) as T);
  }
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const next = new Map(this.data);
      const v = await fn({
        get: async <V>(p: string) =>
          structuredClone(next.get(p)) as V | undefined,
        set: (p, v) => {
          next.set(p, structuredClone(v));
        },
        delete: (p) => {
          next.delete(p);
        },
      });
      this.data = next;
      return v;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
describe("Allingo API and signaling", () => {
  let store: MemoryStore;
  let service: ReturnType<typeof createApp>;
  const auth = (uid = "alice") => ({ Authorization: `Bearer ${uid}` });
  const start = () =>
    request(service.app)
      .post("/api/calls/start")
      .set(auth())
      .send({ callee: "bob", kind: "audio", requestId: crypto.randomUUID() });
  beforeEach(async () => {
    store = new MemoryStore();
    service = createApp(
      {
        NODE_ENV: "test",
        PORT: 3000,
        PUBLIC_BASE_URL: "http://localhost:3000",
        FIREBASE_PROJECT_ID: "demo-allingo",
        CALL_RING_TIMEOUT_SECONDS: 45,
        INVITE_EXPIRY_MINUTES: 15,
        TRUST_PROXY: 0,
      },
      {
        store,
        auth: {
          async verify(t) {
            if (!["alice", "bob", "eve"].includes(t)) throw Error();
            return { uid: t, exp: Math.floor(Date.now() / 1000) + 3600 };
          },
        },
        push: { async incoming() {}, async ended() {} },
      },
    );
    for (const uid of ["alice", "bob", "eve"])
      await request(service.app)
        .post("/api/users/username")
        .set(auth(uid))
        .send({ username: uid });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.close();
  });
  it("health and authentication", async () => {
    expect((await request(service.app).get("/health")).status).toBe(200);
    expect((await request(service.app).get("/api/users/me")).status).toBe(401);
    expect(
      (await request(service.app).get("/api/users/me").set(auth("invalid")))
        .status,
    ).toBe(401);
  });
  it("normalizes usernames, preserves ownership and rejects dangerous names", async () => {
    expect(
      (
        await request(service.app)
          .post("/api/users/username")
          .set(auth())
          .send({ username: " ALICE " })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(service.app)
          .post("/api/users/username")
          .set(auth("bob"))
          .send({ username: "ALICE" })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(service.app)
          .post("/api/users/username")
          .set(auth())
          .send({ username: "../bad" })
      ).status,
    ).toBe(400);
    expect(
      (await request(service.app).get("/api/users/search?q=ALICE").set(auth()))
        .body.uid,
    ).toBe("alice");
  });
  it("prevents self calls and unknown users", async () => {
    for (const [callee, status] of [
      ["alice", 400],
      ["missing", 404],
    ] as const)
      expect(
        (
          await request(service.app)
            .post("/api/calls/start")
            .set(auth())
            .send({ callee, kind: "audio", requestId: crypto.randomUUID() })
        ).status,
      ).toBe(status);
  });
  it("serializes concurrent calls and prevents busy conflicts", async () => {
    const results = await Promise.all([start(), start()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("enforces call roles, accept idempotency, end and per-user history", async () => {
    const c = (await start()).body;
    expect(
      (await request(service.app).post(`/api/calls/${c.id}/accept`).set(auth()))
        .status,
    ).toBe(403);
    expect(
      (
        await request(service.app)
          .post(`/api/calls/${c.id}/accept`)
          .set(auth("eve"))
      ).status,
    ).toBe(404);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request(service.app)
            .post(`/api/calls/${c.id}/accept`)
            .set(auth("bob"))
        ).body.state,
      ).toBe("connected");
    expect(
      (await request(service.app).post(`/api/calls/${c.id}/end`).set(auth()))
        .body.state,
    ).toBe("ended");
    const a = (await request(service.app).get("/api/call-history").set(auth()))
      .body;
    const b = (
      await request(service.app).get("/api/call-history").set(auth("bob"))
    ).body;
    expect(a[0].direction).toBe("outgoing");
    expect(b[0].direction).toBe("incoming");
    expect(await store.get(`busy/alice`)).toBeUndefined();
    expect((await start()).status).toBe(200);
  });
  it.each(["reject", "cancel"])(
    "handles %s and duplicate termination",
    async (action) => {
      const c = (await start()).body;
      const who = action === "reject" ? "bob" : "alice";
      for (let i = 0; i < 2; i++)
        expect(
          (
            await request(service.app)
              .post(`/api/calls/${c.id}/${action}`)
              .set(auth(who))
          ).status,
        ).toBe(200);
      expect(await store.get(`activeCalls/${c.id}`)).toBeUndefined();
    },
  );
  it("recovers expired calls after restart", async () => {
    const c = (await start()).body;
    store.data.set(`activeCalls/${c.id}`, { ...c, expiresAt: Date.now() - 1 });
    await service.calls.sweep();
    expect((await service.calls.get("bob", c.id)).state).toBe("missed");
    expect(await store.get("busy/bob")).toBeUndefined();
  });
  it("renews connected video calls over five minutes through HTTP and rejects outsiders", async () => {
    const c = await service.calls.start("alice", "bob", "video", crypto.randomUUID());
    await service.calls.change("bob", c.id, "accept");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect((await request(service.app).post(`/api/calls/${c.id}/heartbeat`)).status).toBe(401);
    expect((await request(service.app).post(`/api/calls/${c.id}/heartbeat`).set(auth("eve"))).status).toBe(404);
    for (let i = 0; i < 16; i++) {
      now += 20000;
      expect((await request(service.app).post(`/api/calls/${c.id}/heartbeat`)
        .set(auth(i % 2 ? "bob" : "alice"))).body.ok).toBe(true);
      await service.calls.sweep();
      expect((await service.calls.get("alice", c.id)).state).toBe("connected");
    }
    now += 120001;
    await service.calls.sweep();
    expect((await service.calls.get("alice", c.id)).state).toBe("failed");
    expect((await request(service.app).post(`/api/calls/${c.id}/heartbeat`).set(auth())).status).toBe(404);
  });
  it("does not end a call renewed after the sweep snapshot", async () => {
    const c = (await start()).body;
    const connected = await service.calls.change("bob", c.id, "accept");
    const expired = { ...connected, expiresAt: Date.now() - 1 };
    store.data.set(`activeCalls/${c.id}`, expired);
    await service.calls.heartbeat("bob", c.id);
    vi.spyOn(store, "list").mockResolvedValueOnce([expired]);
    await service.calls.sweep();
    expect((await service.calls.get("alice", c.id)).state).toBe("connected");
    expect(await store.get("busy/alice")).toBeDefined();
  });
  it("does not timeout a ringing snapshot accepted before cleanup", async () => {
    const c = (await start()).body;
    await service.calls.change("bob", c.id, "accept");
    vi.spyOn(store, "list").mockResolvedValueOnce([{ ...c, expiresAt: Date.now() - 1 }]);
    await service.calls.sweep();
    expect((await service.calls.get("bob", c.id)).state).toBe("connected");
  });
  it("expires invites and validates their input", async () => {
    const res = await request(service.app).post("/api/invites").set(auth());
    expect(res.body.token).toHaveLength(43);
    expect(
      (
        await request(service.app)
          .get(`/api/invites/${res.body.token}`)
          .set(auth("bob"))
      ).body.uid,
    ).toBe("alice");
    store.data.set(`invites/${res.body.token}`, { uid: "alice", expiresAt: 0 });
    expect(
      (
        await request(service.app)
          .get(`/api/invites/${res.body.token}`)
          .set(auth("bob"))
      ).status,
    ).toBe(410);
  });
  it("rejects malformed/oversized payloads and persists no transcript", async () => {
    expect(
      (
        await request(service.app)
          .post("/api/calls/start")
          .set(auth())
          .send({ callee: "bob", text: "private" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(service.app)
          .post("/api/users/username")
          .set(auth())
          .send({ username: "x".repeat(40000) })
      ).status,
    ).toBe(413);
    expect(JSON.stringify([...store.data])).not.toMatch(
      /transcript|translated_text/,
    );
  });
  it("authenticates sockets and relays only participant signaling", async () => {
    await new Promise<void>((resolve) =>
      service.http.listen(0, "127.0.0.1", resolve),
    );
    const port = (service.http.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    const bad = client(url, {
      transports: ["websocket"],
      auth: { token: "bad" },
      reconnection: false,
    });
    await new Promise<void>((resolve) =>
      bad.on("connect_error", () => resolve()),
    );
    bad.close();
    const a = client(url, {
        transports: ["websocket"],
        auth: { token: "alice" },
      }),
      b = client(url, { transports: ["websocket"], auth: { token: "bob" } }),
      e = client(url, { transports: ["websocket"], auth: { token: "eve" } });
    await Promise.all(
      [a, b, e].map(
        (s) => new Promise<void>((resolve) => s.on("connect", resolve)),
      ),
    );
    const c = (await start()).body;
    await service.calls.change("bob", c.id, "accept");
    const payload = {
      callId: c.id,
      eventId: crypto.randomUUID(),
      kind: "offer",
      sdp: "v=0\r\n",
    };
    expect((await new Promise<any>((resolve) =>
      a.emit("call:heartbeat", { callId: c.id }, resolve))).ok).toBe(true);
    expect((await new Promise<any>((resolve) =>
      e.emit("call:heartbeat", { callId: c.id }, resolve))).ok).toBe(false);
    const received = new Promise<any>((resolve) =>
      b.once("webrtc:signal", resolve),
    );
    a.emit("webrtc:signal", payload);
    expect((await received).sdp).toBe(payload.sdp);
    const denied = await new Promise<any>((resolve) =>
      e.emit(
        "webrtc:signal",
        { ...payload, eventId: crypto.randomUUID() },
        resolve,
      ),
    );
    expect(denied.ok).toBe(false);
    const malformed = await new Promise<any>((resolve) =>
      a.emit("webrtc:signal", { ...payload, text: "private" }, resolve),
    );
    expect(malformed.ok).toBe(false);
    a.close();
    b.close();
    e.close();
  });
});
