import { Router } from 'express';
import { Return } from '../models/Return.js';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { ShipEvent } from '../models/ShipEvent.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { Piece } from '../models/Piece.js';
import { Movement } from '../models/Movement.js';
import { nextCnNo, formatCreditNote } from '../invoicing.js';

const base = crudRouter(Return, {
  searchFields: ['_id', 'oid', 'reason'],
  filterKeys: ['status', 'cid', 'oid'],
  defaultSort: { requested: -1 },
});

export const returnsRouter = Router();

returnsRouter.post('/:id/approve', asyncHandler(async (req, res) => {
  const r = await Return.findById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Return not found' });
  r.status = 'Pickup scheduled';
  r.awb = `R${Math.floor(10000000 + Math.random() * 89999999)}`;
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
  // Mark the shipped piece for this order+product as Returned.
  try {
    const piece = await Piece.findOne({ oid: r.oid, pid: r.pid, status: 'Shipped' });
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
  r.status = 'Refunded';
  await r.save();

  const now = new Date();
  const seq = await nextCnNo(now);

  const o = await Order.findById(r.oid);
  if (o) {
    o.creditNote = formatCreditNote(now, seq);
    o.payment.status = 'Refunded';
    await o.save();
  }

  const p = await Product.findById(r.pid);
  if (p) {
    const it = (await Order.findById(r.oid).lean())?.items?.find((x) => x.pid === r.pid);
    const v = p.variants.find((x) => x.id === it?.vid) || p.variants[0];
    if (v) v.stock += 1;
    await p.save();
  }

  // Restock the returned piece: Returned (or still Shipped) → In stock.
  try {
    const piece = await Piece.findOne({ oid: r.oid, pid: r.pid, status: { $in: ['Returned', 'Shipped'] } });
    if (piece) {
      const at = new Date().toISOString();
      if (piece.status === 'Shipped') {
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
