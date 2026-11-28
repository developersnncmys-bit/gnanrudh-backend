// Probe: checks the Shiprocket account's gating conditions that commonly
// block AWB assignment — wallet balance, pickup location verification,
// KYC/profile status. Used when createAdhocOrder succeeds but assignAwb
// returns "Unauthorized. You do not have permission for this action."
//
// Usage (from backend/):
//   node scripts/probe-shiprocket-account.js

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

async function call(token, path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const token = await login();
  console.log('login OK');

  // Wallet balance — the most common AWB gating condition.
  section('Wallet balance (/account/details/wallet-balance)');
  const wallet = await call(token, '/account/details/wallet-balance');
  console.log(JSON.stringify(wallet, null, 2));

  // Account/plan details.
  section('Account details (/settings/company/profile)');
  const profile = await call(token, '/settings/company/profile');
  console.log(JSON.stringify(profile, null, 2));

  // Pickup locations — status=2 is verified, other values are pending.
  section('Pickup locations (/settings/company/pickup)');
  const pickup = await call(token, '/settings/company/pickup');
  console.log(JSON.stringify(pickup, null, 2));

  // KYC status — not all plans expose this endpoint; a 404 here is fine.
  section('KYC (/settings/company/kyc)');
  const kyc = await call(token, '/settings/company/kyc');
  console.log(JSON.stringify(kyc, null, 2));

  // Channel list — occasionally relevant.
  section('Channels (/channels)');
  const channels = await call(token, '/channels');
  console.log(JSON.stringify(channels, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
