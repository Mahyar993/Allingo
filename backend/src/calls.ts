import { randomUUID } from "node:crypto";
import {
  ApiError,
  participant,
  terminal,
  type Call,
  type Store,
  type Profile,
  type Push,
} from "./core.js";
export class Calls {
  onUpdate: (call: Call) => void = () => {};
  constructor(
    private store: Store,
    private push: Push,
    private ringSeconds: number,
  ) {}
  async start(
    uid: string,
    callee: string,
    kind: "audio" | "video",
    requestId: string,
  ) {
    if (uid === callee) throw new ApiError(400, "self_call");
    const call = await this.store.transaction(async (tx) => {
      const previous = await tx.get<{ callId: string }>(
        `requests/${uid}_${requestId}`,
      );
      if (previous) {
        const old = await tx.get<Call>(`activeCalls/${previous.callId}`);
        if (old) return old;
        throw new ApiError(409, "request_completed");
      }
      const a = await tx.get<Profile>(`users/${uid}`),
        b = await tx.get<Profile>(`users/${callee}`);
      const la = await tx.get(`busy/${uid}`),
        lb = await tx.get(`busy/${callee}`);
      if (!a || !b) throw new ApiError(404, "user_not_found");
      if (la || lb) throw new ApiError(409, "user_busy");
      const now = Date.now();
      const c: Call = {
        id: randomUUID(),
        caller: uid,
        callee,
        callerName: a.displayName,
        calleeName: b.displayName,
        kind,
        state: "ringing",
        createdAt: now,
        expiresAt: now + this.ringSeconds * 1000,
        acceptedAt: null,
        endedAt: null,
      };
      tx.set(`activeCalls/${c.id}`, c);
      tx.set(`busy/${uid}`, { callId: c.id });
      tx.set(`busy/${callee}`, { callId: c.id });
      tx.set(`requests/${uid}_${requestId}`, {
        id: `${uid}_${requestId}`,
        callId: c.id,
        expiresAt: now + 86400000,
      });
      return c;
    });
    this.onUpdate(call);
    void this.push.incoming(callee, call).catch(() => {});
    return call;
  }
  async get(uid: string, callId: string) {
    const c =
      (await this.store.get<Call>(`activeCalls/${callId}`)) ??
      (await this.store.get<Call>(`callHistory/${uid}/items/${callId}`));
    participant(c, uid);
    return c;
  }
  async active(uid: string) {
    const b = await this.store.get<{ callId: string }>(`busy/${uid}`);
    return b ? this.store.get<Call>(`activeCalls/${b.callId}`) : null;
  }
  async change(uid: string, callId: string, action: string, system = false) {
    const c = await this.store.transaction(async (tx) => {
      const current =
        (await tx.get<Call>(`activeCalls/${callId}`)) ??
        (await tx.get<Call>(`callHistory/${uid}/items/${callId}`));
      participant(current, uid);
      if (terminal.has(current.state)) return current;
      // The sweep's list is only a snapshot. An accept or heartbeat may have
      // renewed this call before this transaction acquired its current value.
      if (system && ["timeout", "fail"].includes(action) &&
          (current.expiresAt > Date.now() ||
           (action === "timeout" && current.state !== "ringing"))) return current;
      if (
        !system &&
        (action === "accept" || action === "reject") &&
        current.callee !== uid
      )
        throw new ApiError(403, "callee_only");
      if (!system && action === "cancel" && current.caller !== uid)
        throw new ApiError(403, "caller_only");
      if (
        ["accept", "reject", "cancel"].includes(action) &&
        current.state !== "ringing"
      ) {
        if (action === "accept" && current.state === "connected")
          return current;
        throw new ApiError(409, "invalid_call_state");
      }
      const now = Date.now();
      const expired = current.state === "ringing" && current.expiresAt <= now;
      const state = expired
        ? "missed"
        : (
            {
              accept: "connected",
              reject: "rejected",
              cancel: "cancelled",
              end: "ended",
              timeout: "missed",
              fail: "failed",
            } as Record<string, string>
          )[action];
      if (!state) throw new ApiError(400, "invalid_action");
      const next = {
        ...current,
        state,
        ...(system && state === "failed" ? { endReason: "session_expired" } : {}),
        acceptedAt: state === "connected" ? now : current.acceptedAt,
        endedAt: terminal.has(state) ? now : null,
        expiresAt: now + 120000,
      };
      if (terminal.has(state)) {
        for (const user of [current.caller, current.callee]) {
          tx.delete(`busy/${user}`);
          tx.set(`callHistory/${user}/items/${callId}`, {
            ...next,
            direction: user === current.caller ? "outgoing" : "incoming",
            peerUid: user === current.caller ? current.callee : current.caller,
            peerName:
              user === current.caller ? current.calleeName : current.callerName,
            durationSeconds: next.acceptedAt
              ? Math.max(0, Math.round((now - next.acceptedAt) / 1000))
              : 0,
          });
        }
        tx.delete(`activeCalls/${callId}`);
      } else tx.set(`activeCalls/${callId}`, next);
      return next;
    });
    this.onUpdate(c);
    if (terminal.has(c.state))
      void this.push.ended(c.callee, c).catch(() => {});
    return c;
  }
  async heartbeat(uid: string, callId: string) {
    await this.store.transaction(async (tx) => {
      const c = await tx.get<Call>(`activeCalls/${callId}`);
      participant(c, uid);
      if (c.state !== "connected") throw new ApiError(409, "invalid_call_state");
      tx.set(`activeCalls/${callId}`, {
          ...c,
          expiresAt: Date.now() + 120000,
        });
    });
  }
  async sweep() {
    const calls = await this.store.list<Call>("activeCalls", 500);
    for (const c of calls)
      if (c.expiresAt < Date.now())
        await this.change(
          c.caller,
          c.id,
          c.state === "ringing" ? "timeout" : "fail",
          true,
        ).catch(() => {});
  }
}
