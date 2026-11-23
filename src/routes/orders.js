import { Router } from 'express';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { ShipEvent } from '../models/ShipEvent.js';
import { Singleton } from '../models/Singleton.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { reservePiecesForOrder, releasePiecesForOrder, shipPiecesForOrder } from './pieces.js';
import { nextInvoiceNo, nextCnNo, formatInvoice, formatCreditNote } from '../invoicing.js';
import { settingsReady } from '../validators.js';
import { recomputeCustomer } from '../crm.js';

// AUD-01: the authenticated user is the audit trail; never trust req.body.by.
const byFromReq = (req) => req.user?.email || 'System';

// TAX-01: only generate invoice numbers when Settings holds real seller details.
// Returns {ok, issues}. When !ok, caller skips invoice creation and surfaces issues.
async function sellerReady() {
  const s = await Singleton.findById('settings').lean();
  return settingsReady(s?.data);
}

const base = crudRouter(Order, {
  searchFields: ['_id', 'ship.awb', 'payment.rzp'],
  filterKeys: ['status', 'payment.status', 'cid'],
  defaultSort: { placed: -1 },
});

export const ordersRouter = Router();

async function logShip(order, type, extra = {}) {
  const ev = await ShipEvent.create({
    _id: `SL${Date.now()}${Math.floor(Math.random() * 1000)}`,
    oid: order._id,
    type,
    at: new Date().toISOString(),
    courier: order.ship?.courier,
    awb: order.ship?.awb,
    webhook: 'Received',
    ...extra,
  });
  return ev;
}

// Confirm payment, generate invoice + shipping label
ordersRouter.post('/:id/confirm-payment', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'Payment pending') return res.status(400).json({ error: 'Order is not pending payment' });

  // INV-01: reserve pieces BEFORE marking the order as paid. If any variant is
  // sold out, fail the request with 409 — never oversell. reservePiecesForOrder
  // rolls back any pieces it did claim before throwing.
  try {
    await reservePiecesForOrder(o, { by: byFromReq(req) });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: 'Not enough stock to fulfil the order', details: e.details });
    throw e;
  }

  // COD orders settle at delivery, not here — keep the 'COD collected'
  // semantic so the Payments filter and the GST invoice flag match
  // reality. Everything else (prepaid, manual-UPI, manual-card, walk-in
  // paid-in-store) marks as 'Paid'.
  o.payment.status = o.payment?.method === 'Cash on delivery' ? 'COD collected' : 'Paid';
  o.status = 'Label generated';
  o.ship.courier = o.ship.courier || 'Delhivery';
  o.ship.awb = o.ship.awb || `${Math.floor(10000000 + Math.random() * 89999999)}11`;
  let invoiceBlockedReason = null;
  if (!o.invoice) {
    const ready = await sellerReady();
    if (ready.ok) {
      const now = new Date();
      o.invoice = formatInvoice(now, await nextInvoiceNo(now));
    } else {
      invoiceBlockedReason = ready.issues;
    }
  }
  await o.save();
  await logShip(o, 'Order pushed');
  await recomputeCustomer(o.cid); // DATA-04: payment just flipped to Paid, LTV/segment need refresh.
  const body = o.toObject();
  if (invoiceBlockedReason) body.invoiceBlocked = invoiceBlockedReason;
  res.json(body);
}));

// TAX-01: retry assigning an invoice number after seller details have been filled in.
ordersRouter.post('/:id/invoice', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.invoice) return res.json(o.toObject());
  const ready = await sellerReady();
  if (!ready.ok) return res.status(409).json({ error: 'Seller details on Settings are not complete', issues: ready.issues });
  const now = new Date();
  o.invoice = formatInvoice(now, await nextInvoiceNo(now));
  await o.save();
  res.json(o.toObject());
}));

