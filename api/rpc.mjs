/**
 * The relay behind "Connect wallet".
 *
 * The positions read happens in the browser, and Solana's public endpoint refuses
 * browser origins outright: a cross-origin POST from the page comes back 403 with
 * `Access forbidden`, so the connect flow could never work against it however many
 * times a reader retried. Every keyless public endpoint tested has the same
 * problem in some form - PublicNode answers `getSlot` and then refuses the indexed
 * method this read needs, OnFinality rate-limits, SolanaTracker blocks the method,
 * dRPC wants a paid plan - and a keyed endpoint would put a billable key in a
 * public page. So the read goes through this same-origin relay, which is also why
 * the page no longer asks the reader to supply an RPC URL of their own.
 *
 * It is deliberately not an open proxy: POST only, one method, no logging of the
 * request body, an 8s timeout, and a per-instance rate limit.
 */
const ALLOWED = new Set(["getTokenAccountsByOwner"]);
const UPSTREAM = process.env.OWED_RPC_URL || "https://api.mainnet-beta.solana.com";
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
// Vercel may run several instances of this function, and this map is per instance.
// That makes the limit approximate on purpose: it is a guard rail against the relay
// being used as a free RPC by a script, not an accounting system.
const seen = new Map();

function parseBody(body) {
  if (body && typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "the relay takes POST only" });
    return;
  }

  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    res.status(429).json({ error: "too many reads from this address; wait a minute" });
    return;
  }
  recent.push(now);
  seen.set(ip, recent);

  const body = parseBody(req.body);
  if (!body || !ALLOWED.has(body.method)) {
    res.status(403).json({ error: `method not allowed: ${body?.method ?? "unreadable body"}` });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: body.method, params: body.params ?? [] }),
      signal: controller.signal,
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json").send(text);
  } catch (err) {
    res.status(502).json({ error: `relay could not reach the node (${err?.name ?? "error"})` });
  } finally {
    clearTimeout(timer);
  }
}
