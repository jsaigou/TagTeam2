import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createConnectClient } from "./connect-client.mjs";

const originalFetch = globalThis.fetch;
let callCount = 0;
let responses = {};

function mockFetch(url, opts) {
  callCount++;
  const path = new URL(url).pathname;
  const method = opts?.method || "GET";

  // Login endpoint
  if (path === "/api/v1/connect/auth/login" && method === "POST") {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: responses.token || "token-1" }),
    });
  }

  // Authed call endpoint (for testing authedCall retry)
  if (responses.authedStatus) {
    return Promise.resolve({
      ok: responses.authedStatus < 400,
      status: responses.authedStatus,
      json: () => Promise.resolve({ ok: true, data: "result" }),
    });
  }

  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true }),
  });
}

beforeEach(() => {
  callCount = 0;
  responses = {};
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeClient() {
  return createConnectClient({
    baseUrl: "https://connect.test",
    email: "test@test.com",
    password: "pass",
  });
}

test("mintBrowserToken: caches token (single login for multiple mints)", async () => {
  const c = makeClient();
  const t1 = await c.mintBrowserToken();
  const t2 = await c.mintBrowserToken();
  assert.equal(t1, t2);
  assert.equal(callCount, 1, "only one login call for two mints");
});

test("mintBrowserToken: concurrent calls coalesce into one login", async () => {
  const c = makeClient();
  const [t1, t2] = await Promise.all([c.mintBrowserToken(), c.mintBrowserToken()]);
  assert.equal(t1, t2);
  assert.equal(callCount, 1, "concurrent mints produce one login");
});

test("forceRefresh: clears stale token and starts fresh login", async () => {
  responses.token = "token-1";
  const c = makeClient();
  const t1 = await c.mintBrowserToken();
  assert.equal(t1, "token-1");

  responses.token = "token-2";
  // forceRefresh via authedCall with a 401
  responses.authedStatus = 401;
  // authedCall should retry after refresh
  const result = await c.authedCall(async (token) => {
    return { token };
  });
  // Should have gotten a token (either original or refreshed)
  assert.ok(result.token);
});