// Admin-driven payment status change. Lets staff correct the pill without
// running the full confirm-payment side effects (piece reservation, label
// generation, invoice issue). Useful when a courier reports a mismatched
// COD outcome, a manual refund is reconciled offline, or a Razorpay
// status needs to be fixed by hand. Validates against the same canonical
// list the admin UI exposes so stray strings can't land in the DB.
const PAYMENT_STATUSES = ['Paid', 'Pending', 'COD pending', 'COD collected', 'COD not collected', 'Refunded'];
// Forward-only transitions. Mirrors the admin UI's TRANSITIONS map in
// actions.js. Enforced server-side so a crafted request can't bypass
// the UI and revert a settled payment back to Pending — a Paid order
// can only move to Refunded (via a refund), nothing else.
const PAYMENT_TRANSITIONS = {
  'Pending': ['Paid', 'COD pending', 'COD collected'],
  'COD pending': ['COD collected', 'COD not collected'],
  'Paid': ['Refunded'],
  'COD collected': ['Refunded'],
  'COD not collected': [],
  'Refunded': [],
};
ordersRouter.post('/:id/payment-status', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const next = String(req.body?.status || '').trim();
  if (!PAYMENT_STATUSES.includes(next)) {
    return res.status(400).json({ error: `Payment status must be one of: ${PAYMENT_STATUSES.join(', ')}` });
  }
  const current = o.payment?.status || 'Pending';
  // Allow the no-op case (e.g. the admin is just attaching a reference
  // without changing the status) — same-to-same isn't a transition.
  if (next !== current) {
    const allowed = PAYMENT_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
      return res.status(409).json({
        error: allowed.length
          ? `${current} can only move to: ${allowed.join(', ')}. ${next} is not a valid transition.`
          : `${current} is a final payment state — it can't be changed.`,
      });
    }
  }
  if (!o.payment) o.payment = {};
  o.payment.status = next;
  if (typeof req.body?.ref === 'string' && req.body.ref.trim() && !o.payment.rzp) {
    o.payment.rzp = req.body.ref.trim();
  }
  await o.save();
  // Flipping to/from a paid state changes the customer's LTV + segment,
  // so recompute. Safe to run even when the status didn't materially
  // change — recomputeCustomer is idempotent.
  await recomputeCustomer(o.cid);
  res.json(o.toObject());
}));

// Mark packed+shipped from the Packing bench. Also transitions the attached pieces
// Reserved -> Packed -> Sold so stock and the audit log stay consistent (INV-01).
ordersRouter.post('/:id/ship', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.status = 'In transit';
  o.shippedAt = new Date().toISOString();
  await o.save();
  await logShip(o, 'Packed and handed to the courier');
  await shipPiecesForOrder(o, { codes: req.body?.codes, by: byFromReq(req) });
  res.json(o.toObject());
}));

ordersRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.status = 'Cancelled';
  await o.save();
  await releasePiecesForOrder(o, `${o._id} cancelled`, { by: byFromReq(req) });
  await recomputeCustomer(o.cid); // DATA-04
  res.json(o.toObject());
}));

// NDR actions: reattempt | address | rto
ordersRouter.post('/:id/ndr', asyncHandler(async (req, res) => {
  const { action, address, pin, phone } = req.body;
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });

  if (action === 'reattempt') {
    o.status = 'In transit'; o.ndr = null;
    await o.save();
    await logShip(o, 'NDR action sent: reattempt');
  } else if (action === 'address') {
    if (!/^\d{6}$/.test(pin || '')) return res.status(400).json({ error: 'Invalid pincode' });
    o.ship.pin = pin; o.status = 'In transit'; o.ndr = null;
    await o.save();
    await logShip(o, 'NDR action sent: new address', { detail: address });
  } else if (action === 'rto') {
    o.status = 'Returned to origin'; o.ndr = null;
    await o.save();
    await logShip(o, 'RTO initiated');
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }
  res.json(o.toObject());
}));

// Refund
ordersRouter.post('/:id/refund', asyncHandler(async (req, res) => {
  const { amount } = req.body;
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const amt = Number(amount);
  if (!(amt > 0 && amt <= o.total)) return res.status(400).json({ error: `Amount must be between 1 and ${o.total}` });
  o.payment.status = 'Refunded';
  const ready = await sellerReady();
  if (!ready.ok) return res.status(409).json({ error: 'Seller details on Settings are not complete; cannot issue credit note', issues: ready.issues });
  const now = new Date();
  o.creditNote = formatCreditNote(now, await nextCnNo(now));
  await o.save();
  await recomputeCustomer(o.cid); // DATA-04
  res.json(o.toObject());
}));

// Dashboard queue counters derived from orders (part of the admin's top nav badges).
ordersRouter.get('/stats/counts', asyncHandler(async (req, res) => {
  const [pending, ndr] = await Promise.all([
    Order.countDocuments({ status: 'Payment pending' }),
    Order.countDocuments({ status: 'Delivery failed' }),
  ]);
  res.json({ pending, ndr });
}));

// INV-01: admin-created orders (phone-in, walk-in, manual entry) must
// reserve pieces too, or the Inventory page's Reserved count and the
// oversell guard both go stale. Mirrors the storefront flow in
// customerPayment.js: create the order, try to reserve, roll back the
// order on shortage. Mounted BEFORE `base` so it wins the POST / match.
ordersRouter.post('/', asyncHandler(async (req, res) => {
  const order = await Order.create(req.body);
  try {
    await reservePiecesForOrder(order, { by: byFromReq(req) });
  } catch (e) {
    await Order.deleteOne({ _id: order._id });
    if (e.status === 409) return res.status(409).json({ error: 'Not enough stock to fulfil the order', details: e.details });
    throw e;
  }
  res.status(201).json(order.toObject());
}));

ordersRouter.use('/', base);
