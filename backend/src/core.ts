import { z } from "zod";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{2,23}$/);
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export type Profile = { uid: string; username: string; displayName: string };
export type Call = {
  id: string;
  caller: string;
  callee: string;
  callerName: string;
  calleeName: string;
  kind: "audio" | "video";
  state: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  endedAt: number | null;
};
export interface Transaction {
  get<T>(path: string): Promise<T | undefined>;
  set(path: string, value: object): void;
  delete(path: string): void;
}
export interface Store {
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  get<T>(path: string): Promise<T | undefined>;
  list<T>(collection: string, limit?: number): Promise<T[]>;
}
export interface Auth {
  verify(token: string): Promise<{ uid: string; exp: number }>;
}
export interface Push {
  incoming(uid: string, call: Call): Promise<void>;
  ended(uid: string, call: Call): Promise<void>;
}
export const terminal = new Set([
  "ended",
  "rejected",
  "cancelled",
  "missed",
  "failed",
]);
export function participant(
  call: Call | undefined,
  uid: string,
): asserts call is Call {
  if (!call || (call.caller !== uid && call.callee !== uid))
    throw new ApiError(404, "call_not_found");
}
