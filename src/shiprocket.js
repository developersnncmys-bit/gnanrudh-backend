// SHIP-01 / SHIP-02: Shiprocket client.
//
// Credentials live in environment variables (not the admin Settings
// singleton) so staff can't see or rotate them from the admin UI:
//
//   SHIPROCKET_EMAIL             — the Shiprocket account email
//   SHIPROCKET_PASSWORD          — the Shiprocket account password
//   SHIPROCKET_PICKUP_LOCATION   — nickname of the pickup you set up on
//                                  Shiprocket's dashboard. Defaults to
//                                  "Primary" if the env var isn't set.
//   SHIPROCKET_ENABLED           — optional kill-switch. Set to "false"
//                                  to disable pushes without removing
//                                  the credentials (useful in staging).
//
// API endpoints we call for a storefront order:
//   1. POST /v1/external/auth/login              → bearer token (10-day life)
//   2. POST /v1/external/orders/create/adhoc     → register order + items
//
// AWB assignment and pickup scheduling are intentionally NOT automated
// — staff do those from the Shiprocket dashboard per order.
//
// The bearer token is cached in-memory (module-level) with a 9-day TTL
// — one day shy of Shiprocket's 10-day expiry. A cold start re-logs in;
// an auth-expired response forces a re-login and retries the call once.
// Every call is non-throwing: the returned envelope is
// `{ ok, data?, err?, httpStatus? }`. Push failures record an error on
// the Order so the admin can retry from the drawer.

const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000; // 9 days

const MAX_ATTEMPTS = 8;
const BACKOFF_S = [60, 180, 600, 1800, 3600, 7200, 14400, 28800];

export function nextRetryAt(attempt) {
  const i = Math.max(0, Math.min(attempt - 1, BACKOFF_S.length - 1));
  return new Date(Date.now() + BACKOFF_S[i] * 1000).toISOString();
}

export function isExhausted(attempts) {
  return attempts >= MAX_ATTEMPTS;
}

export { MAX_ATTEMPTS };

/* ---------- Env credentials ---------- */

function readShiprocketCreds() {
  const enabledEnv = String(process.env.SHIPROCKET_ENABLED || '').toLowerCase();
  const explicitlyDisabled = enabledEnv === 'false' || enabledEnv === '0' || enabledEnv === 'off';
  const email = String(process.env.SHIPROCKET_EMAIL || '').trim();
  const password = String(process.env.SHIPROCKET_PASSWORD || '').trim();
  const pickupLocation = String(process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary').trim();
  return {
    enabled: Boolean(email && password) && !explicitlyDisabled,
    email,
    password,
    pickupLocation,
  };
}

export function isShiprocketConfigured() {
  return readShiprocketCreds().enabled;
}

/* ---------- Token cache (in-memory) ---------- */

let cachedToken = null;         // string
let cachedTokenExpiresAt = 0;   // epoch ms

async function login(email, password) {
  const r = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) return { ok: false, err: j.message || `HTTP ${r.status}`, httpStatus: r.status };
  return { ok: true, token: j.token };
}

async function getToken(forceRefresh = false) {
  const creds = readShiprocketCreds();
  if (!creds.email || !creds.password) {
    return { ok: false, err: 'Shiprocket credentials missing. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in the backend env.' };
  }
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedTokenExpiresAt > now) {
    return { ok: true, token: cachedToken };
  }
  const login_ = await login(creds.email, creds.password);
  if (!login_.ok) return login_;
  cachedToken = login_.token;
  cachedTokenExpiresAt = now + TOKEN_TTL_MS;
  return { ok: true, token: cachedToken };
}

/* ---------- Generic request (handles 401 re-login) ---------- */

async function request(path, { method = 'POST', body } = {}) {
  let tokenRes = await getToken(false);
  if (!tokenRes.ok) return tokenRes;
  let r = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenRes.token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 401 → cached token expired / revoked server-side. Force re-login
  // and retry once.
  if (r.status === 401) {
    cachedToken = null;
    cachedTokenExpiresAt = 0;
    tokenRes = await getToken(true);
    if (!tokenRes.ok) return tokenRes;
    r = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenRes.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, err: j.message || JSON.stringify(j).slice(0, 200) || `HTTP ${r.status}`, httpStatus: r.status, data: j };
  return { ok: true, data: j };
}

/* ---------- Public surface ---------- */

// Admin-callable "Test connection" — just tries to auth.
export async function testConnection() {
  const t = await getToken(true);
  if (!t.ok) return t;
  return { ok: true };
}

