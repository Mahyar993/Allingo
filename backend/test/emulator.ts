import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { firebase } from "../src/firebase.js";
import { getFirestore } from "firebase-admin/firestore";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
const service = createApp(
  {
    NODE_ENV: "test",
    PORT: 3000,
    PUBLIC_BASE_URL: "http://localhost:3000",
    FIREBASE_PROJECT_ID: "demo-allingo",
    CALL_RING_TIMEOUT_SECONDS: 45,
    INVITE_EXPIRY_MINUTES: 15,
    TRUST_PROXY: 0,
  },
  firebase("demo-allingo"),
);
await new Promise<void>((resolve) =>
  service.http.listen(0, "127.0.0.1", resolve),
);
const base = `http://127.0.0.1:${(service.http.address() as { port: number }).port}`;
async function account(label: string) {
  const r = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `${label}-${Date.now()}@allingo.test`,
        password: "LocalTestPassword123!",
        returnSecureToken: true,
      }),
    },
  );
  assert.equal(r.status, 200);
  return (await r.json()) as { idToken: string; localId: string };
}
async function api(path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as any };
}
try {
  const a = await account("caller"),
    b = await account("callee");
  const suffix = Date.now().toString().slice(-9);
  assert.equal(
    (await api("/api/users/username", a.idToken, { username: "a" + suffix }))
      .status,
    200,
  );
  assert.equal(
    (await api("/api/users/username", b.idToken, { username: "b" + suffix }))
      .status,
    200,
  );
  assert.equal((await api("/api/users/me", "forged")).status, 401);
  const responses = await Promise.all(
    [a, b].map((u) =>
      api("/api/users/username", u.idToken, { username: "race" + suffix }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const c = await api("/api/calls/start", a.idToken, {
    callee: b.localId,
    kind: "video",
    requestId: crypto.randomUUID(),
  });
  assert.equal(c.status, 200);
  assert.equal(
    (await api(`/api/calls/${c.body.id}/accept`, a.idToken, {})).status,
    403,
  );
  assert.equal(
    (await api(`/api/calls/${c.body.id}/accept`, b.idToken, {})).body.state,
    "connected",
  );
  assert.equal(
    (await api(`/api/calls/${c.body.id}/end`, a.idToken, {})).body.state,
    "ended",
  );
  assert.equal(
    (await api("/api/call-history", b.idToken)).body[0].direction,
    "incoming",
  );
  const docs = await getFirestore().collection("activeCalls").get();
  assert.equal(docs.docs.filter((d) => d.id === c.body.id).length, 0);
  console.log(
    "PASS: real Auth + Firestore emulators: tokens, concurrent username transaction, call lifecycle, roles, history and cleanup (9 assertions).",
  );
} finally {
  await service.close();
}
