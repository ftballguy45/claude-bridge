/**
 * Subscription usage — current-window utilization vs. limits.
 *
 * Claude Code's `/usage` numbers come from `anthropic-ratelimit-unified-*` HEADERS
 * on inference responses. The dedicated `/api/oauth/usage` endpoint needs a
 * `user:profile` scope that `claude setup-token` tokens DON'T carry (403), but a
 * normal `POST /v1/messages` with the OAuth bearer + `anthropic-beta: oauth-2025-04-20`
 * returns those headers just fine. So we harvest them with a tiny, cached probe
 * rather than parsing any account endpoint.
 *
 * The number is ACCOUNT-WIDE (shared by every bridge instance + interactive Claude
 * Code on the same subscription), not per-container.
 */

const USAGE_TTL_MS = parseInt(process.env.USAGE_CACHE_MS ?? "120000", 10); // 2 min
const CLAUDE_CODE_UA = process.env.CLAUDE_CODE_UA ?? "claude-code/2.1.80";
const PROBE_MODEL = process.env.USAGE_PROBE_MODEL ?? "claude-haiku-4-5";

export interface WindowUsage {
  /** Raw 0..1 utilization from the header. */
  utilization: number;
  /** Convenience 0..100, rounded to 1 decimal. */
  usedPercent: number;
  /** e.g. "allowed" | "rejected". */
  status: string;
  /** ISO 8601 reset time, or null if the header was absent. */
  resetsAt: string | null;
  /** Seconds until reset, or null. */
  resetsInSeconds: number | null;
}

export interface UsageSnapshot {
  fiveHour: WindowUsage | null;
  sevenDay: WindowUsage | null;
  /** Overall unified status header. */
  status: string | null;
  /** When these numbers were actually fetched from Anthropic. */
  fetchedAt: string;
  /** True when served from the in-memory cache rather than a fresh probe. */
  cached: boolean;
  /** True when a refresh failed and we're serving the last good value. */
  stale?: boolean;
  error?: string;
}

let cache: UsageSnapshot | null = null;
let cacheAt = 0;
let inFlight: Promise<UsageSnapshot> | null = null;

function parseWindow(headers: Headers, prefix: "5h" | "7d"): WindowUsage | null {
  const util = headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
  if (util == null) return null;

  const utilization = parseFloat(util);
  const reset = headers.get(`anthropic-ratelimit-unified-${prefix}-reset`);
  const resetEpoch = reset ? parseInt(reset, 10) : null;
  const nowSec = Math.floor(Date.now() / 1000);

  return {
    utilization,
    usedPercent: Math.round(utilization * 1000) / 10,
    status: headers.get(`anthropic-ratelimit-unified-${prefix}-status`) ?? "unknown",
    resetsAt: resetEpoch ? new Date(resetEpoch * 1000).toISOString() : null,
    resetsInSeconds: resetEpoch ? Math.max(0, resetEpoch - nowSec) : null,
  };
}

async function probe(token: string): Promise<UsageSnapshot> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // Required — without a claude-code/* User-Agent the OAuth path is rejected.
      "User-Agent": CLAUDE_CODE_UA,
    },
    // Smallest possible generation — we only want the response headers.
    body: JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    }),
  });

  // Drain the body so the socket is released; we don't use it.
  await res.text().catch(() => "");

  if (res.status !== 200) {
    throw new Error(`usage probe HTTP ${res.status}`);
  }

  const h = res.headers;
  return {
    fiveHour: parseWindow(h, "5h"),
    sevenDay: parseWindow(h, "7d"),
    status: h.get("anthropic-ratelimit-unified-status"),
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
}

/**
 * Current-window subscription usage, cached for USAGE_CACHE_MS. Concurrent callers
 * within a refresh share one in-flight probe. On probe failure the last good value
 * is served with `stale: true` rather than throwing.
 */
export async function getUsage(): Promise<UsageSnapshot> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    return {
      fiveHour: null,
      sevenDay: null,
      status: null,
      fetchedAt: new Date().toISOString(),
      cached: false,
      error: "CLAUDE_CODE_OAUTH_TOKEN not set",
    };
  }

  if (cache && Date.now() - cacheAt < USAGE_TTL_MS) {
    return { ...cache, cached: true };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const snap = await probe(token);
      cache = snap;
      cacheAt = Date.now();
      return snap;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (cache) return { ...cache, cached: true, stale: true, error: msg };
      return {
        fiveHour: null,
        sevenDay: null,
        status: null,
        fetchedAt: new Date().toISOString(),
        cached: false,
        error: msg,
      };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
