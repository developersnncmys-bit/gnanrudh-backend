import { Router } from 'express';
import { Coupon } from '../models/Coupon.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const base = crudRouter(Coupon, {
  searchFields: ['_id', 'scope'],
  filterKeys: ['on', 'kind'],
  defaultSort: { createdAt: -1 },
});

export const couponsRouter = Router();

// Toggle on/off
couponsRouter.post('/:id/toggle', asyncHandler(async (req, res) => {
  const c = await Coupon.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Coupon not found' });
  c.on = !c.on;
  await c.save();
  res.json(c.toObject());
}));

couponsRouter.use('/', base);
