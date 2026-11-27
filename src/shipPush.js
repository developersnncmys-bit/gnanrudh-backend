// SHIP-02: push a storefront order to Shiprocket.
//
// Three-step flow per Shiprocket's docs:
//   1. createAdhocOrder  → returns shiprocket order_id + shipment_id
//   2. assignAwb         → returns awb_code + courier_name
//   3. generatePickup    → schedules a pickup
//
// Each step is independently non-blocking — if step 2 fails, the order
// still has a shiprocket id and the admin can retry from the drawer.
// Any failure writes a human-readable message to `order.ship.pushError`.
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
  assignAwb,
  generatePickup,
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

  // Step 1: create order on Shiprocket.
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

  // Step 2: AWB. Shiprocket picks the cheapest available courier when
  // no courier_id is supplied — the admin can switch couriers later
  // from the Shiprocket dashboard without another push.
  if (shipmentId) {
    const awb = await assignAwb(shipmentId);
    if (awb.ok) {
      const awbData = awb.data?.response?.data || {};
      if (awbData.awb_code) order.ship.awb = String(awbData.awb_code);
      if (awbData.courier_name) order.ship.courier = String(awbData.courier_name);
    } else {
      order.ship.pushError = `assignAwb: ${awb.err}`;
      await order.save();
      return { ok: true, partial: true, err: awb.err, step: 'assignAwb', data: { shiprocketOrderId, shipmentId } };
    }
  }

  // Step 3: pickup. Best-effort — if this fails, admin can schedule from
  // the Shiprocket dashboard manually. Don't surface as an error since
  // the shipment is otherwise ready to roll.
  if (shipmentId) {
    const pickup = await generatePickup(shipmentId);
    if (!pickup.ok) {
      order.ship.pushError = `generatePickup: ${pickup.err} (shipment created, request pickup from Shiprocket dashboard)`;
    }
  }

  await order.save();
  return {
    ok: true,
    data: {
      shiprocketOrderId,
      shipmentId,
      awb: order.ship.awb,
      courier: order.ship.courier,
    },
  };
}
