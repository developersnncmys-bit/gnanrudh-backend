// One-shot: clears `ship.pushError` on orders where the only failure was
// the AWB assignment / pickup step. Those steps are no longer part of the
// push flow — staff assign AWB from the Shiprocket dashboard — so the
// error is stale and misleading. The order itself IS on Shiprocket
// (shiprocketOrderId is set), so clearing the error makes the drawer
// accurately show "Pushed to Shiprocket".
//
// Usage (from backend/):
//   node scripts/clear-stale-awb-errors.js

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const r = await Order.updateMany(
    {
      'ship.shiprocketOrderId': { $exists: true, $ne: '' },
      'ship.pushError': { $regex: /^(assignAwb|generatePickup):/ },
    },
    { $set: { 'ship.pushError': null } },
  );
  console.log(`Cleared pushError on ${r.modifiedCount} orders.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
