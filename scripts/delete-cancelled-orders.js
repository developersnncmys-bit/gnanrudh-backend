// One-off cleanup: delete every Order where status === 'Cancelled'.
// Also removes the matching ids from each customer's `orders` array so the
// admin CRM counts don't dangle, and recomputes LTV/segment for every
// affected customer. ShipEvents against the deleted orders are dropped too.
//
// Usage:
//   MONGO_URI=... node scripts/delete-cancelled-orders.js           # dry run (default)
//   MONGO_URI=... node scripts/delete-cancelled-orders.js --apply   # actually delete
//
// Read-only unless --apply is passed.

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { ShipEvent } from '../src/models/ShipEvent.js';
import { Customer } from '../src/models/Customer.js';
import { recomputeCustomer } from '../src/crm.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI env var is required. Copy it from backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const cancelled = await Order.find({ status: 'Cancelled' }).select('_id cid placed total').lean();
  console.log(`\nFound ${cancelled.length} cancelled order(s):`);
  for (const o of cancelled) {
    console.log(`  ${o._id}  cid=${o.cid}  placed=${o.placed?.slice(0, 10) || '-'}  total=₹${o.total ?? 0}`);
  }

  if (!cancelled.length) {
    console.log('\nNothing to delete.');
    await mongoose.disconnect();
    return;
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to actually delete.');
    await mongoose.disconnect();
    return;
  }

  const oids = cancelled.map((o) => o._id);
  const cidsAffected = [...new Set(cancelled.map((o) => o.cid).filter(Boolean))];

  // 1) Drop the orders themselves.
  const delRes = await Order.deleteMany({ _id: { $in: oids } });
  console.log(`\nDeleted ${delRes.deletedCount} order(s).`);

  // 2) Drop any ShipEvents tied to those orders — otherwise the admin's
  //    shipping log keeps rendering entries for ids that no longer exist.
  const shipRes = await ShipEvent.deleteMany({ oid: { $in: oids } });
  console.log(`Deleted ${shipRes.deletedCount} ship event(s).`);

  // 3) Remove the ids from each customer's `orders` array so account page
  //    counts don't dangle.
  const pullRes = await Customer.updateMany(
    { orders: { $in: oids } },
    { $pull: { orders: { $in: oids } } },
  );
  console.log(`Updated ${pullRes.modifiedCount} customer doc(s).`);

  // 4) Recompute LTV / segment for every customer we touched — cancelled
  //    orders weren't contributing to paid LTV but they may have been in
  //    `orderCount`. recomputeCustomer is idempotent + cheap.
  for (const cid of cidsAffected) {
    try { await recomputeCustomer(cid); } catch (err) { console.warn(`  recompute failed for ${cid}:`, err.message); }
  }
  console.log(`Recomputed CRM for ${cidsAffected.length} customer(s).`);

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
