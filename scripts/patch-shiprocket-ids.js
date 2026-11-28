// One-shot: writes a Shiprocket order_id + shipment_id onto our Order
// document when a push already succeeded out-of-band (e.g. via a probe
// script) and the IDs weren't persisted. Prevents duplicate pushes on
// the next admin retry.
//
// Usage (from backend/):
//   node scripts/patch-shiprocket-ids.js <ourOrderId> <shiprocketOrderId> <shipmentId>

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';

async function main() {
  const [ourId, srId, shipmentId] = process.argv.slice(2);
  if (!ourId || !srId || !shipmentId) {
    console.error('Usage: node scripts/patch-shiprocket-ids.js <ourOrderId> <shiprocketOrderId> <shipmentId>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const o = await Order.findById(ourId);
  if (!o) throw new Error(`Order ${ourId} not found`);
  o.ship = o.ship || {};
  o.ship.shiprocketOrderId = String(srId);
  o.ship.shiprocketShipmentId = String(shipmentId);
  o.ship.pushedAt = new Date().toISOString();
  o.ship.pushError = null;
  await o.save();
  console.log(`Patched ${ourId}: shiprocketOrderId=${srId}, shipmentId=${shipmentId}`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
