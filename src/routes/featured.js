import { Router } from 'express';
import { getSingleton, setSingleton } from '../models/Singleton.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const featuredRouter = Router();

// GET /featured → { ids: [...] }
featuredRouter.get('/', asyncHandler(async (req, res) => {
  const data = await getSingleton('featured', { ids: [] });
  res.json(data);
}));

// PUT /featured  { ids: [...] }
featuredRouter.put('/', asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  await setSingleton('featured', { ids });
  res.json({ ids });
}));
