// SHIP-01: thin Shiprocket client. Keeps the real HTTP call to Shiprocket in one
// spot so retries, logging and replay-safety are testable.
//
// Right now this is a stub — the real call is left as a TODO because the
// Shiprocket credentials aren't in this workspace. Fill in `callShiprocket`
// against the Shiprocket Track API once you have the SHIPROCKET_TOKEN env var.

const MAX_ATTEMPTS = 8;
// Exponential backoff in seconds for attempts 1..8.
const BACKOFF_S = [60, 180, 600, 1800, 3600, 7200, 14400, 28800];

export function nextRetryAt(attempt) {
  const i = Math.max(0, Math.min(attempt - 1, BACKOFF_S.length - 1));
  return new Date(Date.now() + BACKOFF_S[i] * 1000).toISOString();
}

export function isExhausted(attempts) {
  return attempts >= MAX_ATTEMPTS;
}

// Actual Shiprocket call. Return { ok: true } on success, { ok: false, err } on failure.
export async function callShiprocket(event) {
  // TODO (SHIP-01): replace with real Shiprocket Track API call. Example contract:
  //   const r = await fetch(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${event.awb}`,
  //     { headers: { Authorization: `Bearer ${process.env.SHIPROCKET_TOKEN}` } });
  //   if (!r.ok) return { ok: false, err: `HTTP ${r.status}` };
  //   return { ok: true, data: await r.json() };
  if (!process.env.SHIPROCKET_TOKEN) {
    return { ok: false, err: 'SHIPROCKET_TOKEN not set; call deferred' };
  }
  return { ok: false, err: 'Shiprocket client not implemented yet' };
}

export { MAX_ATTEMPTS };
