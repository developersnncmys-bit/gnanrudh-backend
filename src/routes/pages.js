import { Router } from 'express';
import { CmsPage } from '../models/CmsPage.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const pagesRouter = Router();

pagesRouter.get('/', asyncHandler(async (req, res) => {
  const items = await CmsPage.find().sort({ name: 1 }).lean();
  res.json({ items, total: items.length });
}));

pagesRouter.get('/:name', asyncHandler(async (req, res) => {
  const p = await CmsPage.findOne({ name: req.params.name }).lean();
  if (!p) return res.status(404).json({ error: 'Page not found' });
  res.json(p);
}));

pagesRouter.put('/:name', asyncHandler(async (req, res) => {
  const body = { ...req.body, name: req.params.name, updated: new Date().toISOString().slice(0, 10) };
  const p = await CmsPage.findOneAndUpdate({ name: req.params.name }, body, { new: true, upsert: true }).lean();
  res.json(p);
}));
