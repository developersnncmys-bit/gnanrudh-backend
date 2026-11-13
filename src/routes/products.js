import { Router } from 'express';
import { Product } from '../models/Product.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const base = crudRouter(Product, {
  searchFields: ['name', 'weave', 'variants.sku', 'variants.colour'],
  filterKeys: ['cat', 'status', 'zari', 'occasion', 'blousePiece'],
  defaultSort: { created: -1 },
});

export const productsRouter = Router();

// INV-02: variant.stock is derived from Piece documents and is NOT writable through
// the product API. Any incoming write that tries to set it is quietly dropped.
productsRouter.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && Array.isArray(req.body?.variants)) {
    req.body.variants = req.body.variants.map((v) => { const { stock, ...rest } = v; return rest; });
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

productsRouter.use('/', base);
