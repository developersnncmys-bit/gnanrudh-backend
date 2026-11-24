import { Router } from 'express';
import { Return } from '../models/Return.js';
import { Order } from '../models/Order.js';
import { ShipEvent } from '../models/ShipEvent.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { Piece } from '../models/Piece.js';
import { Movement } from '../models/Movement.js';
import { nextCnNo, formatCreditNote } from '../invoicing.js';
import { settingsReady } from '../validators.js';
import { Singleton } from '../models/Singleton.js';
import { recomputeCustomer } from '../crm.js';
import { newReverseAwb } from '../awb.js';

const base = crudRouter(Return, {
  searchFields: ['_id', 'oid', 'reason'],
  filterKeys: ['status', 'cid', 'oid'],
  defaultSort: { requested: -1 },
});

export const returnsRouter = Router();

// RET-01/02: look up the return window from Settings.policy.window, default 7.
async function getReturnWindowDays() {
  const s = await Singleton.findById('settings').lean();
  const w = Number(s?.data?.policy?.window);
  return Number.isFinite(w) && w > 0 ? w : 7;
}

// RET-01: pre-flight eligibility check. Returns { eligible, daysSinceDelivery, windowDays, deliveredAt }.
export async function checkReturnEligibility(oid) {
  const o = await Order.findById(oid).lean();
  if (!o) return { eligible: false, reason: 'Order not found' };
  const windowDays = await getReturnWindowDays();
  if (!o.deliveredAt) return { eligible: false, deliveredAt: null, windowDays, reason: 'Order not delivered yet' };
  const diffDays = Math.floor((Date.now() - new Date(o.deliveredAt).getTime()) / 864e5);
  return { eligible: diffDays <= windowDays, deliveredAt: o.deliveredAt, daysSinceDelivery: diffDays, windowDays };
}

// RET-01: custom POST overrides the generic crud.create so we can snapshot
// deliveredAt and apply eligibility before the Return hits the DB.
returnsRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.oid) return res.status(400).json({ error: 'oid is required' });
  const o = await Order.findById(body.oid).lean();
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const windowDays = await getReturnWindowDays();
  const deliveredAt = o.deliveredAt || null;
  const daysSinceDelivery = deliveredAt ? Math.floor((Date.now() - new Date(deliveredAt).getTime()) / 864e5) : null;
  const eligible = deliveredAt != null && daysSinceDelivery <= windowDays;
  const status = body.status || (eligible ? 'Requested' : 'Not eligible');
  const doc = await Return.create({
    ...body,
    status,
    deliveredAt,
    windowDays,
  });
  res.status(201).json(doc.toObject());
}));

// RET-02: reverse pickups with no status change for >=5 days are flagged for action.
returnsRouter.get('/overdue-pickups', asyncHandler(async (req, res) => {
  const cutoff = new Date(Date.now() - 5 * 864e5);
  const items = await Return.find({
    status: 'Pickup scheduled',
    updatedAt: { $lte: cutoff },
  }).sort({ updatedAt: 1 }).lean();
  res.json({ items, total: items.length });
}));

returnsRouter.post('/:id/approve', asyncHandler(async (req, res) => {
  const r = await Return.findById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Return not found' });
  r.status = 'Pickup scheduled';
  r.awb = newReverseAwb();
  await r.save();
  await ShipEvent.create({
    _id: `SL${Date.now()}${Math.floor(Math.random() * 1000)}`,
    oid: r.oid, type: 'Reverse pickup created', at: new Date().toISOString(),
    courier: 'Delhivery', awb: r.awb, webhook: 'Received',
  });
  res.json(r.toObject());
}));

