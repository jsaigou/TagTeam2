/**
 * Perxona Connect API client + shared token manager.
 * ONE shared Connect identity (from env) mints browser-facing connect_tokens.
 * Adapted from the pattern validated in the old TagTeam repo + connect-kit.
 */

export function createConnectClient({ baseUrl, email, password }) {
  async function call(path, { token, method = "GET", body, timeoutMs = 20_000 } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`Connect upstream ${res.status}`), {
        status: res.status,
        payload,
      });
    }
    return res.json();
  }

  let cachedToken = null;
  let cachedExpiresAt = 0;
  let loginPromise = null;

  async function login() {
    const body = await call("/api/v1/connect/auth/login", {
      method: "POST",
      body: { email, password },
    });
    return body.access_token;
  }

  /** Decode a JWT's `exp` (seconds) without verifying the signature — we
   *  trust it because we just minted it ourselves. Returns 0 (treated as
   *  already-expired) if the token can't be parsed. */
  function expiryOf(token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
    } catch {
      return 0;
    }
  }

  // Refresh this long before actual expiry: mintBrowserToken (the
  // browser-facing path) never itself talks to the upstream, so nothing else
  // catches a 401 to trigger a reactive refresh on that path — a cached
  // token that outlives its exp would otherwise get handed to every browser
  // client until something else forces a refresh.
  const EXPIRY_SKEW_MS = 5 * 60_000;

  function getToken({ forceRefresh = false } = {}) {
    const stale = !cachedToken || Date.now() >= cachedExpiresAt - EXPIRY_SKEW_MS;
    if (cachedToken && !forceRefresh && !stale) return Promise.resolve(cachedToken);
    if (forceRefresh || stale) {
      cachedToken = null;
      cachedExpiresAt = 0;
      loginPromise = null;
    }
    if (!loginPromise) {
      loginPromise = login()
        .then((token) => {
          cachedToken = token;
          cachedExpiresAt = expiryOf(token);
          return token;
        })
        .finally(() => {
          loginPromise = null;
        });
    }
    return loginPromise;
  }

  /** Run fn with a valid token, retrying once after a 401/403 refresh. */
  async function authedCall(fn) {
    const token = await getToken();
    try {
      return await fn(token);
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err;
      const fresh = await getToken({ forceRefresh: true });
      return fn(fresh);
    }
  }

  // Public: mint a token for the browser presenter.
  async function mintBrowserToken() {
    return getToken();
  }

  return { authedCall, mintBrowserToken };
}
