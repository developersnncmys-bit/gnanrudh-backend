import { Router } from 'express';
import { Review } from '../models/Review.js';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const base = crudRouter(Review, {
  searchFields: ['text'],
  filterKeys: ['status', 'pid', 'cid', 'rating', 'verified'],
  defaultSort: { at: -1 },
});

export const reviewsRouter = Router();

// DATA-03/REV-01: recompute Product.rating + Product.reviews + verifiedReviews from
// the Published reviews. Called whenever a review moderation decision changes.
async function recomputeProductRating(pid) {
  if (!pid) return;
  const published = await Review.find({ pid, status: 'Published' }).lean();
  const count = published.length;
  const verifiedCount = published.filter((r) => r.verified).length;
  const avg = count ? (published.reduce((a, r) => a + (r.rating || 0), 0) / count) : 0;
  await Product.updateOne({ _id: pid }, { $set: {
    reviews: count,
    verifiedReviews: verifiedCount,
    rating: avg ? avg.toFixed(1) : '0',
  } });
}

// REV-01: create a review only against a delivered order line by that customer.
// Overrides crudRouter POST so the verified flag is set from the actual order.
reviewsRouter.post('/', asyncHandler(async (req, res) => {
  const { pid, cid, oid, rating, text } = req.body || {};
  if (!pid || !cid || !oid || !rating) return res.status(400).json({ error: 'pid, cid, oid and rating are required' });
  const order = await Order.findById(oid).lean();
  if (!order || order.cid !== cid) return res.status(400).json({ error: 'Order does not belong to this customer' });
  if (order.status !== 'Delivered') return res.status(400).json({ error: 'Review only allowed after delivery' });
  const boughtLine = order.items.some((it) => it.pid === pid);
  if (!boughtLine) return res.status(400).json({ error: 'This product was not in the order' });
  const _id = req.body._id || `R${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const doc = await Review.create({
    _id, pid, cid, oid,
    verified: true,
    rating: Number(rating),
    text: String(text || ''),
    at: new Date().toISOString(),
    status: 'Pending',
  });
  res.status(201).json(doc.toObject());
}));

reviewsRouter.post('/:id/approve', asyncHandler(async (req, res) => {
  const r = await Review.findByIdAndUpdate(req.params.id, { $set: { status: 'Published' } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Review not found' });
  await recomputeProductRating(r.pid); // DATA-03
  res.json(r);
}));
reviewsRouter.post('/:id/reject', asyncHandler(async (req, res) => {
  const r = await Review.findByIdAndUpdate(req.params.id, { $set: { status: 'Rejected' } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Review not found' });
  await recomputeProductRating(r.pid); // DATA-03 — removes a previously-published review's contribution
  res.json(r);
}));
reviewsRouter.post('/:id/reply', asyncHandler(async (req, res) => {
  const { reply } = req.body;
  const r = await Review.findByIdAndUpdate(req.params.id, { $set: { reply: String(reply || '') } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Review not found' });
  res.json(r);
}));
reviewsRouter.post('/bulk/:action', asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const target = { approve: 'Published', reject: 'Rejected' }[req.params.action];
  if (!target || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Invalid request' });
  const affected = await Review.find({ _id: { $in: ids } }).select('pid').lean();
  await Review.updateMany({ _id: { $in: ids } }, { $set: { status: target } });
  const pids = [...new Set(affected.map((r) => r.pid).filter(Boolean))];
  for (const pid of pids) await recomputeProductRating(pid); // DATA-03
  res.json({ ok: true });
}));

reviewsRouter.use('/', base);
