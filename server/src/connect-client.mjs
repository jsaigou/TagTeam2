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
  let loginPromise = null;

  async function login() {
    const body = await call("/api/v1/connect/auth/login", {
      method: "POST",
      body: { email, password },
    });
    return body.access_token;
  }

  function getToken({ forceRefresh = false } = {}) {
    if (cachedToken && !forceRefresh) return Promise.resolve(cachedToken);
    if (forceRefresh) {
      cachedToken = null;
      loginPromise = null;
    }
    if (!loginPromise) {
      loginPromise = login()
        .then((token) => {
          cachedToken = token;
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
