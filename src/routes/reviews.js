import { Router } from 'express';
import { Review } from '../models/Review.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const base = crudRouter(Review, {
  searchFields: ['text'],
  filterKeys: ['status', 'pid', 'cid', 'rating'],
  defaultSort: { at: -1 },
});

export const reviewsRouter = Router();

reviewsRouter.post('/:id/approve', asyncHandler(async (req, res) => {
  const r = await Review.findByIdAndUpdate(req.params.id, { $set: { status: 'Published' } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Review not found' });
  res.json(r);
}));
reviewsRouter.post('/:id/reject', asyncHandler(async (req, res) => {
  const r = await Review.findByIdAndUpdate(req.params.id, { $set: { status: 'Rejected' } }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Review not found' });
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
  await Review.updateMany({ _id: { $in: ids } }, { $set: { status: target } });
  res.json({ ok: true });
}));

reviewsRouter.use('/', base);
