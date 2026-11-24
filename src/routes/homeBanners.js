import { Router } from 'express';
import { HomeBanner } from '../models/HomeBanner.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// Admin router for the homepage banner. Only the Bridal Edit strip is
// admin-controlled; the Explore Collections strip was reverted to a
// static component (see CraftStory.tsx vs PromoBanner.tsx). The slot
// enum below hard-rejects anything other than `bridal` so a tampered
// request can't write a ghost row for a slot that nothing reads.
// Keyed by `slot` instead of Mongo _id so the admin UI can PATCH by
// slot name directly — mirrors how the frontend consumes it. Public
// read is exposed separately in routes/public.js.
export const homeBannersRouter = Router();

// GET /api/home-banners — list both rows for the admin screen.
homeBannersRouter.get('/', asyncHandler(async (req, res) => {
  const items = await HomeBanner.find({}).sort({ slot: 1 }).lean();
  res.json({ items });
}));

// PATCH /api/home-banners/:slot — update one banner by slot.
// Upserts so a slot can be edited even if it was never seeded.
homeBannersRouter.patch('/:slot', asyncHandler(async (req, res) => {
  const slot = String(req.params.slot || '').toLowerCase();
  if (slot !== 'bridal') {
    return res.status(400).json({ error: 'Unknown banner slot' });
  }
  const patch = {};
  for (const key of ['image', 'eyebrow', 'title', 'description']) {
    if (typeof req.body?.[key] === 'string') patch[key] = req.body[key].trim();
  }
  const doc = await HomeBanner.findOneAndUpdate(
    { slot },
    { $set: { ...patch, slot } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  res.json(doc);
}));
