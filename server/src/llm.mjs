/**
 * OpenAI-compatible LLM client for the homelab LLM (PLAN §9).
 * Used by the Turn Router (blocking, short timeout), Judge (non-blocking),
 * and intake classifier. Reads LLM_BASE_URL / LLM_API_KEY / LLM_MODEL from env.
 */

const NOOP = () => {};

/**
 * Call the LLM chat completions endpoint.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ model?: string, temperature?: number, jsonMode?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<string>} The assistant's text content.
 */
export async function chatCompletion(messages, opts = {}) {
  const baseUrl = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw Object.assign(new Error("LLM not configured (LLM_BASE_URL)"), { status: 501 });
  }
  const apiKey = process.env.LLM_API_KEY || "";
  const model = opts.model || process.env.LLM_MODEL || "granite3.3-8b";
  const temperature = opts.temperature ?? 0.1;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const start = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const elapsed = Date.now() - start;
  if (!res.ok) {
    const detail = (await res.text().catch(NOOP)).slice(0, 500);
    console.error(`[llm] ${model} ${res.status} ${elapsed}ms: ${detail}`);
    throw Object.assign(new Error(`LLM failed (${res.status}): ${detail}`), { status: 502 });
  }

  const payload = await res.json();
  const content = payload.choices?.[0]?.message?.content || "";
  console.log(`[llm] ${model} ok ${elapsed}ms`);
  return content;
}

/**
 * Call the LLM and parse the response as JSON. Throws if the response
 * is not valid JSON.
 */
export async function chatJSON(messages, opts = {}) {
  const content = await chatCompletion(messages, { ...opts, jsonMode: true });
  try {
    return JSON.parse(content);
  } catch {
    // Some models wrap JSON in markdown fences or prose.
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`LLM returned non-JSON: ${content.slice(0, 200)}`);
  }
}
