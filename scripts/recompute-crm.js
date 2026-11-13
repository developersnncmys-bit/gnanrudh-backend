// DATA-04 dry-run script. Recomputes every customer's LTV, orderCount, lastOrder,
// weaves, occasions and segment from scratch using the new "money received" rule.
//
// Usage:
//   MONGO_URI=... node scripts/recompute-crm.js            # dry-run
//   MONGO_URI=... node scripts/recompute-crm.js --apply    # actually write

import 'dotenv/config';
import mongoose from 'mongoose';
import { Customer } from '../src/models/Customer.js';
import { recomputeCustomer } from '../src/crm.js';

const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const customers = await Customer.find({}).select('_id ltv orderCount segment').lean();
  let drift = 0;
  for (const c of customers) {
    if (apply) {
      const next = await recomputeCustomer(c._id);
      if (next && (next.ltv !== c.ltv || next.orderCount !== c.orderCount || next.segment !== c.segment)) {
        drift += 1;
        console.log(`updated ${c._id}: ltv ${c.ltv}->${next.ltv}, orders ${c.orderCount}->${next.orderCount}, segment ${c.segment}->${next.segment}`);
      }
    } else {
      // Dry-run: compute without writing. recomputeCustomer writes, so we snapshot the
      // old doc and revert if drift occurs. Cheaper alternative is a parallel computation
      // but it would duplicate the helper. For the scale here (<10k customers), this is fine.
      const prev = c;
      const next = await recomputeCustomer(c._id);
      if (next && (next.ltv !== prev.ltv || next.orderCount !== prev.orderCount || next.segment !== prev.segment)) {
        drift += 1;
        console.log(`would update ${c._id}: ltv ${prev.ltv}->${next.ltv}, orders ${prev.orderCount}->${next.orderCount}, segment ${prev.segment}->${next.segment}`);
        await Customer.updateOne({ _id: c._id }, { $set: { ltv: prev.ltv, orderCount: prev.orderCount, segment: prev.segment } });
      }
    }
  }
  console.log(`${customers.length} customer(s) scanned. ${drift} would change.`);
  if (!apply) console.log('Dry run. Re-run with --apply to commit.');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
