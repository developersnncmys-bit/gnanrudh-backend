import { Router } from 'express';
import { Piece } from '../models/Piece.js';
import { Movement } from '../models/Movement.js';
import { Product } from '../models/Product.js';
import { Order } from '../models/Order.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const piecesRouter = Router();
export const movementsRouter = Router();

/* ---------- listing ---------- */

piecesRouter.get('/', asyncHandler(async (req, res) => {
  const filter = {};
  for (const k of ['pid', 'vid', 'status', 'oid']) {
    const v = req.query[k];
    if (v === undefined || v === '' || typeof v === 'object') continue;
    filter[k] = String(v);
  }
  const items = await Piece.find(filter).sort({ at: -1 }).lean();
  res.json({ items, total: items.length });
}));

piecesRouter.get('/:code', asyncHandler(async (req, res) => {
  const p = await Piece.findById(req.params.code).lean();
  if (!p) return res.status(404).json({ error: 'Piece not found' });
  res.json(p);
}));

movementsRouter.get('/', asyncHandler(async (req, res) => {
  const items = await Movement.find({}).sort({ at: -1 }).limit(Number(req.query.limit) || 5000).lean();
  res.json({ items, total: items.length });
}));

/* ---------- helpers ---------- */

async function nextMoveId() {
  const n = await Movement.estimatedDocumentCount();
  return `MV${n + 1}${Date.now().toString(36).slice(-3)}`;
}

async function recordMove(piece, to, note, { by = 'Store', at = new Date().toISOString(), oid } = {}) {
  const from = piece.status;
  piece.status = to;
  piece.at = at;
  if (oid !== undefined) piece.oid = oid;
  await piece.save();
  const mv = await Movement.create({
    _id: await nextMoveId(),
    code: piece._id, pid: piece.pid, vid: piece.vid,
    from, to, note, oid: piece.oid, by, at,
  });
  return mv.toObject();
}

async function syncProductStockFromPieces(pid) {
  const pieces = await Piece.find({ pid }).lean();
  const counts = {};
  pieces.forEach((u) => { if (u.status === 'In stock') counts[u.vid] = (counts[u.vid] || 0) + 1; });
  const prod = await Product.findById(pid);
  if (!prod) return;
  let changed = false;
  prod.variants.forEach((v) => { const n = counts[v.id] || 0; if (v.stock !== n) { v.stock = n; changed = true; } });
  if (changed) await prod.save();
}

/* ---------- movements on an individual piece ---------- */

piecesRouter.post('/:code/move', asyncHandler(async (req, res) => {
  const { to, note = '', by = 'Store', oid } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Missing destination status' });
  const piece = await Piece.findById(req.params.code);
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  await recordMove(piece, to, note, { by, oid });
  await syncProductStockFromPieces(piece.pid);
  res.json(piece.toObject());
}));

piecesRouter.post('/:code/printed', asyncHandler(async (req, res) => {
  const p = await Piece.findByIdAndUpdate(req.params.code, { $set: { printed: true } }, { new: true }).lean();
  if (!p) return res.status(404).json({ error: 'Piece not found' });
  res.json(p);
}));

/* ---------- bulk: mark many printed ---------- */

piecesRouter.post('/bulk/printed', asyncHandler(async (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];
  if (!codes.length) return res.json({ ok: true, updated: 0 });
  const r = await Piece.updateMany({ _id: { $in: codes } }, { $set: { printed: true } });
  res.json({ ok: true, updated: r.modifiedCount });
}));

/* ---------- create new pieces when stock is received ---------- */

