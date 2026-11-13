import { Router } from 'express';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { ShipEvent } from '../models/ShipEvent.js';
import { Singleton } from '../models/Singleton.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { reservePiecesForOrder, releasePiecesForOrder } from './pieces.js';
import { nextInvoiceNo, nextCnNo, formatInvoice, formatCreditNote } from '../invoicing.js';
import { settingsReady } from '../validators.js';

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
  o.payment.status = 'Paid';
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
  try { await reservePiecesForOrder(o); } catch (e) { /* non-fatal: piece reservation is best-effort */ }
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

// Cancel
// Mark packed+shipped from the Packing bench.
ordersRouter.post('/:id/ship', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.status = 'In transit';
  o.shippedAt = new Date().toISOString();
  await o.save();
  await logShip(o, 'Packed and handed to the courier');
  res.json(o.toObject());
}));

ordersRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.status = 'Cancelled';
  await o.save();
  try { await releasePiecesForOrder(o, `${o._id} cancelled`); } catch (e) { /* non-fatal */ }
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

ordersRouter.use('/', base);
