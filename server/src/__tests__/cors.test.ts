import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { corsOptions, isAllowedOrigin } from "../cors.ts";

// docs/specs/cross-cutting/security.md — "CORS lets any origin drive the API"
//
// Fix: allow only the localhost dev origins we own. Reject everything
// else, including known cloud editors and any origin not in the set.
//
// The policy is a pure function so the unit test is trivial; the
// integration test wires the policy through @fastify/cors and asserts
// the response header matrix via app.inject() — no real network.

describe("isAllowedOrigin — pure policy", () => {
  it("allows the Vite dev origins (localhost / 127.0.0.1 / [::1] on :5173)", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5173")).toBe(true);
  });

  it("allows direct browsing of the server itself on :8787", () => {
    expect(isAllowedOrigin("http://localhost:8787")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8787")).toBe(true);
  });

  it("treats a missing Origin (same-origin / non-browser) as allowed", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("")).toBe(true);
  });

  it("rejects HTTPS variants — we are local-only HTTP, do not invite confusion", () => {
    expect(isAllowedOrigin("https://localhost:5173")).toBe(false);
  });

  it("rejects an unknown origin (DNS-rebinding / hostile-page case)", () => {
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("http://attacker.local")).toBe(false);
  });

  it("rejects same hostname with a port we do not own", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
    expect(isAllowedOrigin("http://localhost:5174")).toBe(false);
  });

  it("rejects subdomains of localhost (file:// hosts and similar gotchas)", () => {
    expect(isAllowedOrigin("http://api.localhost:5173")).toBe(false);
    expect(isAllowedOrigin("file://")).toBe(false);
  });

  it("does string-equality match — does not normalise trailing slashes or case", () => {
    // Browsers always send a normalised origin (no trailing slash, lowercase
    // scheme/host). We deliberately match exactly to avoid normalisation
    // surprises.
    expect(isAllowedOrigin("http://localhost:5173/")).toBe(false);
    expect(isAllowedOrigin("HTTP://localhost:5173")).toBe(false);
  });
});

describe("CORS — wired through @fastify/cors", () => {
  async function buildApp() {
    const app = Fastify();
    await app.register(cors, corsOptions);
    app.get("/ping", async () => ({ ok: true }));
    return app;
  }

  it("echoes the Origin header for an allowed origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    await app.close();
  });

  it("does NOT echo Origin (or sends a deny) for a disallowed origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { origin: "https://evil.example.com" },
    });
    // The fetch from evil.example.com still resolves (CORS is enforced by
    // the browser, not the server), but ACAO must not be set to the
    // hostile origin — that is what would let DNS-rebinding read the
    // body.
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
    await app.close();
  });

  it("preflight (OPTIONS) for an allowed origin returns ACAO and ACAM", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/ping",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-methods"]).toBeDefined();
    await app.close();
  });

  it("requests with no Origin header still work (server-to-server / curl / SSE clients)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    await app.close();
  });
});
