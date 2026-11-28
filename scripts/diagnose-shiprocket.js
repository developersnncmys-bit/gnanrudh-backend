// One-shot diagnostic for "orders aren't reflecting in Shiprocket".
//
// Reports:
//   1. Whether SHIPROCKET_* env vars are readable from the backend env.
//   2. Whether login to Shiprocket works with the stored creds.
//   3. Order counts in the last 30 days broken down by source.
//   4. For every storefront order in that window, the push state:
//      shiprocketOrderId / shipmentId / awb / pushError / pushedAt.
//
// Usage (from backend/):
//   node scripts/diagnose-shiprocket.js

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { isShiprocketConfigured, testConnection } from '../src/shiprocket.js';

async function main() {
  console.log('\n=== Shiprocket env ===');
  console.log('SHIPROCKET_EMAIL           :', process.env.SHIPROCKET_EMAIL || '(missing)');
  console.log('SHIPROCKET_PASSWORD        :', process.env.SHIPROCKET_PASSWORD ? `(set, length ${process.env.SHIPROCKET_PASSWORD.length})` : '(missing)');
  console.log('SHIPROCKET_PICKUP_LOCATION :', process.env.SHIPROCKET_PICKUP_LOCATION || '(default: Primary)');
  console.log('SHIPROCKET_ENABLED         :', process.env.SHIPROCKET_ENABLED ?? '(unset → treated as enabled)');
  console.log('isShiprocketConfigured()   :', isShiprocketConfigured());

  console.log('\n=== Shiprocket login test ===');
  const t = await testConnection();
  if (t.ok) console.log('login OK — token issued');
  else console.log('login FAILED:', t.err);

  if (!process.env.MONGO_URI) {
    console.error('\nMONGO_URI not set — cannot inspect orders. Stopping here.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const bySource = await Order.aggregate([
    { $match: { placed: { $gte: since } } },
    { $group: { _id: '$source', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log('\n=== Orders in last 30 days by source ===');
  if (!bySource.length) console.log('(none)');
  bySource.forEach((r) => console.log(`${String(r._id || '(unset)').padEnd(24)} ${r.count}`));

  const storefront = await Order.find({
    source: 'Storefront',
    placed: { $gte: since },
  })
    .sort({ placed: -1 })
    .select('_id placed status payment.status payment.method ship source')
    .lean();

  console.log(`\n=== Storefront orders in last 30 days (${storefront.length}) ===`);
  for (const o of storefront) {
    const s = o.ship || {};
    console.log(`\n${o._id}  placed=${o.placed}`);
    console.log(`  status=${o.status}  payment=${o.payment?.status} (${o.payment?.method})`);
    console.log(`  shiprocketOrderId   = ${s.shiprocketOrderId || '(none)'}`);
    console.log(`  shiprocketShipmentId= ${s.shiprocketShipmentId || '(none)'}`);
    console.log(`  awb                 = ${s.awb || '(none)'}  courier=${s.courier || '(none)'}`);
    console.log(`  pushedAt            = ${s.pushedAt || '(never)'}`);
    console.log(`  pushError           = ${s.pushError || '(none)'}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
