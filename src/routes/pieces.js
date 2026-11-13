import { Router } from 'express';
import { Piece } from '../models/Piece.js';
import { Movement } from '../models/Movement.js';
import { Product } from '../models/Product.js';
import { Order } from '../models/Order.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { parsePaging } from './_crud.js';

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
  // PERF-03: pagination. No more "return every piece in one request".
  const { limit, skip } = parsePaging(req.query);
  const [items, total] = await Promise.all([
    Piece.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(),
    Piece.countDocuments(filter),
  ]);
  res.json({ items, total, limit, skip });
}));

piecesRouter.get('/:code', asyncHandler(async (req, res) => {
  const p = await Piece.findById(req.params.code).lean();
  if (!p) return res.status(404).json({ error: 'Piece not found' });
  res.json(p);
}));

movementsRouter.get('/', asyncHandler(async (req, res) => {
  // PERF-03: paginate movements too (was uncapped hidden behind limit=5000).
  const { limit, skip } = parsePaging(req.query);
  const [items, total] = await Promise.all([
    Movement.find({}).sort({ at: -1 }).skip(skip).limit(limit).lean(),
    Movement.countDocuments({}),
  ]);
  res.json({ items, total, limit, skip });
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
  const { to, note = '', oid } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Missing destination status' });
  const piece = await Piece.findById(req.params.code);
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  // AUD-01: `by` is pinned to the authenticated user; any client-supplied `by` is ignored.
  await recordMove(piece, to, note, { by: req.user?.email || 'System', oid });
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
  const { pid, vid, qty, note = 'Received from the weaver' } = req.body || {};
  const by = req.user?.email || 'System'; // AUD-01
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
  const by = req.user?.email || 'System'; // AUD-01
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
        await Movement.create({ _id: await nextMoveId(), code, pid: prod._id, vid: v.id, from: '—', to: 'In stock', note: 'Added in the product editor', oid: null, by, at: now });
      }
    } else if (have.length > want) {
      const extra = have.slice(want);
      for (const u of extra) {
        const piece = await Piece.findById(u._id);
        if (!piece) continue;
        await recordMove(piece, 'Written off', 'Stock reduced in the product editor', { by });
      }
    }
  }
  await syncProductStockFromPieces(prod._id);
  res.json({ ok: true });
}));

/* ---------- order lifecycle helpers ---------- */

// INV-01: atomic piece reservation. For each line:
//   findOneAndUpdate({vid, status:'In stock', oid:null}, $set:{status:'Reserved', oid})
// guarantees only one request wins a given piece, even under 200 concurrent buyers
// (QA load/oversell-race.js). On failure, every piece claimed by this call is
// rolled back and a 409-shaped error is thrown.
//
// `by` is the audit field for the Movement row (AUD-01). It must come from the
// authenticated request; callers that invoke outside a request (webhooks,
// background tasks) pass 'System' explicitly.
async function reservePiecesForOrder(order, { by = 'System' } = {}) {
  const reserved = [];
  const shortages = [];
  for (const it of order.items) {
    if (it.piece) {
      const existing = await Piece.findById(it.piece);
      if (existing && existing.oid === order._id && ['Reserved', 'Packed'].includes(existing.status)) continue;
    }
    const at = new Date().toISOString();
    const claimed = await Piece.findOneAndUpdate(
      { vid: it.vid, status: 'In stock', oid: null },
      { $set: { status: 'Reserved', oid: order._id, at } },
      { new: true, sort: { received: 1 } },
    );
    if (!claimed) { shortages.push({ vid: it.vid, qty: it.qty || 1 }); continue; }
    await Movement.create({
      _id: await nextMoveId(),
      code: claimed._id, pid: claimed.pid, vid: claimed.vid,
      from: 'In stock', to: 'Reserved',
      note: `Reserved for ${order._id}`,
      oid: order._id, by, at,
    });
    await syncProductStockFromPieces(claimed.pid);
    it.piece = claimed._id;
    it.short = false;
    reserved.push(claimed._id);
  }
  order.markModified('items');
  await order.save();
  if (shortages.length) {
    // Roll back every piece we claimed in this call so the order's left in a clean state.
    for (const code of reserved) {
      const rolled = await Piece.findOneAndUpdate(
        { _id: code, oid: order._id, status: 'Reserved' },
        { $set: { status: 'In stock', oid: null, at: new Date().toISOString() } },
        { new: true },
      );
      if (rolled) await syncProductStockFromPieces(rolled.pid);
    }
    const err = new Error('Not enough pieces in stock to fulfil order');
    err.status = 409;
    err.details = shortages;
    throw err;
  }
}

