import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { createHash } from "node:crypto";
import type { Auth, Store, Transaction, Push, Call } from "./core.js";
export function firebase(projectId: string): {
  store: Store;
  auth: Auth;
  push: Push;
} {
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  initializeApp({
    projectId,
    ...(!emulator
      ? {
          credential: process.env.FIREBASE_PRIVATE_KEY
            ? cert({
                projectId,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(
                  /\\n/g,
                  "\n",
                ),
              })
            : applicationDefault(),
        }
      : {}),
  });
  const db = getFirestore();
  const store: Store = {
    async get<T>(path: string) {
      const s = await db.doc(path).get();
      return s.exists ? (s.data() as T) : undefined;
    },
    async list<T>(collection: string, limit = 100) {
      const query = db.collection(collection);
      return (
        await (
          collection.startsWith("callHistory/")
            ? query.orderBy("createdAt", "desc")
            : ["invites", "requests", "activeCalls"].includes(collection)
              ? query.orderBy("expiresAt", "asc")
              : query
        )
          .limit(limit)
          .get()
      ).docs.map((s) => s.data() as T);
    },
    transaction<T>(fn: (tx: Transaction) => Promise<T>) {
      return db.runTransaction((tx) =>
        fn({
          get: async <V>(path: string) => {
            const s = await tx.get(db.doc(path));
            return s.exists ? (s.data() as V) : undefined;
          },
          set: (p, v) => {
            tx.set(db.doc(p), v);
          },
          delete: (p) => {
            tx.delete(db.doc(p));
          },
        }),
      );
    },
  };
  async function send(uid: string, call: Call, type: string) {
    if (emulator) return; // FCM has no official local emulator; never fake delivery.
    const tokens = await store.list<{ token: string }>(
      `deviceTokens/${uid}/items`,
      10,
    );
    if (!tokens.length) return;
    const result = await getMessaging().sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      data: {
        type,
        callId: call.id,
        callerName: call.callerName,
        kind: call.kind,
        expiresAt: String(call.expiresAt),
      },
      android: {
        priority: "high",
        ttl:
          type === "incoming_call"
            ? Math.max(0, call.expiresAt - Date.now())
            : 30000,
      },
    });
    await Promise.all(
      result.responses.map(async (r, i) => {
        if (
          r.error &&
          [
            "messaging/registration-token-not-registered",
            "messaging/invalid-registration-token",
          ].includes(r.error.code)
        ) {
          const t = tokens[i]!;
          await db
            .doc(
              `deviceTokens/${uid}/items/${createHash("sha256").update(t.token).digest("hex")}`,
            )
            .delete();
        }
      }),
    );
  }
  return {
    store,
    auth: {
      async verify(token) {
        const d = await getAuth().verifyIdToken(token, !emulator);
        return { uid: d.uid, exp: d.exp };
      },
    },
    push: {
      incoming: (uid, c) => send(uid, c, "incoming_call"),
      ended: (uid, c) => send(uid, c, "call_ended"),
    },
  };
}
