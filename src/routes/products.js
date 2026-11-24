import { Router } from 'express';
import { Product } from '../models/Product.js';
import { Piece } from '../models/Piece.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { normaliseWeaveSpelling } from '../validators.js';
import { recordMove, syncProductStockFromPieces } from './pieces.js';

// AUD-01 ties audit rows to the staff email, same convention the rest of
// the routes use.
const byFromReq = (req) => req.user?.email || 'System';

const base = crudRouter(Product, {
  searchFields: ['name', 'weave', 'variants.sku', 'variants.colour'],
  filterKeys: ['cat', 'status', 'zari', 'occasion', 'blousePiece'],
  defaultSort: { created: -1 },
});

export const productsRouter = Router();

// INV-02: variant.stock is derived from Piece documents and is NOT writable through
// the product API. Any incoming write that tries to set it is quietly dropped.
// CAT-05: fold common weave misspellings into the canonical name on every write path.
productsRouter.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
    if (Array.isArray(req.body.variants)) {
      req.body.variants = req.body.variants.map((v) => { const { stock, ...rest } = v; return rest; });
    }
    if (typeof req.body.weave === 'string') req.body.weave = normaliseWeaveSpelling(req.body.weave);
  }
  next();
});

// Bulk status update: PATCH /products/bulk  { ids: [], status: '...' }
productsRouter.patch('/bulk', asyncHandler(async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length || !status) return res.status(400).json({ error: 'ids[] and status required' });
  const result = await Product.updateMany({ _id: { $in: ids } }, { $set: { status } });
  res.json({ matched: result.matchedCount, modified: result.modifiedCount });
}));

// INV-03: cascade-write off Pieces when a Product is deleted. Mounted
// BEFORE `base` so this override wins the DELETE /:id match; the generic
// crudRouter handler would otherwise nuke the Product row and leave every
// Piece pointing at a now-missing pid — which is exactly how the Barcodes
// & stock page ended up showing "Deleted product · In stock" rows that
// inflated inventory counters without ever being sellable. The audit
// trail is preserved: each Piece transition is recorded via `recordMove`
// (same helper the receive / pack / ship flows use) with the deletion as
// the explicit reason, so staff can trace where the units went.
productsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const p = await Product.findById(id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  // Only outstanding pieces need transitioning — Sold / Returned / Written
  // off are already in a terminal state and should keep their current
  // audit history untouched.
  const outstanding = await Piece.find({
    pid: id,
    status: { $in: ['In stock', 'Reserved', 'Packed'] },
  });
  const by = byFromReq(req);
  for (const piece of outstanding) {
    try {
      await recordMove(piece, 'Written off', `Product deleted: ${p.name}`, { by, oid: null });
    } catch (err) {
      // Keep going on single-piece failures so the admin isn't left with a
      // half-cleaned product. The failure surfaces in server logs.
      console.warn(`[products.delete] piece ${piece._id} write-off failed:`, err.message);
    }
  }
  // Keep the denormalised variant.stock counters in sync so reports don't
  // keep showing a phantom "N in stock" on the (now deleted) product.
  try { await syncProductStockFromPieces(id); } catch { /* product row about to vanish */ }
  await Product.deleteOne({ _id: id });
  res.json({ ok: true, deletedProduct: id, piecesWrittenOff: outstanding.length });
}));

productsRouter.use('/', base);