async function releasePiecesForOrder(order, why = 'Order cancelled', { by = 'System' } = {}) {
  // Atomic bulk release. Keeps only pieces held *by this order* from being
  // returned to stock twice if the endpoint is retried.
  const held = await Piece.find({ oid: order._id, status: { $in: ['Reserved', 'Packed'] } });
  for (const piece of held) {
    const at = new Date().toISOString();
    const updated = await Piece.findOneAndUpdate(
      { _id: piece._id, oid: order._id, status: { $in: ['Reserved', 'Packed'] } },
      { $set: { status: 'In stock', oid: null, at } },
      { new: true },
    );
    if (!updated) continue;
    await Movement.create({
      _id: await nextMoveId(),
      code: updated._id, pid: updated.pid, vid: updated.vid,
      from: piece.status, to: 'In stock',
      note: why,
      oid: null, by, at,
    });
    await syncProductStockFromPieces(updated.pid);
  }
  order.items.forEach((it) => { delete it.piece; });
  order.markModified('items');
  await order.save();
}

// INV-01: packing bench marks the pieces for an order as Sold. Also called from
// orders.js /:id/ship so the order status and piece lifecycle stay in sync.
async function shipPiecesForOrder(order, { codes, by = 'System' } = {}) {
  const toShip = codes && codes.length
    ? await Piece.find({ _id: { $in: codes }, oid: order._id }).lean()
    : await Piece.find({ oid: order._id, status: { $in: ['Reserved', 'Packed'] } }).lean();
  const at = new Date().toISOString();
  for (const p of toShip) {
    if (p.status !== 'Packed') {
      const up = await Piece.findOneAndUpdate(
        { _id: p._id, oid: order._id, status: 'Reserved' },
        { $set: { status: 'Packed', at } },
        { new: true },
      );
      if (up) await Movement.create({
        _id: await nextMoveId(),
        code: up._id, pid: up.pid, vid: up.vid,
        from: 'Reserved', to: 'Packed',
        note: `Scanned at the packing bench for ${order._id}`,
        oid: order._id, by, at,
      });
    }
    const sold = await Piece.findOneAndUpdate(
      { _id: p._id, oid: order._id, status: { $in: ['Reserved', 'Packed'] } },
      { $set: { status: 'Sold', at } },
      { new: true },
    );
    if (sold) await Movement.create({
      _id: await nextMoveId(),
      code: sold._id, pid: sold.pid, vid: sold.vid,
      from: 'Packed', to: 'Sold',
      note: `Handed to ${order.ship?.courier || 'courier'}${order.ship?.awb ? `, AWB ${order.ship.awb}` : ''}`,
      oid: order._id, by, at,
    });
  }
  return toShip.length;
}

// AUD-01: `by` on every Movement comes from the authenticated user, never the client body.
const byFromReq = (req) => req.user?.email || 'System';

piecesRouter.post('/order/:oid/reserve', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.oid);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  try {
    await reservePiecesForOrder(o, { by: byFromReq(req) });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message, details: e.details });
    throw e;
  }
  res.json(o.toObject());
}));

piecesRouter.post('/order/:oid/release', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.oid);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  await releasePiecesForOrder(o, req.body?.why || 'Order cancelled', { by: byFromReq(req) });
  res.json(o.toObject());
}));

piecesRouter.post('/order/:oid/ship', asyncHandler(async (req, res) => {
  const o = await Order.findById(req.params.oid);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const codes = Array.isArray(req.body?.codes) ? req.body.codes : null;
  const shipped = await shipPiecesForOrder(o, { codes, by: byFromReq(req) });
  res.json({ ok: true, shipped });
}));

export { reservePiecesForOrder, releasePiecesForOrder, shipPiecesForOrder };