returnsRouter.post('/:id/picked', asyncHandler(async (req, res) => {
  const r = await Return.findByIdAndUpdate(req.params.id, { $set: { status: 'Picked up' } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Return not found' });
  res.json(r);
}));

returnsRouter.post('/:id/received', asyncHandler(async (req, res) => {
  const r = await Return.findByIdAndUpdate(req.params.id, { $set: { status: 'Received' } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Return not found' });
  // Transition the piece that was fulfilled for this order+product back to
  // Returned. Accepts both 'Sold' (modern terminal state from
  // shipPiecesForOrder — see INV-01 comment in Piece.js) and 'Shipped'
  // (legacy terminal state on orders placed before the pieces refactor).
  // Previously only matched 'Shipped', so refunds against modern orders
  // left the piece stuck at 'Sold' forever and never restocked.
  try {
    const piece = await Piece.findOne({ oid: r.oid, pid: r.pid, status: { $in: ['Sold', 'Shipped', 'Packed'] } });
    if (piece) {
      const at = new Date().toISOString();
      const from = piece.status;
      piece.status = 'Returned'; piece.at = at;
      await piece.save();
      await Movement.create({
        _id: `MV${Date.now()}${Math.floor(Math.random() * 1000)}`,
        code: piece._id, pid: piece.pid, vid: piece.vid,
        from, to: 'Returned', note: `Return ${r._id} received`, oid: piece.oid, by: 'Store', at,
      });
    }
  } catch (e) { /* non-fatal */ }
  res.json(r);
}));

returnsRouter.post('/:id/refund', asyncHandler(async (req, res) => {
  const r = await Return.findById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Return not found' });
  const settings = await Singleton.findById('settings').lean();
  const ready = settingsReady(settings?.data);
  if (!ready.ok) return res.status(409).json({ error: 'Seller details on Settings are not complete; cannot issue credit note', issues: ready.issues });

  // RET-03: refund amount can never exceed the line value on the original order.
  const srcOrder = await Order.findById(r.oid).lean();
  const srcLine = srcOrder?.items?.find((it) => it.pid === r.pid);
  const lineCap = srcLine ? srcLine.price * (srcLine.qty || 1) : Infinity;
  const amount = Number(req.body?.amount ?? r.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Refund amount must be greater than zero' });
  if (amount > lineCap) return res.status(400).json({ error: `Refund amount ${amount} exceeds the line value ${lineCap}` });
  r.amount = amount;

  r.status = 'Refunded';
  await r.save();

  const now = new Date();
  const seq = await nextCnNo(now);

  const o = await Order.findById(r.oid);
  if (o) {
    o.creditNote = formatCreditNote(now, seq);
    o.payment.status = 'Refunded';
    await o.save();
    await recomputeCustomer(o.cid); // DATA-04
  }

  // INV-01: `variant.stock` is a stale denormalisation. The whole app
  // (admin + storefront) reads stock from pieces via piecesOf(), not from
  // this field. Previously we incremented it here on refund — a dead
  // write that just made the stale field drift further from reality.
  // Removed. The real restock happens in the piece-transition block
  // immediately below.

  // Restock the returned piece → In stock. Accepts 'Returned' (normal
  // flow after /received landed) and also the terminal shipment states
  // 'Sold' / 'Shipped' / 'Packed' in case the admin jumps straight to
  // Refund without clicking Received. Previously only matched 'Returned'
  // + 'Shipped', so a refund against a 'Sold' piece did nothing and the
  // unit was permanently lost from inventory.
  try {
    const piece = await Piece.findOne({ oid: r.oid, pid: r.pid, status: { $in: ['Returned', 'Sold', 'Shipped', 'Packed'] } });
    if (piece) {
      const at = new Date().toISOString();
      // If we skipped the Received step, bridge with a Movement so the
      // audit log reads <from> → Returned → In stock cleanly.
      if (['Sold', 'Shipped', 'Packed'].includes(piece.status)) {
        const from = piece.status;
        piece.status = 'Returned'; piece.at = at;
        await piece.save();
        await Movement.create({
          _id: `MV${Date.now()}${Math.floor(Math.random() * 1000)}R`,
          code: piece._id, pid: piece.pid, vid: piece.vid,
          from, to: 'Returned', note: `Return ${r._id} received`, oid: piece.oid, by: 'Store', at,
        });
      }
      const from2 = piece.status;
      piece.status = 'In stock'; piece.oid = null; piece.at = at;
      await piece.save();
      await Movement.create({
        _id: `MV${Date.now()}${Math.floor(Math.random() * 1000)}S`,
        code: piece._id, pid: piece.pid, vid: piece.vid,
        from: from2, to: 'In stock', note: `Inspected after return ${r._id}, restocked`, oid: null, by: 'Surekha', at,
      });
    }
  } catch (e) { /* non-fatal */ }

  res.json(r.toObject());
}));

returnsRouter.post('/:id/reject', asyncHandler(async (req, res) => {
  const r = await Return.findByIdAndUpdate(req.params.id, { $set: { status: 'Rejected' } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Return not found' });
  res.json(r);
}));

returnsRouter.use('/', base);
