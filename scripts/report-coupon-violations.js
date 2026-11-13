// CPN-01 dry-run report. Scans every paid/received-money order with a coupon
// and lists orders that break the coupon's rules (scope, min, first-order,
// usage cap, expiry at the time of purchase).
//
// Usage:
//   MONGO_URI=... node scripts/report-coupon-violations.js
//   MONGO_URI=... node scripts/report-coupon-violations.js --json
//
// Read-only. Never modifies data.

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { Coupon } from '../src/models/Coupon.js';
import { Customer } from '../src/models/Customer.js';
import { Product } from '../src/models/Product.js';
import { validateCoupon, scopeMatcher } from '../src/coupons.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const [orders, coupons, customers, products] = await Promise.all([
    Order.find({ coupon: { $ne: null } }).sort({ placed: 1 }).lean(),
    Coupon.find({}).lean(),
    Customer.find({}).select('_id phone email orderCount').lean(),
    Product.find({}).select('_id cat').lean(),
  ]);
  const cMap = Object.fromEntries(coupons.map((c) => [c._id, c]));
  const custMap = Object.fromEntries(customers.map((c) => [c._id, c]));
  const prodMap = Object.fromEntries(products.map((p) => [p._id, p]));

  // Count real uses (paid orders per code) for the "Used N / actually M" drift check.
  const actualUses = new Map();
  for (const o of orders) {
    if (!['Paid', 'COD collected'].includes(o.payment?.status)) continue;
    actualUses.set(o.coupon, (actualUses.get(o.coupon) || 0) + 1);
  }

  const violations = [];
  for (const o of orders) {
    const coupon = cMap[o.coupon];
    if (!coupon) {
      violations.push({ oid: o._id, code: o.coupon, reason: 'Coupon no longer exists' });
      continue;
    }
    // At-time-of-purchase customer snapshot: previous orders for first-order rule.
    const prevCount = Math.max(0, (custMap[o.cid]?.orderCount || 0) - 1);
    const customer = custMap[o.cid] ? { ...custMap[o.cid], orderCount: prevCount } : null;
    const result = validateCoupon({ coupon, customer, items: o.items, products: prodMap, now: o.placed });
    if (!result.ok) {
      violations.push({ oid: o._id, placed: o.placed, cid: o.cid, code: o.coupon, reason: result.reason });
    }
  }

  const useDrift = [];
  for (const c of coupons) {
    const actual = actualUses.get(c._id) || 0;
    if ((c.uses || 0) !== actual) useDrift.push({ code: c._id, stored: c.uses, actual });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ orders: orders.length, violations, useDrift }, null, 2));
  } else {
    console.log(`Scanned ${orders.length} order(s) with coupons.`);
    console.log(`\nViolations: ${violations.length}`);
    for (const v of violations) console.log(`  ${v.oid}: ${v.code} on ${v.placed} — ${v.reason}`);
    console.log(`\nStored "uses" vs actual paid-order count:`);
    for (const d of useDrift) console.log(`  ${d.code}: stored ${d.stored}, actual ${d.actual}`);
    if (!useDrift.length) console.log('  (all match)');
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
