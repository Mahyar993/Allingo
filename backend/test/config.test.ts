import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

describe("production deployment configuration", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FIREBASE_PROJECT_ID", "allingo-test-project");
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://allingo-test.onrender.com");
    vi.stubEnv("PUBLIC_BASE_URL", undefined);
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", undefined);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("starts on Render without requiring the generated URL in advance", () => {
    expect(loadConfig().PUBLIC_BASE_URL).toBe("https://allingo-test.onrender.com");
    vi.stubEnv("PUBLIC_BASE_URL", "   ");
    expect(loadConfig().PUBLIC_BASE_URL).toBe("https://allingo-test.onrender.com");
  });

  it("preserves an explicit custom domain", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://calls.example.com");
    expect(loadConfig().PUBLIC_BASE_URL).toBe("https://calls.example.com");
  });

  it("rejects an insecure explicit URL even if a Render URL is available", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(() => loadConfig()).toThrow("Set PUBLIC_BASE_URL to an HTTPS URL");
  });

  it("still requires HTTPS outside Render", () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", undefined);
    expect(() => loadConfig()).toThrow("Set PUBLIC_BASE_URL to an HTTPS URL");
    vi.stubEnv("NODE_ENV", "development");
    expect(loadConfig().PUBLIC_BASE_URL).toBe("http://localhost:3000");
  });

  it("reports every unsafe Firebase setting without disclosing their values", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "demo-allingo");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "private-auth-host:9099");
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "private-db-host:8080");
    expect(() => loadConfig()).toThrow("Remove FIREBASE_AUTH_EMULATOR_HOST");
    expect(() => loadConfig()).toThrow("Remove FIRESTORE_EMULATOR_HOST");
    expect(() => loadConfig()).toThrow("Set FIREBASE_PROJECT_ID");
    try {
      loadConfig();
    } catch (error) {
      expect(String(error)).not.toContain("private-auth-host");
      expect(String(error)).not.toContain("private-db-host");
    }
  });
});
