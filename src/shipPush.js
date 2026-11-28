// SHIP-02: push a storefront order to Shiprocket.
//
// Single-step push: createAdhocOrder lands the order on Shiprocket's
// dashboard. AWB assignment and pickup scheduling are intentionally
// NOT automated — staff do those from the Shiprocket dashboard so they
// can pick the courier per order. Any failure writes a human-readable
// message to `order.ship.pushError`.
//
// Orders are gated on `source === 'Storefront'`. Manual admin entries
// (Phone / WhatsApp / Walk-in / Instagram) never reach Shiprocket —
// those shipments are handled by in-store staff.

import { Order } from './models/Order.js';
import { Customer } from './models/Customer.js';
import { Product } from './models/Product.js';
import {
  buildAdhocOrderPayload,
  createAdhocOrder,
  isShiprocketConfigured,
} from './shiprocket.js';

const STOREFRONT_SOURCES = new Set(['Storefront']);

export function shouldPushToShiprocket(order) {
  if (!order) return false;
  if (!STOREFRONT_SOURCES.has(String(order.source || ''))) return false;
  // Skip silently when env credentials aren't configured — the admin
  // can still see the order in the drawer with no push attempted.
  if (!isShiprocketConfigured()) return false;
  return true;
}

export async function pushOrderToShiprocket(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, err: 'Order not found' };
  if (!shouldPushToShiprocket(order)) {
    return { ok: false, err: `Source "${order.source}" is not pushed to Shiprocket; only storefront orders are.` };
  }
  const customer = order.cid ? await Customer.findById(order.cid).lean() : null;
  const pids = (order.items || []).map((it) => it.pid).filter(Boolean);
  const prods = pids.length ? await Product.find({ _id: { $in: pids } }).select('_id name hsn').lean() : [];
  const productsMap = Object.fromEntries(prods.map((p) => [p._id, p]));

  const payload = await buildAdhocOrderPayload({ order, customer, products: productsMap });

  const create = await createAdhocOrder(payload);
  if (!create.ok) {
    order.ship = order.ship || {};
    order.ship.pushError = `createOrder: ${create.err}`;
    await order.save();
    return { ok: false, err: create.err, step: 'createOrder' };
  }
  const shiprocketOrderId = String(create.data?.order_id || '');
  const shipmentId = String(create.data?.shipment_id || '');
  order.ship = order.ship || {};
  order.ship.shiprocketOrderId = shiprocketOrderId;
  order.ship.shiprocketShipmentId = shipmentId;
  order.ship.pushedAt = new Date().toISOString();
  order.ship.pushError = null;
  await order.save();
  return {
    ok: true,
    data: { shiprocketOrderId, shipmentId },
  };
}
