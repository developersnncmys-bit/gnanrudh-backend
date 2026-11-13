// RET-01 dry-run report. For each order with no `deliveredAt`, finds the most
// recent ShipEvent of type 'Delivered' and prints what deliveredAt *would* be set to.
//
// Usage:
//   MONGO_URI=... node scripts/backfill-deliveredAt.js            # dry-run (default)
//   MONGO_URI=... node scripts/backfill-deliveredAt.js --apply    # actually write
//
// Read-only unless --apply is passed.

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { ShipEvent } from '../src/models/ShipEvent.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const orders = await Order.find({ deliveredAt: null, status: 'Delivered' }).select('_id placed').lean();
  const plan = [];
  for (const o of orders) {
    const ev = await ShipEvent.findOne({ oid: o._id, type: 'Delivered' }).sort({ at: -1 }).lean();
    if (ev?.at) plan.push({ oid: o._id, deliveredAt: ev.at });
  }

  console.log(`${orders.length} order(s) without deliveredAt. ${plan.length} can be backfilled from ShipEvents.`);
  for (const p of plan) console.log(`  ${p.oid} -> ${p.deliveredAt}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
  } else {
    for (const p of plan) await Order.updateOne({ _id: p.oid }, { $set: { deliveredAt: p.deliveredAt } });
    console.log(`\nApplied. ${plan.length} order(s) updated.`);
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