piecesRouter.post('/receive', asyncHandler(async (req, res) => {
  const { pid, vid, qty, note = 'Received from the weaver', by = 'Surekha' } = req.body || {};
  const n = Math.max(0, Number(qty) | 0);
  if (!pid || !vid || !n) return res.status(400).json({ error: 'pid, vid and positive qty required' });
  const prod = await Product.findById(pid);
  if (!prod) return res.status(404).json({ error: 'Product not found' });
  const variant = prod.variants.find((v) => v.id === vid);
  if (!variant) return res.status(404).json({ error: 'Variant not found' });
  const now = new Date().toISOString();
  const existing = await Piece.find({ vid }).select('_id').lean();
  // highest existing sequence suffix across all pieces for this variant.
  let seq = existing.reduce((m, p) => {
    const match = /-(\d{3,})$/.exec(p._id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  const created = [];
  for (let k = 0; k < n; k++) {
    seq += 1;
    const code = `${variant.sku}-${String(seq).padStart(3, '0')}`;
    const piece = await Piece.create({ _id: code, pid, vid, status: 'In stock', at: now, received: now, printed: false });
    await Movement.create({ _id: await nextMoveId(), code, pid, vid, from: '—', to: 'In stock', note, oid: null, by, at: now });
    created.push(piece.toObject());
  }
  await syncProductStockFromPieces(pid);
  res.status(201).json({ created });
}));

/* ---------- reconcile: match product variant stock to piece counts (after product editor save) ---------- */

piecesRouter.post('/reconcile/:pid', asyncHandler(async (req, res) => {
  const prod = await Product.findById(req.params.pid);
  if (!prod) return res.status(404).json({ error: 'Product not found' });
  const now = new Date().toISOString();
  for (const v of prod.variants) {
    if (!v.sku) continue;
    const have = await Piece.find({ vid: v.id, status: 'In stock' }).lean();
    const want = Math.max(0, v.stock | 0);
    if (have.length < want) {
      let seq = (await Piece.find({ vid: v.id }).select('_id').lean()).reduce((m, p) => {
        const match = /-(\d{3,})$/.exec(p._id);
        return match ? Math.max(m, Number(match[1])) : m;
      }, 0);
      const needed = want - have.length;
      for (let k = 0; k < needed; k++) {
        seq += 1;
        const code = `${v.sku}-${String(seq).padStart(3, '0')}`;
        await Piece.create({ _id: code, pid: prod._id, vid: v.id, status: 'In stock', at: now, received: now, printed: false });
        await Movement.create({ _id: await nextMoveId(), code, pid: prod._id, vid: v.id, from: '—', to: 'In stock', note: 'Added in the product editor', oid: null, by: 'Surekha', at: now });
      }
    } else if (have.length > want) {
      const extra = have.slice(want);
      for (const u of extra) {
        const piece = await Piece.findById(u._id);
        if (!piece) continue;
        await recordMove(piece, 'Written off', 'Stock reduced in the product editor', { by: 'Surekha' });
      }
    }
  }
  await syncProductStockFromPieces(prod._id);
  res.json({ ok: true });
}));

/* ---------- order lifecycle helpers ---------- */

async function reservePiecesForOrder(order) {
  for (const it of order.items) {
    if (it.piece) { const p = await Piece.findById(it.piece); if (p && p.oid === order._id && ['Reserved', 'Packed'].includes(p.status)) continue; }
    const candidate = await Piece.findOne({ vid: it.vid, status: 'In stock' }).sort({ received: 1 });
    if (!candidate) { it.short = true; continue; }
    candidate.oid = order._id;
    await recordMove(candidate, 'Reserved', `Payment received for ${order._id}`, { by: 'Store' });
    it.piece = candidate._id;
    it.short = false;
    await syncProductStockFromPieces(candidate.pid);
  }
  order.markModified('items');
  await order.save();
}

async function releasePiecesForOrder(order, why = 'Order cancelled') {
  const held = await Piece.find({ oid: order._id, status: { $in: ['Reserved', 'Packed'] } });
  for (const piece of held) {
    piece.oid = null;
    await recordMove(piece, 'In stock', why, { by: 'Store' });
    await syncProductStockFromPieces(piece.pid);
  }
  order.items.forEach((it) => { delete it.piece; });
  order.markModified('items');
  await order.save();
}

piecesRouter.post('/order/:oid/reserve', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.oid);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  await reservePiecesForOrder(o);
  res.json(o.toObject());
}));

piecesRouter.post('/order/:oid/release', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.oid);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  await releasePiecesForOrder(o, req.body?.why || 'Order cancelled');
  res.json(o.toObject());
}));

piecesRouter.post('/order/:oid/ship', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.oid);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const codes = Array.isArray(req.body?.codes) && req.body.codes.length
    ? req.body.codes
    : (await Piece.find({ oid: o._id, status: { $in: ['Reserved', 'Packed'] } }).lean()).map((p) => p._id);
  const at = new Date().toISOString();
  for (const code of codes) {
    const piece = await Piece.findById(code);
    if (!piece) continue;
    if (piece.status !== 'Packed') await recordMove(piece, 'Packed', `Scanned at the packing bench for ${o._id}`, { by: 'Packing bench', at });
    await recordMove(piece, 'Shipped', `Handed to ${o.ship?.courier || 'courier'}${o.ship?.awb ? `, AWB ${o.ship.awb}` : ''}`, { by: 'Packing bench', at });
  }
  res.json({ ok: true, shipped: codes.length });
}));

export { reservePiecesForOrder, releasePiecesForOrder };
