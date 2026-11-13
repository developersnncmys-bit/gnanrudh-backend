// DATA-04/CUS-01: server-side customer rollups. Single source of truth.
// Call recomputeCustomer(cid) after any event that can change the money-received
// view of the customer (confirm-payment, cancel, refund, RTO).

import { Order } from './models/Order.js';
import { Customer } from './models/Customer.js';
import { Product } from './models/Product.js';

// Matches admin/src/lib/data.js paid() — Paid or COD collected only (LOGIC-01).
const PAID_STATES = ['Paid', 'COD collected'];

function segmentFor(ltv, lastOrderISO, orderCount) {
  if (!orderCount) return 'No orders';
  const daysSince = lastOrderISO ? Math.floor((Date.now() - new Date(lastOrderISO).getTime()) / 864e5) : null;
  if (daysSince != null && daysSince > 180) return 'Dormant';
  if (ltv >= 100000 || orderCount >= 6) return 'VIP';
  if (orderCount >= 2) return 'Repeat';
  return 'New';
}

export async function recomputeCustomer(cid) {
  if (!cid) return null;
  const orders = await Order.find({ cid }).sort({ placed: -1 }).lean();
  const paidOrders = orders.filter((o) => PAID_STATES.includes(o.payment?.status));
  const ltv = paidOrders.reduce((a, o) => a + (o.total || 0), 0);
  const orderCount = paidOrders.length;
  const lastOrder = paidOrders[0]?.placed || null;

  // Weaves + occasions from product lookups on paid orders (best-effort — unknown pids skipped).
  const pids = [...new Set(paidOrders.flatMap((o) => o.items.map((it) => it.pid)))];
  const prods = pids.length ? await Product.find({ _id: { $in: pids } }).select('_id weave occasion occasions').lean() : [];
  const prodMap = Object.fromEntries(prods.map((p) => [p._id, p]));
  const weaves = [...new Set(paidOrders.flatMap((o) => o.items.map((it) => prodMap[it.pid]?.weave).filter(Boolean)))];
  const occasions = [...new Set(paidOrders.flatMap((o) => o.items.flatMap((it) => {
    const p = prodMap[it.pid];
    return p ? (p.occasions?.length ? p.occasions : (p.occasion ? [p.occasion] : [])) : [];
  }).filter(Boolean)))];

  const segment = segmentFor(ltv, lastOrder, orderCount);
  await Customer.updateOne({ _id: cid }, {
    $set: { ltv, orderCount, lastOrder, weaves, occasions, segment },
  });
  return { cid, ltv, orderCount, lastOrder, segment };
}
