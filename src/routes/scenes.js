import { Router } from 'express';
import { Scene } from '../models/Scene.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const scenesRouter = Router();

scenesRouter.get('/', asyncHandler(async (req, res) => {
  const items = await Scene.find().sort({ order: 1 }).lean();
  res.json({ items, total: items.length });
}));

// Replace all scenes atomically. Body: [{ order, name, line }, ...]
scenesRouter.put('/', asyncHandler(async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Body must be an array' });
  await Scene.deleteMany({});
  const items = await Scene.insertMany(req.body);
  res.json({ items, total: items.length });
}));

scenesRouter.patch('/:order', asyncHandler(async (req, res) => {
  const s = await Scene.findOneAndUpdate(
    { order: Number(req.params.order) },
    { $set: req.body },
    { new: true, upsert: true },
  ).lean();
  res.json(s);
}));
