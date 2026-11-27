import { Router } from 'express';
import { randomBytes } from 'crypto';
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

// Movement _id generator. Uses a process-local counter + an 8-char random
// suffix instead of estimatedDocumentCount() + a 3-char ms-stamp.
//
// The old form collided under two scenarios:
//   1. Tight loops (e.g. 2,000-piece product delete) where estimatedDocumentCount
//      lags behind in-flight inserts, so `n` repeats across sequential calls.
//   2. Two inserts landing in the same millisecond — the last-3-chars-of-ms
//      suffix only has 46 656 values and wraps every 46 seconds.
//
// Random 4-byte (8 hex chars = 4 billion values) suffix makes collisions
// vanishingly unlikely even if the counter base is stale; the per-process
// counter guarantees uniqueness inside a single hot loop without hitting
// the DB at all, so this is also much faster than the old implementation.
let moveCounter = 0;
export async function nextMoveId() {
  moveCounter += 1;
  return `MV${Date.now().toString(36)}${moveCounter.toString(36)}${randomBytes(4).toString('hex')}`;
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

/* ---------- bulk: mark many printed ---------- */
// MUST come before `/:code/printed` — Express resolves routes in
// registration order, and `/:code/printed` would otherwise swallow
// `/bulk/printed` with `code='bulk'` and return a 404.

piecesRouter.post('/bulk/printed', asyncHandler(async (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];
  if (!codes.length) return res.json({ ok: true, updated: 0 });
  const r = await Piece.updateMany({ _id: { $in: codes } }, { $set: { printed: true } });
  res.json({ ok: true, updated: r.modifiedCount });
}));

piecesRouter.post('/:code/printed', asyncHandler(async (req, res) => {
  const p = await Piece.findByIdAndUpdate(req.params.code, { $set: { printed: true } }, { new: true }).lean();
  if (!p) return res.status(404).json({ error: 'Piece not found' });
  res.json(p);
}));

/* ---------- bulk receive: CSV-driven stock receipts ---------- */
// Rows are validated and executed in order; a failed row (bad SKU,
// non-positive qty) is skipped and reported back so the admin can
// fix those lines and re-upload only the stragglers. Partial success
// is intentional — a 400 would force the admin to retry even the
// rows that landed fine.
piecesRouter.post('/receive/bulk', asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const by = req.user?.email || 'System';
  // Pre-fetch every product + build a fast SKU → {prod, variant} index.
  const prods = await Product.find({}).lean();
  const bySku = new Map();
  for (const p of prods) {
    for (const v of (p.variants || [])) {
      if (v.sku) bySku.set(String(v.sku).toUpperCase(), { pid: p._id, vid: v.id, sku: v.sku });
    }
  }
  const results = [];
  const seqCache = new Map(); // vid → current max suffix
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const sku = String(r.sku || '').trim().toUpperCase();
    const qty = Math.max(0, Number(r.qty) | 0);
    const note = String(r.note || '').trim() || 'Received from the weaver (bulk)';
    const receivedRaw = String(r.received_on || '').trim();
    const receivedDate = receivedRaw ? new Date(receivedRaw) : new Date();
    if (!sku) { results.push({ line: i + 1, ok: false, error: 'sku is empty' }); continue; }
    if (!qty) { results.push({ line: i + 1, sku, ok: false, error: 'qty must be a positive integer' }); continue; }
    if (Number.isNaN(receivedDate.getTime())) { results.push({ line: i + 1, sku, ok: false, error: 'received_on is not a valid date' }); continue; }
    const hit = bySku.get(sku);
    if (!hit) { results.push({ line: i + 1, sku, ok: false, error: 'unknown sku' }); continue; }
    const { pid, vid } = hit;
    // Compute the next piece-code suffix per variant. Cache across rows
    // so two rows for the same SKU keep counting upward.
    let seq = seqCache.get(vid);
    if (seq === undefined) {
      const existing = await Piece.find({ vid }).select('_id').lean();
      seq = existing.reduce((m, p) => {
        const match = /-(\d{3,})$/.exec(p._id);
        return match ? Math.max(m, Number(match[1])) : m;
      }, 0);
    }
    const at = new Date().toISOString();
    const received = receivedDate.toISOString();
    const createdCodes = [];
    for (let k = 0; k < qty; k += 1) {
      seq += 1;
      const code = `${hit.sku}-${String(seq).padStart(3, '0')}`;
      await Piece.create({ _id: code, pid, vid, status: 'In stock', at, received, printed: false });
      await Movement.create({ _id: await nextMoveId(), code, pid, vid, from: '—', to: 'In stock', note, oid: null, by, at });
      createdCodes.push(code);
    }
    seqCache.set(vid, seq);
    await syncProductStockFromPieces(pid);
    results.push({ line: i + 1, sku, ok: true, created: createdCodes.length, codes: createdCodes });
  }
  const totals = results.reduce((a, r) => {
    if (r.ok) { a.ok += 1; a.pieces += r.created; } else { a.failed += 1; }
    return a;
  }, { ok: 0, failed: 0, pieces: 0 });
  res.status(201).json({ results, totals });
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

