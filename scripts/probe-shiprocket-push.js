// Probe: builds the exact Shiprocket payload for an order and prints the
// raw response from Shiprocket's /orders/create/adhoc. Used to diagnose
// the "push completes but order never appears in dashboard" case.
//
// Usage (from backend/):
//   node scripts/probe-shiprocket-push.js <orderId>

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { Customer } from '../src/models/Customer.js';
import { Product } from '../src/models/Product.js';
import { buildAdhocOrderPayload, createAdhocOrder } from '../src/shiprocket.js';

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error('Usage: node scripts/probe-shiprocket-push.js <orderId>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const order = await Order.findById(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  const customer = order.cid ? await Customer.findById(order.cid).lean() : null;
  const pids = (order.items || []).map((it) => it.pid).filter(Boolean);
  const prods = pids.length ? await Product.find({ _id: { $in: pids } }).select('_id name hsn').lean() : [];
  const productsMap = Object.fromEntries(prods.map((p) => [p._id, p]));
  const payload = await buildAdhocOrderPayload({ order, customer, products: productsMap });

  console.log('\n=== Payload being sent ===');
  console.log(JSON.stringify(payload, null, 2));

  console.log('\n=== Calling createAdhocOrder ===');
  const res = await createAdhocOrder(payload);
  console.log('\n=== Raw response ===');
  console.log(JSON.stringify(res, null, 2));

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
