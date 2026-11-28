// Probe: check courier serviceability for the actual shipment created for
// an order. Shiprocket's assignAwb returns a vague "Unauthorized" when no
// courier can service the pickup→delivery lane with the given weight;
// this script tells us whether any couriers are returned at all.
//
// Usage (from backend/):
//   node scripts/probe-shiprocket-serviceability.js <shipmentId>

import 'dotenv/config';

const BASE = 'https://apiv2.shiprocket.in/v1/external';

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.token) throw new Error(`login failed: ${JSON.stringify(j)}`);
  return j.token;
}

async function main() {
  const shipmentId = process.argv[2];
  if (!shipmentId) {
    console.error('Usage: node scripts/probe-shiprocket-serviceability.js <shipmentId>');
    process.exit(1);
  }
  const token = await login();

  // Lane check: pickup 524004 (Nellore) → delivery 570031 (Mysore),
  // ~0.4kg (standard saree box per buildAdhocOrderPayload defaults).
  const params = new URLSearchParams({
    pickup_postcode: '524004',
    delivery_postcode: '570031',
    weight: '0.4',
    cod: '0',
  });
  console.log('\n=== Courier serviceability 524004 → 570031 ===');
  const r1 = await fetch(`${BASE}/courier/serviceability/?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j1 = await r1.json();
  const couriers = j1?.data?.available_courier_companies || [];
  console.log(`status=${r1.status}, available couriers=${couriers.length}`);
  if (couriers.length) {
    console.log('Top 3:');
    couriers.slice(0, 3).forEach((c) => {
      console.log(`  - ${c.courier_name} (id ${c.courier_company_id}) rate=${c.freight_charge} etd=${c.etd}`);
    });
  } else {
    console.log('FULL RESPONSE:', JSON.stringify(j1, null, 2));
  }

  // Try the actual assignAwb and show the full error body so we can see
  // if Shiprocket returns any hints beyond "Unauthorized".
  console.log(`\n=== assignAwb (no courier_id, auto-pick) for shipment ${shipmentId} ===`);
  const r2 = await fetch(`${BASE}/courier/assign/awb`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ shipment_id: shipmentId }),
  });
  console.log(`status=${r2.status}`);
  console.log(JSON.stringify(await r2.json().catch(() => ({})), null, 2));

  // Retry with each top-3 courier explicitly to find out if any specific
  // one works (narrows the 403 from "account-wide" to "courier-specific").
  for (const c of couriers.slice(0, 3)) {
    console.log(`\n=== assignAwb with courier_id=${c.courier_company_id} (${c.courier_name}) ===`);
    const r3 = await fetch(`${BASE}/courier/assign/awb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ shipment_id: shipmentId, courier_id: c.courier_company_id }),
    });
    console.log(`status=${r3.status}`);
    console.log(JSON.stringify(await r3.json().catch(() => ({})), null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