/* ---------- cleanup: orphan pieces + stale movements ---------- */

// Hard-deletes pieces that can no longer be traced back to a live product
// or variant, plus every Movement row that referenced them. Used to tidy
// up after a failed bulk import, a direct DB edit, or legacy schema drift.
// Audit-preserving by default — won't touch pieces whose parent product +
// variant both resolve, even if the piece sits in a terminal state like
// 'Sold' or 'Written off'.
//
// Query params:
//   dryRun=1   → report what would be removed without deleting. Default.
//   dryRun=0   → actually delete. Required to make changes.
//
// Response:
//   { orphanPids: string[], orphanVids: string[], pieceCount, movementCount, dryRun }
piecesRouter.post('/admin/cleanup-orphans', asyncHandler(async (req, res) => {
  const dryRun = req.query.dryRun !== '0'; // default true — safe
  // Pull every pid/vid we currently know about. Doing one bulk scan beats
  // 5,000 findById round-trips when the pieces collection is large.
  const products = await Product.find({}).select('_id variants.id').lean();
  const livePids = new Set(products.map((p) => p._id));
  const liveVidsByPid = new Map(
    products.map((p) => [p._id, new Set((p.variants || []).map((v) => v.id))]),
  );

  // Candidates in two buckets: product gone, or product exists but variant gone.
  const pieces = await Piece.find({}).select('_id pid vid').lean();
  const orphanPidPieces = [];
  const orphanVidPieces = [];
  const orphanPidSet = new Set();
  const orphanVidSet = new Set();
  for (const u of pieces) {
    if (!livePids.has(u.pid)) {
      orphanPidPieces.push(u._id);
      orphanPidSet.add(u.pid);
      continue;
    }
    const variants = liveVidsByPid.get(u.pid);
    if (variants && !variants.has(u.vid)) {
      orphanVidPieces.push(u._id);
      orphanVidSet.add(u.vid);
    }
  }
  const allOrphanCodes = [...orphanPidPieces, ...orphanVidPieces];

  const summary = {
    dryRun,
    orphanPids: [...orphanPidSet],
    orphanVids: [...orphanVidSet],
    pieceCount: allOrphanCodes.length,
    movementCount: 0,
  };

  if (allOrphanCodes.length === 0) return res.json(summary);

  // Count movements before doing anything — same count whether dry-run or real.
  summary.movementCount = await Movement.countDocuments({ code: { $in: allOrphanCodes } });

  if (!dryRun) {
    // Delete movements first so the audit trail doesn't get briefly broken
    // in the other direction (dangling Movement whose piece vanished).
    await Movement.deleteMany({ code: { $in: allOrphanCodes } });
    await Piece.deleteMany({ _id: { $in: allOrphanCodes } });
  }

  res.json(summary);
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
    // Reservation strategy (INV-03):
    //   1) The line carries a vid (explicit colour pick) → claim a piece
    //      with that EXACT vid. No silent cross-colour substitution — a
    //      shopper who ordered Red must receive Red. If there's no piece
    //      of that vid available, the line lands in `shortages` and the
    //      order fails with a readable 409.
    //   2) The line carries no vid (admin's manual order that didn't
    //      pick a specific SKU) → fall back to any in-stock piece of the
    //      same product and record which variant actually got reserved.
    //
    // Previously the no-vid fallback also ran when the requested vid was
    // out of stock, silently shipping the wrong colour. The storefront's
    // addToCart always passes the chosen variant, so the strict-vid path
    // matches customer intent.
    let claimed = null;
    if (it.vid) {
      claimed = await Piece.findOneAndUpdate(
        { vid: it.vid, status: 'In stock', oid: null },
        { $set: { status: 'Reserved', oid: order._id, at } },
        { new: true, sort: { received: 1 } },
      );
    } else if (it.pid) {
      claimed = await Piece.findOneAndUpdate(
        { pid: it.pid, status: 'In stock', oid: null },
        { $set: { status: 'Reserved', oid: order._id, at } },
        { new: true, sort: { received: 1 } },
      );
      if (claimed) it.vid = claimed.vid;
    }
    if (!claimed) { shortages.push({ pid: it.pid, vid: it.vid, qty: it.qty || 1 }); continue; }
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
      // Storefront orders go through a courier; in-store / phone /
      // WhatsApp / Instagram orders are handed straight to the buyer
      // and the "courier" copy is misleading in the audit log.
      note: String(order.source || '') === 'Storefront'
        ? `Handed to ${order.ship?.courier || 'courier'}${order.ship?.awb ? `, AWB ${order.ship.awb}` : ''}`
        : `Delivered in-store (${order.source || 'Manual entry'})`,
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

export { reservePiecesForOrder, releasePiecesForOrder, shipPiecesForOrder, recordMove, syncProductStockFromPieces };