export async function createAdhocOrder(orderPayload) {
  const r = await request('/orders/create/adhoc', { body: orderPayload });
  // Shiprocket sometimes returns 200 with an error `message` and no
  // order_id / shipment_id (e.g. "Wrong Pickup location entered"). Treat
  // that as a failure so the caller doesn't mark the order as pushed
  // and the admin drawer surfaces the real reason via pushError.
  if (r.ok && !r.data?.order_id && !r.data?.shipment_id) {
    return { ok: false, err: r.data?.message || 'Shiprocket returned 200 with no order_id', httpStatus: 200, data: r.data };
  }
  return r;
}

export async function cancelShiprocketOrder(shiprocketOrderId) {
  return request('/orders/cancel', { body: { ids: [shiprocketOrderId] } });
}

/* ---------- Order → Shiprocket payload ---------- */

export function buildAdhocOrderPayload({ order, customer, products }) {
  const creds = readShiprocketCreds();
  const pickup = creds.pickupLocation || 'Primary';
  const addr = order.ship || {};
  // Customer.addresses is a Number (legacy count); the real address array
  // is Customer.addressBook. Match on `pin` (schema field), not `pincode`.
  const addressBook = Array.isArray(customer?.addressBook) ? customer.addressBook : [];
  const shipAddress = addressBook.find((a) => a.pin === addr.pin) || addressBook[0] || {};
  const billing = order.billingGstin
    ? {
      billing_customer_name: order.billingName || shipAddress.name || customer?.name || '—',
      billing_last_name: '',
      billing_address: order.billingAddress || shipAddress.line1 || '',
      billing_city: shipAddress.city || '',
      billing_state: shipAddress.state || '',
      billing_pincode: String(addr.pin || shipAddress.pin || ''),
      billing_country: shipAddress.country || 'India',
      billing_email: customer?.email || '',
      billing_phone: customer?.phone || shipAddress.phone || '',
      shipping_is_billing: false,
    }
    : { shipping_is_billing: true };
  // Weight defaults to 0.4 kg per piece (sarees are light).
  const totalWeightKg = Math.max(0.1, (order.items || []).reduce((a, it) => a + 0.4 * (it.qty || 1), 0));
  const items = (order.items || []).map((it) => {
    const p = products?.[it.pid] || {};
    // Shiprocket rejects the whole order with 422 "Oops! Invalid Data"
    // when HSN is non-numeric (e.g. a placeholder like "yeuytque" left
    // on a draft product). Empty HSN is accepted — prefer that over a
    // bad value so a catalog hygiene issue doesn't block a shipment.
    const rawHsn = String(p.hsn || '').trim();
    const hsn = /^\d{1,15}$/.test(rawHsn) ? rawHsn : '';
    return {
      name: p.name || it.pid,
      sku: it.vid || it.pid,
      units: it.qty || 1,
      selling_price: it.price,
      hsn,
    };
  });
  return {
    order_id: order._id,
    order_date: (order.placed || new Date().toISOString()).slice(0, 10),
    pickup_location: pickup,
    billing_customer_name: shipAddress.name || customer?.name || '—',
    billing_last_name: '',
    billing_address: shipAddress.line1 || '',
    billing_address_2: shipAddress.line2 || '',
    billing_city: shipAddress.city || '',
    billing_pincode: String(addr.pin || shipAddress.pin || ''),
    billing_state: shipAddress.state || '',
    billing_country: shipAddress.country || 'India',
    billing_email: customer?.email || '',
    billing_phone: customer?.phone || shipAddress.phone || '',
    shipping_is_billing: !order.billingGstin,
    ...billing,
    order_items: items,
    payment_method: order.payment?.method === 'Cash on delivery' ? 'COD' : 'Prepaid',
    sub_total: order.sub || order.total,
    length: 32, breadth: 24, height: 5, // cm — standard saree box
    weight: Number(totalWeightKg.toFixed(2)),
  };
}

/* ---------- Tracking stub used by the shipping webhook queue ---------- */
// routes/shipping.js was built around a stub signature. Point it at the
// real tracking endpoint so the ShipEvent queue starts resolving once
// AWBs are live.
export async function callShiprocket(event) {
  if (!event?.awb) return { ok: false, err: 'Event has no AWB to track' };
  return request(`/courier/track/awb/${encodeURIComponent(event.awb)}`, { method: 'GET' });
}
