import { Router } from 'express';
import { Coupon } from '../models/Coupon.js';
import { Customer } from '../models/Customer.js';
import { Product } from '../models/Product.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateCoupon } from '../coupons.js';

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

// CPN-01: server-side coupon validation. Replaces the admin's client-only
// discount calculation and will be the single truth for a future storefront
// checkout. Accepts { cid?, items: [{pid, qty, price}] }.
couponsRouter.post('/:code/validate', asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.code);
  if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No items in cart' });
  const customer = req.body?.cid ? await Customer.findById(req.body.cid).lean() : null;
  const pidList = [...new Set(items.map((it) => it.pid).filter(Boolean))];
  const prods = await Product.find({ _id: { $in: pidList } }).lean();
  const products = Object.fromEntries(prods.map((p) => [p._id, p]));
  const result = validateCoupon({ coupon: coupon.toObject(), customer, items, products });
  res.json(result);
}));

// CPN-02: atomic "used" increment, meant to be called after an order with this
// code reaches a paid state. Caller is responsible for idempotency (one call
// per order, keyed off the order _id).
couponsRouter.post('/:code/mark-used', asyncHandler(async (req, res) => {
  const updated = await Coupon.findByIdAndUpdate(
    req.params.code,
    { $inc: { uses: 1 } },
    { new: true },
  ).lean();
  if (!updated) return res.status(404).json({ error: 'Coupon not found' });
  res.json(updated);
}));

couponsRouter.use('/', base);
